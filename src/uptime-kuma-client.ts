import { io, Socket } from 'socket.io-client';
import fuzzysort from 'fuzzysort';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import type {
  MonitorBaseWithExtendedData,
  MonitorWithExtendedData,
  MonitorRawData,
  ApiResponse,
  LoginResponse,
  MonitorList,
  MonitorSummary,
  Heartbeat,
  HeartbeatList,
  UptimeBucket,
  GetSettingsResponse,
  Settings,
  Notification,
  Maintenance,
  StatusPage,
  Incident,
  DockerHost,
  KumaProxy,
  RemoteBrowser,
  APIKey,
} from './types/index.js';
import { normaliseMsg } from './utils/normalize-msg.js';

/**
 * How long a post-write read-back waits for the server's acknowledgement before giving up.
 * Generous — this is a single indexed row and the only thing being guarded against is an
 * acknowledgement that never comes at all.
 */
const FETCH_MONITOR_TIMEOUT_MS = 10_000;

/**
 * How long any other call waits for the server's acknowledgement. Longer than the read-back
 * above because it also covers writes that make Uptime Kuma do real work before it answers
 * (restarting a monitor, reaching a docker daemon).
 */
const ACK_TIMEOUT_MS = 30_000;

/**
 * Every event Uptime Kuma pushes that a cache is filled from. Listed once so that the
 * listeners added at login and the ones removed again cannot drift apart.
 */
const DATA_EVENTS = [
  'monitorList',
  'updateMonitorIntoList',
  'deleteMonitorFromList',
  'heartbeatList',
  'heartbeat',
  'uptime',
  'avgPing',
  'notificationList',
  'tagList',
  'maintenanceList',
  'statusPageList',
  'dockerHostList',
  'proxyList',
  'remoteBrowserList',
  'apiKeyList',
] as const;

/** A proxy row as Uptime Kuma pushes it (snake_case, 0/1 flags), in the shape the tools return. */
function normalizeProxy(row: Record<string, unknown>): KumaProxy {
  return {
    id: Number(row.id),
    protocol: String(row.protocol ?? ''),
    host: String(row.host ?? ''),
    port: Number(row.port),
    auth: !!row.auth,
    username: (row.username as string | null | undefined) ?? null,
    password: (row.password as string | null | undefined) ?? null,
    default: !!row.default,
    createdDate:
      (row.created_date as string | null | undefined) ?? (row.createdDate as string | null | undefined) ?? null,
  };
}

/** The heartbeat statuses the summary can be filtered by, under the names Uptime Kuma shows. */
const STATUS_BY_NAME: Record<string, number> = { down: 0, up: 1, pending: 2, maintenance: 3 };

/**
 * Reads a `status` filter: comma-separated numbers or names, in any case. Blank means no
 * filter.
 *
 * Throws on anything else. Dropping an entry it did not recognise left a filter of nothing,
 * so "what is down?" asked as `status: "offline"` was answered with every monitor, and
 * nothing in the answer said the filter had been ignored.
 */
function parseStatusFilter(status: string | undefined): number[] {
  const statuses: number[] = [];
  for (const raw of (status ?? '').split(',')) {
    const token = raw.trim().toLowerCase();
    if (token === '') continue;
    if (token in STATUS_BY_NAME) {
      statuses.push(STATUS_BY_NAME[token]);
    } else if (/^[0-3]$/.test(token)) {
      statuses.push(Number(token));
    } else {
      throw new Error(
        `Unrecognised status "${raw.trim()}". Use 0 or down, 1 or up, 2 or pending, 3 or maintenance, ` +
          'comma-separated for more than one.'
      );
    }
  }
  return statuses;
}

/**
 * Helper function to filter a MonitorWithExtendedData down to MonitorBaseWithExtendedData
 * Strips out type-specific fields while keeping common fields and runtime data
 */
function filterToBaseWithExtendedData(monitor: MonitorWithExtendedData): MonitorBaseWithExtendedData {
  // Extract all MonitorBase fields plus runtime data
  const {
    id,
    name,
    description,
    type,
    active,
    parent,
    weight,
    interval,
    retryInterval,
    resendInterval,
    timeout,
    maxretries,
    upsideDown,
    accepted_statuscodes,
    notificationIDList,
    tags,
    user_id,
    maintenance,
    path,
    pathName,
    childrenIDs,
    forceInactive,
    includeSensitiveData,
    uptime,
    avgPing,
  } = monitor;

  return {
    id,
    name,
    description,
    type,
    active,
    parent,
    weight,
    interval,
    retryInterval,
    resendInterval,
    timeout,
    maxretries,
    upsideDown,
    accepted_statuscodes,
    notificationIDList,
    tags,
    user_id,
    maintenance,
    path,
    pathName,
    childrenIDs,
    forceInactive,
    includeSensitiveData,
    uptime,
    avgPing,
  } as MonitorBaseWithExtendedData;
}

/** The filters listMonitors and getMonitorSummary share. */
interface MonitorFilters {
  keywords?: string;
  type?: string;
  active?: boolean;
  maintenance?: boolean;
  tags?: string;
  parentId?: number | null;
}

/** A fuzzy keyword match has to score above this (0 = no match, 1 = perfect match). */
const KEYWORD_MATCH_THRESHOLD = 0.3;

/** Splits a comma-separated filter into its non-empty entries. */
const splitList = (value: string | undefined): string[] =>
  value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

/**
 * Does `monitor` satisfy a `parentId` filter? Direct children only, matching Uptime Kuma's
 * own `parent` column — a grandchild belongs to its immediate group, not to the one above it.
 *
 * The distinction this exists to protect: `undefined` means "no parent filter" while `null` is
 * a real, requestable value meaning "top level only". A truthiness check (`if (parentId)`)
 * conflates them AND silently drops group 0, so the branch is written out longhand.
 */
function matchesParentFilter(monitor: { parent?: number | null }, parentId: number | null | undefined): boolean {
  if (parentId === undefined) return true;
  const wanted = parentId === null ? null : Number(parentId);
  const actual = monitor.parent === null || monitor.parent === undefined ? null : Number(monitor.parent);
  return actual === wanted;
}

/**
 * Builds the test a monitor has to pass to be listed. A monitor must pass every filter given.
 *
 * getMonitorList and getMonitorSummary each used to carry their own copy of this, and a filter
 * added to one did not reach the other (the parent filter, issue #65).
 */
function monitorFilter(filters: MonitorFilters | undefined): (monitor: MonitorRawData) => boolean {
  const keywords = filters?.keywords ? filters.keywords.trim().split(/\s+/) : [];
  const types = splitList(filters?.type);
  // Each tag filter is 'name' or 'name=value', compared without regard to case.
  const tags = splitList(filters?.tags).map((entry) => {
    const [name, value] = entry.split('=').map((part) => part.trim().toLowerCase());
    return { name, value };
  });

  return (monitor) => {
    if (!matchesParentFilter(monitor, filters?.parentId)) return false;

    const pathName = monitor.pathName || '';
    const matchesEveryKeyword = keywords.every((keyword) => {
      const match = fuzzysort.single(keyword, pathName);
      return match !== null && match.score > KEYWORD_MATCH_THRESHOLD;
    });
    if (!matchesEveryKeyword) return false;

    if (types.length > 0 && !types.includes(monitor.type)) return false;
    if (filters?.active !== undefined && monitor.active !== filters.active) return false;
    if (filters?.maintenance !== undefined && monitor.maintenance !== filters.maintenance) return false;

    const monitorTags = monitor.tags || [];
    return tags.every((wanted) =>
      monitorTags.some(
        (tag) =>
          tag.name.toLowerCase() === wanted.name &&
          // With no value in the filter the name alone decides.
          (wanted.value === undefined || (tag.value?.toLowerCase() || '') === wanted.value)
      )
    );
  };
}

/**
 * Uptime Kuma Socket.io API Client
 */
export class UptimeKumaClient {
  private socket: Socket | null = null;
  private url: string;
  private extraHeaders?: Record<string, string>;
  private monitorListCache: { [monitorID: string]: MonitorRawData } = {};
  private heartbeatListCache: HeartbeatList<true> = {};
  private uptimeCache: { [monitorID: string]: { [periodKey: string]: number } } = {};
  private avgPingCache: { [monitorID: string]: number | null } = {};
  private notificationListCache: { [id: string]: Notification } = {};
  private tagListCache: Array<{ id: number; name: string; color: string }> = [];
  private maintenanceListCache: { [id: string]: Maintenance } = {};
  private statusPageListCache: { [slug: string]: StatusPage } = {};
  private dockerHostListCache: DockerHost[] = [];
  private proxyListCache: KumaProxy[] = [];
  private remoteBrowserListCache: RemoteBrowser[] = [];
  private apiKeyListCache: APIKey[] = [];
  private server?: { sendLoggingMessage: (params: { level: LoggingLevel; data: unknown }) => Promise<void> };
  private shouldLog: (level: LoggingLevel) => boolean;
  private loginCredentials: {
    username: string | undefined;
    password: string | undefined;
    token?: string;
    jwtToken?: string;
  } | null = null;

  /**
   * Invoked whenever the authenticated session is known to be gone — the socket dropped, or
   * a re-auth on reconnect was refused. The server layer uses this to clear its
   * `isAuthenticated` flag so the next tool call re-authenticates instead of failing.
   */
  public onAuthLost: ((reason: string) => void) | null = null;

  constructor(
    url: string,
    server?: { sendLoggingMessage: (params: { level: LoggingLevel; data: unknown }) => Promise<void> },
    shouldLog?: (level: LoggingLevel) => boolean,
    extraHeaders?: Record<string, string>
  ) {
    this.url = url;
    this.server = server;
    this.shouldLog = shouldLog || (() => true); // Default: log everything
    this.extraHeaders = extraHeaders;
  }

  /**
   * Helper to safely log messages - only logs if server is available, connected, and level is enabled
   */
  private safeLog(level: LoggingLevel, data: string): void {
    if (!this.server || !this.shouldLog(level)) return;
    try {
      // Logging must never break the caller: the server may not be connected to a transport
      // yet, or may have just gone away.
      this.server.sendLoggingMessage({ level, data }).catch(() => {});
    } catch {
      // as above, for a sink that throws instead of rejecting
    }
  }

  /**
   * Emit an event and bound the wait for its acknowledgement.
   *
   * A disconnect between the emit and the acknowledgement leaves a socket.io callback that is
   * never invoked, and a promise waiting on it never settles: the tool call hangs, and for a
   * login so does every later call, since they all share the one in-flight login.
   *
   * When the answer does not come, the callback is given the failure in the shape Uptime Kuma
   * itself uses (`{ ok: false, msg }`), so each caller's existing error path handles it.
   */
  private emitAck<R>(
    event: string,
    args: unknown[],
    ack: (response: R) => void,
    timeout: { ms: number; msg: string } = {
      ms: ACK_TIMEOUT_MS,
      msg:
        `No response from Uptime Kuma to "${event}" within ${ACK_TIMEOUT_MS / 1000} seconds; the connection may ` +
        'have dropped. If this was a change, it may or may not have been applied, so check before trying again.',
    }
  ): void {
    const socket = this.socket;
    if (!socket) return;

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      ack({ ok: false, msg: timeout.msg } as R);
    }, timeout.ms);

    socket.emit(event, ...args, (response: R) => {
      // An answer that arrives after the wait was given up has nobody left to hear it.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ack(response);
    });
  }

  /**
   * Send one request to Uptime Kuma and wait for its answer: the shape nearly every call here
   * has. Rejects when there is no connection, when the server answers `ok: false` (with its
   * message, or `failure` when it gives none) and when it does not answer in time.
   *
   * `timeout` is for the read-backs, which wait a shorter time and say what they were reading.
   */
  private request<T extends object = object>(
    event: string,
    args: unknown[],
    failure: string,
    timeout?: { ms: number; msg: string }
  ): Promise<ApiResponse & T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.emitAck<ApiResponse & T>(
        event,
        args,
        (response) => {
          if (response && response.ok) {
            resolve(response);
          } else {
            reject(new Error((response && response.msg) || failure));
          }
        },
        timeout
      );
    });
  }

  /**
   * A request that reads something back from the database after a write. Bounded more tightly
   * than a write: this sits on the success path of every monitor and maintenance write, so a
   * slow answer is worth waiting for and an answer that never comes is not.
   */
  private readBack<T extends object>(event: string, args: unknown[], what: string): Promise<ApiResponse & T> {
    return this.request<T>(event, args, `Failed to fetch ${what}`, {
      ms: FETCH_MONITOR_TIMEOUT_MS,
      msg: `Timed out after ${FETCH_MONITOR_TIMEOUT_MS}ms waiting for the server to return ${what}`,
    });
  }

  /**
   * Remove the listeners login() adds. A socket that reconnects is the same socket, and the
   * next tool call logs in on it again, so without this every reconnect left one more
   * listener per event handling the same push.
   */
  private removeDataListeners(): void {
    if (!this.socket) return;
    for (const event of DATA_EVENTS) this.socket.off(event);
  }

  /** Report loss of the authenticated session to the server layer. */
  private notifyAuthLost(reason: string): void {
    try {
      if (this.onAuthLost) this.onAuthLost(reason);
    } catch {
      // never let a listener error break socket handling
    }
  }

  /**
   * Reuse a live socket instead of blindly opening another one.
   *
   * connect() unconditionally assigns a brand-new socket to this.socket, so a retrying
   * caller orphans the previous one — which keeps its listeners and keeps reconnecting
   * forever, leaking a socket per attempt. Callers that just want a usable connection
   * should use this.
   */
  async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.connected) return;
    if (this.socket) this.disconnect(); // tear the dead one down before replacing it
    await this.connect();
  }

  /**
   * Connect to the Uptime Kuma server
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity,
        // Sent on the polling requests and on the WebSocket upgrade alike, so an auth proxy
        // in front of Kuma sees them on whichever request it inspects (issue #95).
        extraHeaders: this.extraHeaders,
      });

      let initialConnect = true;

      this.socket.on('connect', () => {
        if (initialConnect) {
          initialConnect = false;
          this.safeLog('info', 'Successfully connected to Uptime Kuma server');
          resolve();
        } else {
          this.safeLog('info', 'Reconnected to Uptime Kuma server, re-authenticating...');
          this.reauthenticate();
        }
      });

      // There was no 'disconnect' handler at all, so the server layer's isAuthenticated
      // flag stayed true across a dropped socket. An Uptime Kuma restart — or any network
      // blip — therefore left this client believing it was still authenticated while the
      // server treated it as anonymous, and every subsequent call failed until the process
      // was restarted. Surface the loss so the next call re-authenticates.
      this.socket.on('disconnect', (reason: string) => {
        this.safeLog('warning', `Disconnected from Uptime Kuma (${reason}); authentication invalidated`);
        this.notifyAuthLost(`socket disconnected (${reason})`);
      });

      this.socket.on('connect_error', (error: Error) => {
        this.safeLog('error', `Connection error: ${error.message}`);
        this.notifyAuthLost(`connection error (${error.message})`);
        if (initialConnect) {
          reject(new Error(`Connection failed: ${error.message}`));
        }
      });
    });
  }

  /**
   * Re-authenticate after a reconnection to refresh all cached data.
   * When the server restarts or the connection drops, Socket.IO reconnects
   * the transport but the server no longer considers the client authenticated.
   * Without re-emitting login, the server won't send monitorList or heartbeat
   * events, leaving the cache permanently stale.
   */
  private reauthenticate(): void {
    if (!this.socket || !this.loginCredentials) return;

    // Clear stale caches so they are fully replaced by fresh data from the server
    this.monitorListCache = {};
    this.heartbeatListCache = {};
    this.uptimeCache = {};
    this.avgPingCache = {};

    const { username, password, token, jwtToken } = this.loginCredentials;

    if (jwtToken) {
      this.emitAck('loginByToken', [jwtToken], (response: LoginResponse) => {
        if (response.ok) {
          this.safeLog('info', 'Re-authenticated after reconnection (JWT)');
        } else {
          // A refused re-auth used to be logged and forgotten, leaving the server layer
          // convinced it was still authenticated.
          this.safeLog('error', `Re-authentication failed: ${response.msg || 'unknown error'}`);
          this.notifyAuthLost(`re-authentication refused (${response.msg || 'unknown error'})`);
        }
      });
    } else if (username) {
      this.emitAck('login', [{ username, password, token }], (response: LoginResponse) => {
        if (response.ok) {
          this.safeLog('info', 'Re-authenticated after reconnection');
        } else {
          // A refused re-auth used to be logged and forgotten, leaving the server layer
          // convinced it was still authenticated.
          this.safeLog('error', `Re-authentication failed: ${response.msg || 'unknown error'}`);
          this.notifyAuthLost(`re-authentication refused (${response.msg || 'unknown error'})`);
        }
      });
    } else {
      this.socket.emit('login');
      this.safeLog('info', 'Re-authenticated after reconnection (anonymous)');
    }
  }

  /**
   * Disconnect from the Uptime Kuma server
   */
  disconnect(): void {
    if (this.socket) {
      this.removeDataListeners();

      this.socket.disconnect();
      this.socket = null;
    }

    // Clear the caches
    this.monitorListCache = {};
    this.heartbeatListCache = {};
    this.uptimeCache = {};
    this.avgPingCache = {};
    this.notificationListCache = {};
    this.tagListCache = [];
    this.maintenanceListCache = {};
    this.statusPageListCache = {};
    this.dockerHostListCache = [];
    this.proxyListCache = [];
    this.remoteBrowserListCache = [];
    this.apiKeyListCache = [];
  }

  /**
   * Login using username and password, or JWT token
   *
   * @param username - Username (can be empty string)
   * @param password - Password/API key
   * @param token - Optional 2FA token if required
   * @param jwtToken - Optional JWT token for token-based authentication
   * @returns Promise resolving to the login response
   */
  login(
    username: string | undefined,
    password: string | undefined,
    token?: string,
    jwtToken?: string
  ): Promise<LoginResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      // Store credentials for re-authentication on reconnect
      this.loginCredentials = { username, password, token, jwtToken };

      // Set up listeners for monitor list and heartbeat updates before login. Any left by an
      // earlier login on this socket go first, so there is one per event however often we log in.
      this.removeDataListeners();
      this.setupMonitorListListeners();
      this.setupHeartbeatListeners();
      this.setupUptimeListeners();
      this.setupAvgPingListeners();
      this.setupNotificationListListeners();
      this.setupTagListListeners();
      this.setupMaintenanceListListeners();
      this.setupStatusPageListListeners();
      this.setupDockerHostListListeners();
      this.setupProxyAndKeyListListeners();

      // If JWT token is provided, use token-based authentication
      if (jwtToken) {
        this.emitAck('loginByToken', [jwtToken], (response: LoginResponse) => {
          if (response.ok) {
            resolve(response);
          } else {
            reject(new Error(response.msg || 'JWT token login failed'));
          }
        });
        return;
      }

      const loginData: { username: string | undefined; password: string | undefined; token?: string } = {
        username,
        password,
        token,
      };

      if (!loginData.username) {
        this.socket.emit('login');
        resolve({ ok: true, tokenRequired: false });
      } else {
        this.emitAck('login', [loginData], (response: LoginResponse) => {
          if (response.ok) {
            resolve(response);
          } else {
            reject(new Error(response.msg || 'Login failed'));
          }
        });
      }
    });
  }

  async getSettings(): Promise<GetSettingsResponse> {
    const response = await this.request<GetSettingsResponse>('getSettings', [], 'Failed to get settings');
    if (!response.data) return response;

    // Filter out sensitive fields like steamAPIKey
    const { steamAPIKey: _steamAPIKey, ...filteredData } = response.data as Settings & { steamAPIKey?: unknown };
    this.safeLog('debug', 'Successfully retrieved settings from Uptime Kuma');
    return { ...response, data: filteredData as Settings };
  }

  /**
   * Save general settings (Uptime Kuma's setSettings).
   *
   * Uptime Kuma writes only the keys it is sent, but its handler reads several absent keys as a
   * change: a missing nscd stops NSCD, a missing chromeExecutable resets Chrome, a missing
   * entryPage clears the entry page, and a missing disableAuth while auth is off logs every
   * client out. Callers therefore send the whole stored object with their changes merged in,
   * as the web UI does.
   *
   * `currentPassword` is the admin password. Uptime Kuma checks it only when authentication is
   * on and `data.disableAuth` is true, and ignores it otherwise.
   */
  async setSettings(data: Record<string, unknown>, currentPassword?: string): Promise<ApiResponse> {
    const response = await this.request('setSettings', [data, currentPassword ?? null], 'Failed to save settings');
    this.safeLog('info', `Successfully saved settings: ${Object.keys(data).join(', ')}`);
    return response;
  }

  /**
   * Pause a monitor
   *
   * @param monitorID - The ID of the monitor to pause
   * @returns Promise resolving to the API response
   */
  async pauseMonitor(monitorID: number): Promise<ApiResponse> {
    const response = await this.request('pauseMonitor', [monitorID], 'Failed to pause monitor');
    this.safeLog('info', `Successfully paused monitor ${monitorID}`);
    return response;
  }

  /**
   * Resume a monitor
   *
   * @param monitorID - The ID of the monitor to resume
   * @returns Promise resolving to the API response
   */
  async resumeMonitor(monitorID: number): Promise<ApiResponse> {
    const response = await this.request('resumeMonitor', [monitorID], 'Failed to resume monitor');
    this.safeLog('info', `Successfully resumed monitor ${monitorID}`);
    return response;
  }

  /**
   * Set up event listeners for monitor list updates
   * These listeners keep the cached monitor list in sync with the server
   */
  private setupMonitorListListeners(): void {
    if (!this.socket) return;

    // Listen for the full monitor list (sent after login or on major changes)
    this.socket.on('monitorList', (monitorList: { [monitorID: string]: MonitorRawData }) => {
      const monitorCount = Object.keys(monitorList).length;
      this.safeLog('debug', `Received monitorList with ${monitorCount} monitors`);
      this.monitorListCache = monitorList;
    });

    // Listen for updates to specific monitors
    this.socket.on('updateMonitorIntoList', (updates: { [monitorID: string]: MonitorRawData }) => {
      const updateCount = Object.keys(updates).length;
      const monitorIDs = Object.keys(updates).join(', ');
      this.safeLog('debug', `Received updateMonitorIntoList for ${updateCount} monitor(s): ${monitorIDs}`);
      Object.assign(this.monitorListCache, updates);
    });

    // Listen for monitor deletions
    this.socket.on('deleteMonitorFromList', (monitorID: number) => {
      this.safeLog('debug', `Received deleteMonitorFromList for monitor ${monitorID}`);
      delete this.monitorListCache[monitorID.toString()];
    });
  }

  /**
   * Orders heartbeats newest-first.
   *
   * Sorts by `time`, NOT by `id`: live `heartbeat` events carry no `id` at all — the
   * payload is monitorID/status/time/msg/ping/important/retries — so an id-based
   * comparator would sink every live beat to the bottom. `id` only breaks ties between
   * two beats stamped in the same millisecond.
   *
   * `time` looks like "2026-07-28 04:13:43.158". Not ISO-8601, but Date.parse accepts it
   * and parses every beat the same way, so relative order holds. The format is also
   * fixed-width, which makes a lexicographic compare a safe fallback if a future version
   * emits something Date.parse rejects.
   */
  static compareBeatsNewestFirst(a: Heartbeat, b: Heartbeat): number {
    const ta = Date.parse(a?.time ?? '');
    const tb = Date.parse(b?.time ?? '');

    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
    if (Number.isNaN(ta) !== Number.isNaN(tb)) {
      // An unparseable timestamp sorts last rather than corrupting the head of the list,
      // which is the position every read depends on.
      return Number.isNaN(ta) ? 1 : -1;
    }
    if (Number.isNaN(ta) && Number.isNaN(tb)) {
      return String(b?.time ?? '').localeCompare(String(a?.time ?? ''));
    }
    if (typeof a?.id === 'number' && typeof b?.id === 'number') return b.id - a.id;
    return 0;
  }

  /**
   * Normalise any heartbeat array to newest-first and de-duplicated.
   *
   * Two sources of duplicates, each keyed differently:
   *
   * - A `heartbeatList` refresh re-sending beats already held. Those carry an `id`, which
   *   is the database primary key and so identifies the beat exactly.
   * - socket.io re-delivering a live `heartbeat` event. Those carry no `id` at all, so the
   *   key has to be built from the payload. Timestamp alone is NOT enough: two genuinely
   *   different beats can land in the same millisecond, and collapsing those would silently
   *   drop one. Including status/msg/ping means an identical redelivery collapses while a
   *   distinct same-millisecond beat survives.
   *
   * The two key spaces are deliberately kept apart — a live beat and its later persisted
   * twin cannot be cross-matched, because the live one has no id to match on. That costs
   * nothing here: the `heartbeatList` handler replaces the cached array wholesale rather
   * than merging into it, so the persisted copy never lands beside the live one.
   */
  static normaliseHeartbeat(beat: Heartbeat): Heartbeat {
    const rawMsg = (beat as Heartbeat & { msg: unknown }).msg;
    const msg = normaliseMsg(rawMsg);

    return msg === rawMsg ? beat : { ...beat, msg: msg as Heartbeat['msg'] };
  }

  static normaliseBeats(list: Heartbeat[]): Heartbeat[] {
    const seen = new Set<string>();
    const deduped: Heartbeat[] = [];
    for (const rawBeat of list) {
      const beat = UptimeKumaClient.normaliseHeartbeat(rawBeat);
      const key =
        typeof beat?.id === 'number'
          ? `id:${beat.id}`
          : `t:${beat?.time}|${beat?.status}|${beat?.msg ?? ''}|${beat?.ping ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(beat);
    }
    return deduped.sort(UptimeKumaClient.compareBeatsNewestFirst);
  }

  /**
   * Set up event listeners for heartbeat updates
   * These listeners keep the cached heartbeat list in sync with the server
   */
  private setupHeartbeatListeners(): void {
    if (!this.socket) return;

    // Listen for the full heartbeat list (sent after login)
    this.socket.on('heartbeatList', (monitorID: number, heartbeatList: Heartbeat[], _overwrite?: boolean) => {
      // Format: (monitorID, array of heartbeats, overwrite). The third argument is Kuma's
      // `overwrite` flag and has nothing to do with important/event beats, despite the
      // name it is often given.
      //
      // Coerce before anything reads the payload, including the log line. A malformed or
      // empty emit would otherwise throw straight out of a socket.io listener, where there
      // is no caller to catch it.
      const beats = Array.isArray(heartbeatList) ? heartbeatList : [];
      this.safeLog('debug', `Received heartbeatList for monitor ${monitorID}: ${beats.length} heartbeats`);

      // Uptime Kuma emits this list oldest-first while the cache is consumed newest-first
      // (#56/#57). Sorting rather than reversing keeps that true if the server's ordering
      // ever changes, and costs nothing on an already-ordered list.
      this.heartbeatListCache[monitorID.toString()] = UptimeKumaClient.normaliseBeats(beats);
    });

    // Listen for individual heartbeat updates (real-time)
    this.socket.on('heartbeat', (rawHeartbeat: Heartbeat) => {
      const heartbeat = UptimeKumaClient.normaliseHeartbeat(rawHeartbeat);
      // The heartbeat event should always include monitorID
      if (!heartbeat.monitorID) {
        this.safeLog('warning', 'Received heartbeat without monitorID');
        return;
      }

      const monitorID = heartbeat.monitorID.toString();
      // The heartbeat msg is the monitored service's own status text. For HTTP monitors it can
      // echo the target URL (including any user:password@ in it) or a slice of the response body,
      // so logging it verbatim would push that onto the MCP logging channel, which on the stdio
      // transport reaches the client. Report only its shape (length), never its content, the same
      // rule #71 applies everywhere else a credential could surface.
      const msgLength = (heartbeat.msg || '').length;
      this.safeLog(
        'debug',
        `Received heartbeat for monitor ${monitorID}: status=${heartbeat.status}, msgLength=${msgLength}, ping=${heartbeat.ping || 'N/A'}ms`
      );

      // Initialize array for this monitor if it doesn't exist
      if (!this.heartbeatListCache[monitorID]) {
        this.heartbeatListCache[monitorID] = [];
      }

      const list = this.heartbeatListCache[monitorID];
      list.unshift(heartbeat);

      // unshift assumes the beat that just arrived is the newest one. Usually true, but
      // not after a reconnect, when a heartbeatList refresh races a live beat, or across a
      // clock step — so re-assert the invariant instead of trusting arrival order. The
      // check is a single comparison on the already-sorted head; the sort only runs when
      // the order was actually violated.
      //
      // `>= 0` rather than `> 0`: a tie means the arriving beat is not strictly newer than
      // the head, which is exactly the shape of a socket.io redelivery of the beat already
      // there. A live beat has no id for the comparator to break the tie with, so a tie is
      // the only signal that a duplicate may need collapsing.
      if (list.length > 1 && UptimeKumaClient.compareBeatsNewestFirst(list[0], list[1]) >= 0) {
        this.heartbeatListCache[monitorID] = UptimeKumaClient.normaliseBeats(list);
      }

      // Keep only the most recent heartbeats (limit to 100 like the API does)
      if (this.heartbeatListCache[monitorID].length > 100) {
        this.heartbeatListCache[monitorID] = this.heartbeatListCache[monitorID].slice(0, 100);
      }
    });
  }

  /**
   * Set up event listeners for uptime updates
   * These listeners keep the cached uptime data in sync with the server
   */
  private setupUptimeListeners(): void {
    if (!this.socket) return;

    // Listen for uptime percentage updates
    this.socket.on('uptime', (monitorID: number, periodKey: string, percentage: number) => {
      this.safeLog('debug', `Received uptime for monitor ${monitorID}, period ${periodKey}: ${percentage}%`);

      const monitorIDStr = monitorID.toString();

      // Initialize uptime object for this monitor if it doesn't exist
      if (!this.uptimeCache[monitorIDStr]) {
        this.uptimeCache[monitorIDStr] = {};
      }

      // Store the uptime percentage for this period
      this.uptimeCache[monitorIDStr][periodKey] = percentage;
    });
  }

  /**
   * Set up event listeners for average ping updates
   * These listeners keep the cached average ping data in sync with the server
   */
  private setupAvgPingListeners(): void {
    if (!this.socket) return;

    // Listen for average ping updates
    this.socket.on('avgPing', (monitorID: number, avgPing: number | null) => {
      this.safeLog('debug', `Received avgPing for monitor ${monitorID}: ${avgPing}ms`);

      const monitorIDStr = monitorID.toString();

      // Store the average ping for this monitor
      this.avgPingCache[monitorIDStr] = avgPing;
    });
  }

  /**
   * Get a specific monitor by ID from the cache
   *
   * @param monitorID - The ID of the monitor to retrieve
   * @param includeTypeSpecificFields - If true, returns MonitorWithExtendedData with type-specific fields. If false, returns only MonitorBaseWithExtendedData (common fields + runtime data).
   * @returns The monitor data, or undefined if not found
   */
  getMonitor<T extends boolean = true>(
    monitorID: number,
    includeTypeSpecificFields?: T
  ): T extends true ? MonitorWithExtendedData | undefined : MonitorBaseWithExtendedData | undefined {
    const rawMonitor = this.monitorListCache[monitorID.toString()];
    // The return type depends on the argument, which TypeScript cannot follow through the body.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    if (!rawMonitor) return undefined as any;

    const monitorIDStr = monitorID.toString();

    // Merge uptime and avgPing data into the monitor object
    const uptime = this.uptimeCache[monitorIDStr];
    const avgPing = monitorIDStr in this.avgPingCache ? this.avgPingCache[monitorIDStr] : undefined;

    const fullMonitor: MonitorWithExtendedData = {
      ...rawMonitor,
      uptime: uptime || {},
      avgPing,
    } as MonitorWithExtendedData;

    // If includeTypeSpecificFields is false, filter to base fields only (excluding type-specific fields)
    if (includeTypeSpecificFields === false) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- conditional return type, as above
      return filterToBaseWithExtendedData(fullMonitor) as any;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- conditional return type, as above
    return fullMonitor as any;
  }

  /**
   * Get the cached full list of monitors the user has access to
   * The list is populated after login and kept up-to-date via server events
   *
   * @param filters - Optional filter criteria
   * @returns The cached monitor list
   */
  getMonitorList<T extends boolean = true>(
    filters?: MonitorFilters & { includeTypeSpecificFields?: T }
  ): MonitorList<T> {
    const result: MonitorList<true> = {};

    const matches = monitorFilter(filters);

    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      if (!matches(monitor)) continue;

      const avgPing = monitorID in this.avgPingCache ? this.avgPingCache[monitorID] : undefined;

      const fullMonitor: MonitorWithExtendedData = {
        ...monitor,
        uptime: this.uptimeCache[monitorID] || {},
        avgPing,
      } as MonitorWithExtendedData;

      // If includeTypeSpecificFields is false, filter to base fields only (excluding type-specific fields)
      if (filters?.includeTypeSpecificFields === false) {
        result[monitorID] = filterToBaseWithExtendedData(fullMonitor) as MonitorWithExtendedData;
      } else {
        result[monitorID] = fullMonitor;
      }
    }

    return result as MonitorList<T>;
  }

  /**
   * Get the cached heartbeat list
   * The list is populated after login and kept up-to-date via server events
   *
   * @param maxHeartbeats - Maximum number of heartbeats to return per monitor (default: 1)
   * @returns The cached heartbeat list with arrays of heartbeats
   */
  getHeartbeatList(maxHeartbeats: number = 1): { [monitorID: string]: Heartbeat[] } {
    const result: { [monitorID: string]: Heartbeat[] } = {};

    for (const [monitorID, heartbeats] of Object.entries(this.heartbeatListCache)) {
      result[monitorID] = heartbeats.slice(0, maxHeartbeats).map(UptimeKumaClient.normaliseHeartbeat);
    }

    return result;
  }

  /**
   * Get heartbeats for a specific monitor from the cache
   *
   * @param monitorID - The ID of the monitor
   * @param maxHeartbeats - Maximum number of heartbeats to return (default: 1)
   * @returns Array of heartbeats for the monitor, or empty array if none exist
   */
  getHeartbeatsForMonitor(monitorID: number, maxHeartbeats: number = 1): Heartbeat[] {
    const heartbeats = this.heartbeatListCache[monitorID.toString()];

    if (!heartbeats) {
      return [];
    }

    return heartbeats.slice(0, maxHeartbeats).map(UptimeKumaClient.normaliseHeartbeat);
  }

  /**
   * The single authority for "what is this monitor's current state".
   *
   * Every caller that wants current status should come through here rather than indexing
   * the cache itself, so there is one definition of "latest" to keep correct.
   *
   * @param monitorID - The ID of the monitor
   * @returns The most recent heartbeat, or undefined if none is cached
   */
  getLatestHeartbeat(monitorID: number): Heartbeat | undefined {
    const heartbeats = this.heartbeatListCache[monitorID.toString()];
    return heartbeats && heartbeats.length > 0 ? UptimeKumaClient.normaliseHeartbeat(heartbeats[0]) : undefined;
  }

  /**
   * Important ("event") heartbeats — the status *changes* that drive Uptime Kuma's own
   * event list.
   *
   * Deliberately NOT cached and NOT used for current state. Uptime Kuma does not push
   * `importantHeartbeatList` at login (only `heartbeatList`), so a cache would start empty
   * and go stale; this fetches on demand through the `monitorImportantHeartbeatListPaged`
   * RPC, which reads the database.
   *
   * That feed arrives newest-first — the opposite order to `heartbeatList` — so it goes
   * through the same comparator rather than being trusted.
   *
   * @param monitorID - The ID of the monitor
   * @param count - How many important beats to return
   * @param offset - Pagination offset
   * @returns Array of important heartbeats, newest-first
   */
  async fetchImportantHeartbeats(monitorID: number, count: number = 25, offset: number = 0): Promise<Heartbeat[]> {
    const response = await this.request<{ data?: Heartbeat[] }>(
      'monitorImportantHeartbeatListPaged',
      [monitorID, offset, count],
      'Failed to fetch important heartbeats'
    );
    return UptimeKumaClient.normaliseBeats(response.data || []);
  }

  /**
   * Get a summarized list of all monitors with their most recent heartbeat status
   *
   * @param filters - Optional filter criteria
   * @returns Array of monitor summaries containing essential info and latest heartbeat status
   */
  getMonitorSummary(filters?: MonitorFilters & { status?: string }): MonitorSummary[] {
    const summaries = [];

    const matches = monitorFilter(filters);
    const statusFilter = parseStatusFilter(filters?.status);

    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      if (!matches(monitor)) continue;

      // Get the most recent heartbeat for this monitor. Routed through getLatestHeartbeat
      // so "current state" has exactly one definition.
      const latestHeartbeat = this.getLatestHeartbeat(Number(monitorID));

      // Filter by current status
      if (statusFilter.length > 0 && latestHeartbeat?.status !== undefined) {
        if (!statusFilter.includes(latestHeartbeat.status)) {
          continue;
        }
      } else if (statusFilter.length > 0 && !latestHeartbeat) {
        // If status filter is specified but no heartbeat exists, skip this monitor
        continue;
      }

      // Get uptime and avgPing data
      const uptime = this.uptimeCache[monitorID];
      const avgPing = monitorID in this.avgPingCache ? this.avgPingCache[monitorID] : undefined;

      summaries.push({
        id: monitor.id,
        name: monitor.name,
        pathName: monitor.pathName,
        active: monitor.active,
        maintenance: monitor.maintenance,
        status: latestHeartbeat?.status,
        msg: latestHeartbeat?.msg,
        // Correct ordering alone does not solve the real hazard: a push monitor that has
        // STOPPED beating reports its last known status forever and looks identical to a
        // healthy one. The timestamp is what makes staleness checkable rather than assumed.
        lastBeatTime: latestHeartbeat?.time,
        uptime: uptime || {},
        avgPing,
        type: monitor.type,
        tags: monitor.tags,
      });
    }

    return summaries;
  }

  // ─── New listener setup methods ────────────────────────────────────────────

  private setupNotificationListListeners(): void {
    if (!this.socket) return;
    this.socket.on('notificationList', (notificationList: { [id: string]: Notification }) => {
      this.safeLog('debug', `Received notificationList with ${Object.keys(notificationList).length} notifications`);
      this.notificationListCache = notificationList;
    });
  }

  private setupTagListListeners(): void {
    if (!this.socket) return;
    this.socket.on(
      'tagList',
      (
        tagList:
          | { [id: string]: { id: number; name: string; color: string } }
          | Array<{ id: number; name: string; color: string }>
      ) => {
        const tags = Array.isArray(tagList) ? tagList : Object.values(tagList);
        this.safeLog('debug', `Received tagList with ${tags.length} tags`);
        this.tagListCache = tags;
      }
    );
  }

  private setupMaintenanceListListeners(): void {
    if (!this.socket) return;
    this.socket.on('maintenanceList', (maintenanceList: { [id: string]: Maintenance }) => {
      this.safeLog('debug', `Received maintenanceList with ${Object.keys(maintenanceList).length} windows`);
      this.maintenanceListCache = maintenanceList;
    });
  }

  private setupStatusPageListListeners(): void {
    if (!this.socket) return;
    this.socket.on('statusPageList', (statusPageList: { [slug: string]: StatusPage }) => {
      this.safeLog('debug', `Received statusPageList with ${Object.keys(statusPageList).length} status pages`);
      this.statusPageListCache = statusPageList;
    });
  }

  private setupDockerHostListListeners(): void {
    if (!this.socket) return;
    this.socket.on('dockerHostList', (dockerHostList: DockerHost[]) => {
      this.safeLog('debug', `Received dockerHostList with ${dockerHostList.length} docker hosts`);
      this.dockerHostListCache = dockerHostList;
    });
  }

  /**
   * Uptime Kuma pushes these three lists after login and again after every change to them.
   * proxyList arrives as raw rows (snake_case, 0/1 flags), so it is normalized here.
   */
  private setupProxyAndKeyListListeners(): void {
    if (!this.socket) return;
    this.socket.on('proxyList', (rows: Array<Record<string, unknown>>) => {
      this.safeLog('debug', `Received proxyList with ${rows.length} proxies`);
      this.proxyListCache = rows.map(normalizeProxy);
    });
    this.socket.on('remoteBrowserList', (list: RemoteBrowser[]) => {
      this.safeLog('debug', `Received remoteBrowserList with ${list.length} remote browsers`);
      this.remoteBrowserListCache = list;
    });
    this.socket.on('apiKeyList', (list: Array<Record<string, unknown>>) => {
      this.safeLog('debug', `Received apiKeyList with ${list.length} API keys`);
      this.apiKeyListCache = list.map((k) => ({ ...k, active: !!k.active }) as APIKey);
    });
  }

  // ─── Monitor write operations ───────────────────────────────────────────────

  /**
   * Create a new monitor. If `tags` are supplied, they are applied after
   * creation using the separate `addMonitorTag` socket event — the `add`
   * socket handler does not process tags.
   *
   * @param monitorData - Monitor configuration (type-specific fields should be included)
   * @returns Promise resolving to the API response with the new monitorID
   */
  async createMonitor(monitorData: Record<string, unknown>): Promise<ApiResponse & { monitorID?: number }> {
    const { tags, ...payload } = monitorData as { tags?: Array<Record<string, unknown>> };

    const response = await this.request<{ monitorID?: number }>('add', [payload], 'Failed to create monitor');
    this.safeLog('info', `Successfully created monitor (ID: ${response.monitorID})`);

    if (tags && Array.isArray(tags) && response.monitorID != null) {
      await this.reconcileMonitorTags(response.monitorID, tags);
    }

    return response;
  }

  /**
   * Update an existing monitor. If `tags` are supplied, they are reconciled
   * against the monitor's current tag set using `addMonitorTag` /
   * `deleteMonitorTag` — the `editMonitor` socket handler does not process
   * tags. Tags whose name is not yet in the catalog are auto-created via
   * `addTag` before binding.
   *
   * @param monitorData - Monitor configuration including the id field
   * @returns Promise resolving to the API response
   */
  async updateMonitor(monitorData: Record<string, unknown>): Promise<ApiResponse & { monitorID?: number }> {
    const { tags, ...payload } = monitorData as { tags?: Array<Record<string, unknown>> };

    const response = await this.request<{ monitorID?: number }>('editMonitor', [payload], 'Failed to update monitor');
    this.safeLog('info', `Successfully updated monitor (ID: ${monitorData['id']})`);

    if (tags && Array.isArray(tags) && monitorData['id'] != null) {
      await this.reconcileMonitorTags(Number(monitorData['id']), tags);
    }

    return response;
  }

  /**
   * Fetch the tag catalog synchronously from the server. Uptime Kuma does
   * not push `tagList` events — it only responds to the `getTags` request —
   * so relying on the push-populated cache returns stale (often empty) data.
   * This method also refreshes `tagListCache` so subsequent cache reads work.
   */
  private async fetchTagList(): Promise<Array<{ id: number; name: string; color: string }>> {
    const response = await this.request<{ tags?: Array<{ id: number; name: string; color: string }> }>(
      'getTags',
      [],
      'Failed to fetch tag list'
    );
    if (!response.tags) throw new Error(response.msg || 'Failed to fetch tag list');

    this.tagListCache = response.tags;
    return response.tags;
  }

  /**
   * Bind a tag to a monitor (socket: `addMonitorTag`).
   */
  private addMonitorTag(tagID: number, monitorID: number, value: string): Promise<ApiResponse> {
    return this.request(
      'addMonitorTag',
      [tagID, monitorID, value],
      `Failed to add tag ${tagID} to monitor ${monitorID}`
    );
  }

  /**
   * Unbind a tag from a monitor (socket: `deleteMonitorTag`).
   */
  private deleteMonitorTag(tagID: number, monitorID: number, value: string): Promise<ApiResponse> {
    return this.request(
      'deleteMonitorTag',
      [tagID, monitorID, value],
      `Failed to remove tag ${tagID} from monitor ${monitorID}`
    );
  }

  /**
   * Reconcile a monitor's tags against the desired list. Auto-creates any
   * tag name that isn't yet in the catalog. Tag identity is `(name, value)`.
   */
  private async reconcileMonitorTags(monitorID: number, desiredTags: Array<Record<string, unknown>>): Promise<void> {
    const currentMonitor = this.monitorListCache[String(monitorID)];
    const currentTags = (currentMonitor?.tags ?? []) as Array<{
      tag_id?: number;
      name: string;
      value?: string;
      color?: string;
    }>;

    const key = (name: string, value: string | undefined) => `${name}\u0000${value ?? ''}`;
    const currentKeys = new Set(currentTags.map((t) => key(t.name, t.value)));
    const desiredKeys = new Set(desiredTags.map((t) => key(String(t.name), t.value as string | undefined)));

    // Uptime Kuma never pushes `tagList` events, so the cache is unreliable
    // — fetch the catalog synchronously via the `getTags` socket request.
    const freshTags = await this.fetchTagList();
    const nameToID = new Map<string, number>();
    for (const t of freshTags) nameToID.set(t.name, t.id);

    for (const desired of desiredTags) {
      const name = String(desired.name);
      const value = (desired.value as string | undefined) ?? '';
      if (currentKeys.has(key(name, value))) continue;

      let tagID = nameToID.get(name);
      if (tagID == null) {
        const color = (desired.color as string | undefined) ?? '#808080';
        const created = await this.addTag(name, color);
        tagID = created.tag?.id;
        if (tagID != null) nameToID.set(name, tagID);
      }
      if (tagID == null) {
        throw new Error(`Could not resolve tag ID for "${name}"`);
      }
      await this.addMonitorTag(tagID, monitorID, value);
    }

    for (const existing of currentTags) {
      if (desiredKeys.has(key(existing.name, existing.value))) continue;
      const tagID = existing.tag_id ?? nameToID.get(existing.name);
      if (tagID == null) continue;
      await this.deleteMonitorTag(tagID, monitorID, existing.value ?? '');
    }

    // Update the local cache so subsequent reads reflect the new tags
    // without waiting for the server to push a monitorList event.
    if (this.monitorListCache[String(monitorID)]) {
      const updatedTags = desiredTags.map((t) => {
        const name = String(t.name);
        const value = (t.value as string | undefined) ?? '';
        const tagID = nameToID.get(name);
        const color = (t.color as string | undefined) ?? freshTags.find((ft) => ft.name === name)?.color ?? '#808080';
        return { tag_id: tagID, name, value, color };
      });
      this.monitorListCache[String(monitorID)].tags = updatedTags;
    }
  }

  /**
   * Read a monitor back from the SERVER, bypassing the cache.
   *
   * Deliberately not `getMonitor()`, which serves `monitorListCache`. That cache is
   * refreshed by pushed events, and those can arrive AFTER the callback of a write has
   * already resolved — so a read taken from it immediately after a write can echo a
   * value that was never stored. Uptime Kuma's `getMonitor` socket handler reads the
   * database, which is the only answer worth verifying against.
   *
   * Bounded by a timeout because a disconnect between the emit and the acknowledgement
   * leaves a socket.io callback that is simply never invoked. This read sits on the success
   * path of every monitor write, so an unsettled promise here hangs the whole tool call —
   * a slow answer is worth waiting for, an answer that never comes is not.
   *
   * @param monitorID - The ID of the monitor to fetch
   * @returns Promise resolving to the monitor exactly as stored server-side
   */
  async fetchMonitor(monitorID: number): Promise<Record<string, unknown>> {
    const what = `monitor ${monitorID}`;
    const response = await this.readBack<{ monitor?: Record<string, unknown> }>('getMonitor', [monitorID], what);
    if (!response.monitor) throw new Error(response.msg || `Failed to fetch ${what}`);
    return response.monitor;
  }

  /**
   * Delete a monitor
   *
   * @param monitorID - The ID of the monitor to delete
   * @returns Promise resolving to the API response
   */
  async deleteMonitor(monitorID: number): Promise<ApiResponse> {
    const response = await this.request('deleteMonitor', [monitorID], 'Failed to delete monitor');
    this.safeLog('info', `Successfully deleted monitor ${monitorID}`);
    return response;
  }

  // ─── Notification operations ────────────────────────────────────────────────

  /**
   * Get the cached notification list
   */
  getNotificationList(): Notification[] {
    return Object.values(this.notificationListCache);
  }

  /**
   * Add or update a notification channel
   *
   * @param notification - Notification configuration
   * @param notificationID - If provided, updates existing; otherwise creates new
   * @returns Promise resolving to the API response with the notification id
   */
  async addNotification(
    notification: Record<string, unknown>,
    notificationID?: number
  ): Promise<ApiResponse & { id?: number }> {
    const response = await this.request<{ id?: number }>(
      'addNotification',
      [notification, notificationID ?? null],
      'Failed to save notification'
    );
    this.safeLog('info', `Successfully saved notification (ID: ${response.id})`);
    return response;
  }

  /**
   * Delete a notification channel
   *
   * @param notificationID - The ID of the notification to delete
   * @returns Promise resolving to the API response
   */
  async deleteNotification(notificationID: number): Promise<ApiResponse> {
    const response = await this.request('deleteNotification', [notificationID], 'Failed to delete notification');
    this.safeLog('info', `Successfully deleted notification ${notificationID}`);
    return response;
  }

  // ─── Docker host operations ─────────────────────────────────────────────────

  /**
   * Get the cached docker host list
   */
  getDockerHostList(): DockerHost[] {
    return this.dockerHostListCache;
  }

  /**
   * Add or update a docker host
   *
   * @param dockerHost - Docker host configuration (name, dockerType, dockerDaemon)
   * @param dockerHostID - If provided, updates existing; otherwise creates new
   * @returns Promise resolving to the API response with the docker host id
   */
  async addDockerHost(
    dockerHost: Record<string, unknown>,
    dockerHostID?: number
  ): Promise<ApiResponse & { id?: number }> {
    const response = await this.request<{ id?: number }>(
      'addDockerHost',
      [dockerHost, dockerHostID ?? null],
      'Failed to save docker host'
    );
    this.safeLog('info', `Successfully saved docker host (ID: ${response.id})`);
    return response;
  }

  /**
   * Delete a docker host. Any monitors referencing it will have their docker_host
   * field cleared by Uptime Kuma.
   *
   * @param dockerHostID - The ID of the docker host to delete
   * @returns Promise resolving to the API response
   */
  async deleteDockerHost(dockerHostID: number): Promise<ApiResponse> {
    const response = await this.request('deleteDockerHost', [dockerHostID], 'Failed to delete docker host');
    this.safeLog('info', `Successfully deleted docker host ${dockerHostID}`);
    return response;
  }

  /**
   * Test connectivity to a docker host without persisting it. Returns a friendly
   * message containing the number of containers when reachable.
   *
   * @param dockerHost - Docker host configuration to test (name, dockerType, dockerDaemon)
   * @returns Promise resolving to the API response
   */
  testDockerHost(dockerHost: Record<string, unknown>): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.emitAck('testDockerHost', [dockerHost], (response: ApiResponse) => {
        // Resolve either way so callers can inspect ok/msg without try/catch
        // (matches the pattern used by UK's UI, which shows both success and
        // failure messages from the same callback).
        resolve(response);
      });
    });
  }

  // ─── Tag operations ─────────────────────────────────────────────────────────

  /**
   * Get the tag list. Actively fetches from the server since Uptime Kuma
   * does not push `tagList` events on login (issue #46).
   * Falls back to the cache if the socket is not connected.
   */
  async getTagList(): Promise<Array<{ id: number; name: string; color: string }>> {
    try {
      return await this.fetchTagList();
    } catch {
      return this.tagListCache;
    }
  }

  /**
   * Create a new tag
   *
   * @param name - Tag name
   * @param color - Tag color (hex string, e.g. '#ff0000')
   * @returns Promise resolving to the created tag object
   */
  async addTag(
    name: string,
    color: string
  ): Promise<ApiResponse & { tag?: { id: number; name: string; color: string } }> {
    const response = await this.request<{ tag?: { id: number; name: string; color: string } }>(
      'addTag',
      [{ name, color }],
      'Failed to create tag'
    );
    this.safeLog('info', `Successfully created tag "${name}" (ID: ${response.tag?.id})`);
    return response;
  }

  /**
   * Rename and/or recolor a tag. Uptime Kuma writes both fields from what it is sent, so both
   * are required here; the updateTag tool fills in the one the caller left out.
   *
   * @param tagID - The ID of the tag to change
   * @param name - Tag name
   * @param color - Tag color (hex string, e.g. '#ff0000')
   * @returns Promise resolving to the saved tag object
   */
  async editTag(
    tagID: number,
    name: string,
    color: string
  ): Promise<ApiResponse & { tag?: { id: number; name: string; color: string } }> {
    const response = await this.request<{ tag?: { id: number; name: string; color: string } }>(
      'editTag',
      [{ id: tagID, name, color }],
      'Failed to update tag'
    );
    this.safeLog('info', `Successfully updated tag ${tagID}`);
    return response;
  }

  /**
   * Delete a tag
   *
   * @param tagID - The ID of the tag to delete
   * @returns Promise resolving to the API response
   */
  async deleteTag(tagID: number): Promise<ApiResponse> {
    const response = await this.request('deleteTag', [tagID], 'Failed to delete tag');
    this.safeLog('info', `Successfully deleted tag ${tagID}`);
    return response;
  }

  // ─── Maintenance operations ─────────────────────────────────────────────────

  /**
   * Get the cached maintenance window list
   */
  getMaintenanceList(): Maintenance[] {
    return Object.values(this.maintenanceListCache);
  }

  /**
   * Create a new maintenance window
   *
   * @param maintenanceData - Maintenance window configuration
   * @returns Promise resolving to the API response with the maintenance ID
   */
  async createMaintenance(maintenanceData: Record<string, unknown>): Promise<ApiResponse & { maintenanceID?: number }> {
    const response = await this.request<{ maintenanceID?: number }>(
      'addMaintenance',
      [maintenanceData],
      'Failed to create maintenance window'
    );
    this.safeLog('info', `Successfully created maintenance window (ID: ${response.maintenanceID})`);
    return response;
  }

  /**
   * Update an existing maintenance window.
   *
   * Uptime Kuma's editMaintenance handler rebuilds the row from the object it is given
   * (Maintenance.jsonToBean), so this must be the FULL window — a partial object either
   * throws on the missing dateRange or writes NULL over every omitted column.
   *
   * @param maintenanceData - The complete maintenance window, including its id
   * @returns Promise resolving to the API response
   */
  async editMaintenance(maintenanceData: Record<string, unknown>): Promise<ApiResponse & { maintenanceID?: number }> {
    const response = await this.request<{ maintenanceID?: number }>(
      'editMaintenance',
      [maintenanceData],
      `Failed to update maintenance window ${maintenanceData.id}`
    );
    this.safeLog('info', `Successfully updated maintenance window ${maintenanceData.id}`);
    return response;
  }

  /**
   * Read a maintenance window back from the SERVER, bypassing the cache.
   *
   * Same reasoning as fetchMonitor(): `maintenanceListCache` is refreshed by pushed events,
   * so it is not proof that a write landed. Uptime Kuma's `getMaintenance` handler reads the
   * database. Bounded by the same timeout, since it sits on the success path of every
   * maintenance write.
   *
   * @param maintenanceID - The ID of the maintenance window to fetch
   * @returns Promise resolving to the window exactly as stored server-side
   */
  fetchMaintenance(maintenanceID: number): Promise<Record<string, unknown>> {
    return this.readBack<{ maintenance?: Record<string, unknown> }>(
      'getMaintenance',
      [maintenanceID],
      `maintenance window ${maintenanceID}`
    ).then((response) => {
      if (!response.maintenance) {
        throw new Error(`Failed to fetch maintenance window ${maintenanceID}`);
      }
      return response.maintenance;
    });
  }

  /**
   * Get the IDs of the monitors a maintenance window applies to.
   *
   * @param maintenanceID - The ID of the maintenance window
   * @returns Promise resolving to the monitor IDs, read from the database
   */
  getMonitorMaintenance(maintenanceID: number): Promise<number[]> {
    return this.readBack<{ monitors?: Array<{ id: number }> }>(
      'getMonitorMaintenance',
      [maintenanceID],
      `the monitors of maintenance window ${maintenanceID}`
    ).then((response) => (response.monitors ?? []).map((m) => m.id));
  }

  /**
   * Set the monitors a maintenance window applies to.
   *
   * This is a full replace: Uptime Kuma deletes every existing monitor link for the window
   * before inserting the new ones, so pass the complete list. An empty list detaches all
   * monitors.
   *
   * @param maintenanceID - The ID of the maintenance window
   * @param monitorIDs - The complete list of monitor IDs the window should cover
   * @returns Promise resolving to the API response
   */
  async setMonitorMaintenance(maintenanceID: number, monitorIDs: number[]): Promise<ApiResponse> {
    const response = await this.request(
      'addMonitorMaintenance',
      [maintenanceID, monitorIDs.map((id) => ({ id }))],
      `Failed to set monitors on maintenance window ${maintenanceID}`
    );
    this.safeLog('info', `Set ${monitorIDs.length} monitor(s) on maintenance window ${maintenanceID}`);
    return response;
  }

  /**
   * Pause a maintenance window (sets it inactive and stops its schedule)
   *
   * @param maintenanceID - The ID of the maintenance window to pause
   * @returns Promise resolving to the API response
   */
  pauseMaintenance(maintenanceID: number): Promise<ApiResponse> {
    return this.emitMaintenanceAction('pauseMaintenance', maintenanceID, 'pause');
  }

  /**
   * Resume a paused maintenance window (sets it active and restarts its schedule)
   *
   * @param maintenanceID - The ID of the maintenance window to resume
   * @returns Promise resolving to the API response
   */
  resumeMaintenance(maintenanceID: number): Promise<ApiResponse> {
    return this.emitMaintenanceAction('resumeMaintenance', maintenanceID, 'resume');
  }

  /**
   * Delete a maintenance window.
   *
   * Uptime Kuma answers `ok: true` for an ID that does not exist, so callers that need to
   * know a window was really removed must check for it before and after.
   *
   * @param maintenanceID - The ID of the maintenance window to delete
   * @returns Promise resolving to the API response
   */
  deleteMaintenance(maintenanceID: number): Promise<ApiResponse> {
    return this.emitMaintenanceAction('deleteMaintenance', maintenanceID, 'delete');
  }

  /**
   * Re-fetch the maintenance window list from the server and return it.
   *
   * Uptime Kuma's getMaintenanceList handler pushes a fresh `maintenanceList` event and only
   * then acknowledges, and socket.io delivers the two in order, so the cache is current by the
   * time this resolves.
   */
  refreshMaintenanceList(): Promise<Maintenance[]> {
    return this.readBack('getMaintenanceList', [], 'the maintenance window list').then(() => this.getMaintenanceList());
  }

  private async emitMaintenanceAction(event: string, maintenanceID: number, verb: string): Promise<ApiResponse> {
    const response = await this.request(
      event,
      [maintenanceID],
      `Failed to ${verb} maintenance window ${maintenanceID}`
    );
    this.safeLog('info', `Successfully ran ${verb} on maintenance window ${maintenanceID}`);
    return response;
  }

  // ─── Status page operations ─────────────────────────────────────────────────

  /**
   * Get the cached status page list
   */
  getStatusPageList(): StatusPage[] {
    return Object.values(this.statusPageListCache);
  }

  /**
   * The full stored config of one status page, over the authenticated socket (Uptime Kuma's
   * StatusPage.toJSON(): every field saveStatusPage takes, including domainNameList, but not
   * the groups).
   */
  async getStatusPageConfig(slug: string): Promise<StatusPage & Record<string, unknown>> {
    const response = await this.request<{ config?: StatusPage }>(
      'getStatusPage',
      [slug],
      `Status page ${slug} not found`
    );
    if (!response.config) throw new Error(response.msg || `Status page ${slug} not found`);
    return response.config as StatusPage & Record<string, unknown>;
  }

  /**
   * Uptime Kuma sends statusPageList only at login, so a page added, saved or deleted since is
   * missing or out of date in the cache unless it is updated here. The entry is updated at once
   * from what is known, then replaced with the stored config when that arrives; a page that
   * cannot be read back keeps the known values.
   */
  private refreshStatusPageCache(slug: string, known: Partial<StatusPage>): void {
    this.statusPageListCache[slug] = { ...(this.statusPageListCache[slug] ?? {}), ...known, slug } as StatusPage;
    this.getStatusPageConfig(slug).then(
      (config) => {
        if (this.statusPageListCache[slug]) this.statusPageListCache[slug] = config;
      },
      () => {
        /* keep the known values */
      }
    );
  }

  /**
   * Get full details of a single status page, including publicGroupList with monitors
   * and any active incidents. Uses the public HTTP API (`/api/status-page/{slug}`),
   * which returns the same data the status page UI renders — richer than the
   * socket `getStatusPage` event, which only returns config.
   *
   * @param slug - The status page slug
   * @returns Promise resolving to the status page config, groups, and incidents
   */
  async getStatusPage(slug: string): Promise<
    ApiResponse & {
      config?: StatusPage;
      publicGroupList?: unknown[];
      incidents?: unknown[];
    }
  > {
    try {
      const baseUrl = this.url.replace(/\/$/, '');
      // Uptime Kuma caches this route for 5 minutes and only clears that on a save, so a page
      // read after other changes (a monitor deleted, say) could be stale. Unique query, fresh read.
      //
      // The extra headers go on this request as on the socket: a proxy that guards Uptime Kuma
      // guards this route too (issue #95). And it is bounded, like the socket reads.
      const res = await fetch(`${baseUrl}/api/status-page/${encodeURIComponent(slug)}?_=${Date.now()}`, {
        headers: this.extraHeaders,
        signal: AbortSignal.timeout(FETCH_MONITOR_TIMEOUT_MS),
      });
      if (res.status === 404) {
        return { ok: false, msg: `Status page ${slug} not found` };
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as {
        config: StatusPage;
        publicGroupList: unknown[];
        incidents?: unknown[];
      };
      return {
        ok: true,
        config: data.config,
        publicGroupList: data.publicGroupList,
        incidents: data.incidents ?? [],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get status page ${slug}: ${msg}`, { cause: error });
    }
  }

  /**
   * Create a new (empty) status page with the given title and slug
   *
   * Note: This creates a blank status page. Use updateStatusPage afterwards to
   * set description, theme, groups, monitors, etc.
   *
   * @param title - Display title of the status page
   * @param slug - URL slug (lowercase letters, digits, and dashes only)
   * @returns Promise resolving to the API response
   */
  async createStatusPage(title: string, slug: string): Promise<ApiResponse> {
    const response = await this.request('addStatusPage', [title, slug], `Failed to create status page ${slug}`);
    this.safeLog('info', `Successfully created status page ${slug}`);
    this.refreshStatusPageCache(slug, { title });
    return response;
  }

  /**
   * Update an existing status page's config and group/monitor list
   *
   * @param slug - The status page slug (immutable identifier)
   * @param config - Status page configuration (title, description, theme, published, etc.)
   * @param publicGroupList - Ordered groups, each with a name, weight, and monitorList `[{id}]`
   * @param imgDataUrl - Optional icon as data URL (pass empty string to keep existing)
   * @returns Promise resolving to the API response
   */
  async updateStatusPage(
    slug: string,
    config: Record<string, unknown>,
    publicGroupList: Array<Record<string, unknown>> = [],
    imgDataUrl: string = ''
  ): Promise<ApiResponse> {
    const response = await this.request(
      'saveStatusPage',
      [slug, config, imgDataUrl, publicGroupList],
      `Failed to update status page ${slug}`
    );
    this.safeLog('info', `Successfully updated status page ${slug}`);
    const newSlug = typeof config.slug === 'string' && config.slug ? config.slug : slug;
    if (newSlug !== slug) delete this.statusPageListCache[slug];
    this.refreshStatusPageCache(newSlug, config as Partial<StatusPage>);
    return response;
  }

  /**
   * Delete a status page
   *
   * @param slug - The status page slug
   * @returns Promise resolving to the API response
   */
  async deleteStatusPage(slug: string): Promise<ApiResponse> {
    const response = await this.request('deleteStatusPage', [slug], `Failed to delete status page ${slug}`);
    this.safeLog('info', `Successfully deleted status page ${slug}`);
    delete this.statusPageListCache[slug];
    return response;
  }

  // ─── Status page incidents ──────────────────────────────────────────────────

  /**
   * One page of a status page's incidents, newest first (Uptime Kuma's getIncidentHistory).
   * Pages hold INCIDENT_PAGE_SIZE (10) incidents; pass the previous page's nextCursor for the
   * next one.
   */
  async getIncidentHistory(
    slug: string,
    cursor?: string | null
  ): Promise<ApiResponse & { incidents?: Incident[]; total?: number; nextCursor?: string | null; hasMore?: boolean }> {
    return this.readBack('getIncidentHistory', [slug, cursor ?? null], `the incidents of status page ${slug}`);
  }

  /**
   * Post a new incident (Uptime Kuma's postIncident with no id). Uptime Kuma pins it and marks
   * it active, so it shows on the page at once. It does not check title or content itself.
   */
  async postIncident(
    slug: string,
    incident: { title: string; content: string; style: string }
  ): Promise<ApiResponse & { incident?: Incident }> {
    const response = await this.request<{ incident?: Incident }>(
      'postIncident',
      [slug, incident],
      `Failed to post incident on status page ${slug}`
    );
    this.safeLog('info', `Posted incident ${response.incident?.id} on status page ${slug}`);
    return response;
  }

  /**
   * Edit an incident (Uptime Kuma's editIncident). Title, content and style are written from
   * what is sent, so pass all three; pin is kept unless it is false.
   */
  async editIncident(
    slug: string,
    incidentID: number,
    incident: { title: string; content: string; style: string; pin: boolean }
  ): Promise<ApiResponse & { incident?: Incident }> {
    const response = await this.request<{ incident?: Incident }>(
      'editIncident',
      [slug, incidentID, incident],
      `Failed to edit incident ${incidentID}`
    );
    this.safeLog('info', `Edited incident ${incidentID} on status page ${slug}`);
    return response;
  }

  /** Resolve an incident: Uptime Kuma marks it inactive and unpins it. */
  async resolveIncident(slug: string, incidentID: number): Promise<ApiResponse & { incident?: Incident }> {
    const response = await this.request<{ incident?: Incident }>(
      'resolveIncident',
      [slug, incidentID],
      `Failed to resolve incident ${incidentID}`
    );
    this.safeLog('info', `Resolved incident ${incidentID} on status page ${slug}`);
    return response;
  }

  /** Delete an incident permanently. */
  async deleteIncident(slug: string, incidentID: number): Promise<ApiResponse> {
    const response = await this.request(
      'deleteIncident',
      [slug, incidentID],
      `Failed to delete incident ${incidentID}`
    );
    this.safeLog('info', `Deleted incident ${incidentID} from status page ${slug}`);
    return response;
  }

  /**
   * The status pages a maintenance window is shown on, as their IDs and titles (Uptime Kuma's
   * getMaintenanceStatusPage).
   */
  getMaintenanceStatusPages(maintenanceID: number): Promise<Array<{ id: number; title: string }>> {
    return this.readBack<{ statusPages?: Array<{ id: number; title: string }> }>(
      'getMaintenanceStatusPage',
      [maintenanceID],
      `the status pages of maintenance window ${maintenanceID}`
    ).then((response) => response.statusPages ?? []);
  }

  /**
   * Set the status pages a maintenance window is shown on. A full replace, like
   * setMonitorMaintenance: Uptime Kuma deletes every existing link first.
   */
  async setMaintenanceStatusPages(maintenanceID: number, statusPageIDs: number[]): Promise<ApiResponse> {
    const response = await this.request(
      'addMaintenanceStatusPage',
      [maintenanceID, statusPageIDs.map((id) => ({ id }))],
      `Failed to set status pages on maintenance window ${maintenanceID}`
    );
    this.safeLog('info', `Set ${statusPageIDs.length} status page(s) on maintenance window ${maintenanceID}`);
    return response;
  }

  // ─── Monitor history and statistics ─────────────────────────────────────────

  /**
   * Uptime buckets for the last `hours` (Uptime Kuma's getMonitorChartData): per minute up to 24
   * hours, per hour up to 720 (30 days), per day beyond, up to 365 days. Each bucket counts the
   * checks that came up and down in it, with their ping; buckets without checks are left out.
   */
  async getMonitorChartData(monitorID: number, hours: number): Promise<UptimeBucket[]> {
    const response = await this.readBack<{ data?: UptimeBucket[] }>(
      'getMonitorChartData',
      [monitorID, hours],
      `the uptime statistics of monitor ${monitorID}`
    );
    return response.data ?? [];
  }

  /**
   * Clear a monitor's event list (Uptime Kuma's clearEvents): every heartbeat's message is
   * blanked and none counts as a status change any more. Heartbeats and uptime are kept.
   */
  async clearEvents(monitorID: number): Promise<ApiResponse> {
    const response = await this.request(
      'clearEvents',
      [monitorID],
      `Failed to clear the events of monitor ${monitorID}`
    );
    this.safeLog('info', `Cleared the events of monitor ${monitorID}`);
    return response;
  }

  /**
   * Delete a monitor's heartbeats and uptime statistics (Uptime Kuma's clearHeartbeats). An
   * active monitor is restarted, so its history starts again with the next check.
   */
  async clearHeartbeats(monitorID: number): Promise<ApiResponse> {
    const response = await this.request(
      'clearHeartbeats',
      [monitorID],
      `Failed to clear the heartbeats of monitor ${monitorID}`
    );
    this.safeLog('info', `Cleared the heartbeats of monitor ${monitorID}`);
    return response;
  }

  /**
   * Delete the heartbeats and uptime statistics of every monitor (Uptime Kuma's
   * clearStatistics), and restart every active monitor.
   */
  async clearStatistics(): Promise<ApiResponse> {
    const response = await this.request('clearStatistics', [], 'Failed to clear statistics');
    this.safeLog('info', 'Cleared the heartbeats and statistics of every monitor');
    return response;
  }

  /**
   * Send a test message through a notification channel (Uptime Kuma's testNotification). It
   * takes the channel's whole config, not an ID, and sends "<name> Testing". Nothing is saved.
   */
  async testNotification(notification: Record<string, unknown>): Promise<ApiResponse> {
    return this.request('testNotification', [notification], 'Failed to send the test notification');
  }

  // ─── Proxies ─────────────────────────────────────────────────────────────────

  /** The proxies, as Uptime Kuma last pushed them (after login and after every change). */
  getProxyList(): KumaProxy[] {
    return this.proxyListCache;
  }

  /**
   * Create a proxy, or replace one (Uptime Kuma's addProxy with an ID). Every field is written
   * from what is sent, so an update must carry the stored values it keeps. applyExisting
   * attaches the proxy to every monitor; default makes it the one the web UI preselects.
   */
  async saveProxy(proxy: Record<string, unknown>, proxyID: number | null): Promise<ApiResponse & { id?: number }> {
    const response = await this.request<{ id?: number }>(
      'addProxy',
      [proxy, proxyID],
      proxyID === null ? 'Failed to create proxy' : `Failed to update proxy ${proxyID}`
    );
    this.safeLog('info', `Saved proxy ${response.id ?? proxyID}`);
    return response;
  }

  /** Delete a proxy. Monitors that used it are kept and go direct. */
  async deleteProxy(proxyID: number): Promise<ApiResponse> {
    const response = await this.request('deleteProxy', [proxyID], `Failed to delete proxy ${proxyID}`);
    this.safeLog('info', `Deleted proxy ${proxyID}`);
    this.clearMonitorReference('proxyId', proxyID);
    return response;
  }

  /**
   * Deleting a proxy or remote browser clears it from every monitor in the database
   * (`UPDATE monitor SET proxy_id = null …`), but Uptime Kuma pushes no new monitor list for it,
   * so the cached monitors would keep pointing at the deleted one. Mirror the change here.
   */
  private clearMonitorReference(field: 'proxyId' | 'remote_browser', id: number): void {
    for (const monitor of Object.values(this.monitorListCache) as Array<Record<string, unknown>>) {
      if (monitor[field] === id) monitor[field] = null;
    }
  }

  // ─── Remote browsers ────────────────────────────────────────────────────────

  /** The remote browsers, as Uptime Kuma last pushed them. */
  getRemoteBrowserList(): RemoteBrowser[] {
    return this.remoteBrowserListCache;
  }

  /** Create a remote browser, or replace one's name and URL (Uptime Kuma's addRemoteBrowser). */
  async saveRemoteBrowser(
    remoteBrowser: { name: string; url: string },
    remoteBrowserID: number | null
  ): Promise<ApiResponse & { id?: number }> {
    const response = await this.request<{ id?: number }>(
      'addRemoteBrowser',
      [remoteBrowser, remoteBrowserID],
      remoteBrowserID === null
        ? 'Failed to create remote browser'
        : `Failed to update remote browser ${remoteBrowserID}`
    );
    this.safeLog('info', `Saved remote browser ${response.id ?? remoteBrowserID}`);
    return response;
  }

  /** Delete a remote browser. Monitors that used it fall back to the built-in Chromium. */
  async deleteRemoteBrowser(remoteBrowserID: number): Promise<ApiResponse> {
    const response = await this.request(
      'deleteRemoteBrowser',
      [remoteBrowserID],
      `Failed to delete remote browser ${remoteBrowserID}`
    );
    this.safeLog('info', `Deleted remote browser ${remoteBrowserID}`);
    this.clearMonitorReference('remote_browser', remoteBrowserID);
    return response;
  }

  /** Check that Uptime Kuma can drive a browser at this WebSocket URL. Nothing is saved. */
  async testRemoteBrowser(url: string): Promise<ApiResponse> {
    return this.request('testRemoteBrowser', [{ url }], 'Failed to connect to the remote browser');
  }

  // ─── API keys ────────────────────────────────────────────────────────────────

  /** The API keys, as Uptime Kuma last pushed them: names and status, never the keys. */
  getAPIKeyList(): APIKey[] {
    return this.apiKeyListCache;
  }

  /**
   * Create an API key (Uptime Kuma's addAPIKey). The returned `key` is the only time the key
   * itself can be read. Creating one also turns on Uptime Kuma's apiKeysEnabled setting.
   */
  async addAPIKey(key: {
    name: string;
    active: boolean;
    expires: string | null;
  }): Promise<ApiResponse & { key?: string; keyID?: number }> {
    const response = await this.request<{ key?: string; keyID?: number }>(
      'addAPIKey',
      [key],
      'Failed to create API key'
    );
    this.safeLog('info', `Created API key ${response.keyID}`);
    return response;
  }

  /** Switch an API key off (disableAPIKey) or back on (enableAPIKey). */
  async setAPIKeyActive(keyID: number, active: boolean): Promise<ApiResponse> {
    const response = await this.request(
      active ? 'enableAPIKey' : 'disableAPIKey',
      [keyID],
      `Failed to ${active ? 'enable' : 'disable'} API key ${keyID}`
    );
    this.safeLog('info', `${active ? 'Enabled' : 'Disabled'} API key ${keyID}`);
    return response;
  }

  /** Delete an API key: requests using it are refused from then on. */
  async deleteAPIKey(keyID: number): Promise<ApiResponse> {
    const response = await this.request('deleteAPIKey', [keyID], `Failed to delete API key ${keyID}`);
    this.safeLog('info', `Deleted API key ${keyID}`);
    return response;
  }

  // ─── Socket accessor ─────────────────────────────────────────────────────────

  /**
   * Get the socket instance (for advanced usage)
   */
  getSocket(): Socket | null {
    return this.socket;
  }
}
