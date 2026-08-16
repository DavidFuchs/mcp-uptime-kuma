import { io, Socket } from 'socket.io-client';
import fuzzysort from 'fuzzysort';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import type {
  MonitorBase,
  MonitorBaseWithExtendedData,
  MonitorWithExtendedData,
  MonitorRawData,
  Monitor,
  ApiResponse,
  LoginResponse,
  GetMonitorResponse,
  MonitorList,
  MonitorSummary,
  Heartbeat,
  HeartbeatList,
  GetSettingsResponse,
  Settings,
  Notification,
  Maintenance,
  StatusPage,
  DockerHost,
} from './types/index.js';

/**
 * How long a post-write read-back waits for the server's acknowledgement before giving up.
 * Generous — this is a single indexed row and the only thing being guarded against is an
 * acknowledgement that never comes at all.
 */
const FETCH_MONITOR_TIMEOUT_MS = 10_000;

/**
 * Helper function to filter a MonitorWithExtendedData down to MonitorBaseWithExtendedData
 * Strips out type-specific fields while keeping common fields and runtime data
 */
function filterToBaseWithExtendedData(monitor: MonitorWithExtendedData): MonitorBaseWithExtendedData {
  // Extract all MonitorBase fields plus runtime data
  const {
    id, name, description, type, active, parent, weight,
    interval, retryInterval, resendInterval, timeout,
    maxretries, upsideDown, accepted_statuscodes,
    notificationIDList, tags,
    user_id, maintenance, path, pathName, childrenIDs, forceInactive, includeSensitiveData,
    uptime, avgPing
  } = monitor;
  
  return {
    id, name, description, type, active, parent, weight,
    interval, retryInterval, resendInterval, timeout,
    maxretries, upsideDown, accepted_statuscodes,
    notificationIDList, tags,
    user_id, maintenance, path, pathName, childrenIDs, forceInactive, includeSensitiveData,
    uptime, avgPing
  } as MonitorBaseWithExtendedData;
}

/**
 * Does `monitor` satisfy a `parentId` filter? Direct children only, matching Uptime Kuma's
 * own `parent` column — a grandchild belongs to its immediate group, not to the one above it.
 *
 * The distinction this exists to protect: `undefined` means "no parent filter" while `null` is
 * a real, requestable value meaning "top level only". A truthiness check (`if (parentId)`)
 * conflates them AND silently drops group 0, so the branch is written out longhand.
 *
 * Shared by getMonitorList and getMonitorSummary. Both keep their own copy of the surrounding
 * filter loop, and the parent filter reaching only the first of them is exactly what had to be
 * fixed here — so the subtle half lives in one place rather than being copied a second time.
 */
function matchesParentFilter(monitor: { parent?: number | null }, parentId: number | null | undefined): boolean {
  if (parentId === undefined) return true;
  const wanted = parentId === null ? null : Number(parentId);
  const actual = monitor.parent === null || monitor.parent === undefined ? null : Number(monitor.parent);
  return actual === wanted;
}

/**
 * Uptime Kuma Socket.io API Client
 */
export class UptimeKumaClient {
  private socket: Socket | null = null;
  private url: string;
  private monitorListCache: { [monitorID: string]: MonitorRawData } = {};
  private heartbeatListCache: HeartbeatList<true> = {};
  private uptimeCache: { [monitorID: string]: { [periodKey: string]: number } } = {};
  private avgPingCache: { [monitorID: string]: number | null } = {};
  private notificationListCache: { [id: string]: Notification } = {};
  private tagListCache: Array<{ id: number; name: string; color: string }> = [];
  private maintenanceListCache: { [id: string]: Maintenance } = {};
  private statusPageListCache: { [slug: string]: StatusPage } = {};
  private dockerHostListCache: DockerHost[] = [];
  private server?: { sendLoggingMessage: (params: { level: LoggingLevel; data: unknown }) => Promise<void> };
  private shouldLog: (level: LoggingLevel) => boolean;
  private loginCredentials: { username: string | undefined; password: string | undefined; token?: string; jwtToken?: string } | null = null;

  /**
   * Invoked whenever the authenticated session is known to be gone — the socket dropped, or
   * a re-auth on reconnect was refused. The server layer uses this to clear its
   * `isAuthenticated` flag so the next tool call re-authenticates instead of failing.
   */
  public onAuthLost: ((reason: string) => void) | null = null;

  constructor(
    url: string, 
    server?: { sendLoggingMessage: (params: { level: LoggingLevel; data: unknown }) => Promise<void> },
    shouldLog?: (level: LoggingLevel) => boolean
  ) {
    this.url = url;
    this.server = server;
    this.shouldLog = shouldLog || (() => true); // Default: log everything
  }

  /**
   * Helper to safely log messages - only logs if server is available, connected, and level is enabled
   */
  private async safeLog(level: LoggingLevel, data: string): Promise<void> {
    if (this.server && this.shouldLog(level)) {
      try {
        await this.server.sendLoggingMessage({ level, data });
      } catch (error) {
        // Silently ignore logging errors to prevent breaking the application
        // This handles the case where server is not yet connected to transport
      }
    }
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
      this.socket.emit('loginByToken', jwtToken, (response: LoginResponse) => {
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
      this.socket.emit('login', { username, password, token }, (response: LoginResponse) => {
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
      // Remove event listeners
      this.socket.off('monitorList');
      this.socket.off('updateMonitorIntoList');
      this.socket.off('deleteMonitorFromList');
      this.socket.off('heartbeatList');
      this.socket.off('heartbeat');
      this.socket.off('notificationList');
      this.socket.off('tagList');
      this.socket.off('maintenanceList');
      this.socket.off('statusPageList');
      this.socket.off('dockerHostList');

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
  login(username: string | undefined, password: string | undefined, token?: string, jwtToken?: string): Promise<LoginResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      // Store credentials for re-authentication on reconnect
      this.loginCredentials = { username, password, token, jwtToken };

      // Set up listeners for monitor list and heartbeat updates before login
      this.setupMonitorListListeners();
      this.setupHeartbeatListeners();
      this.setupUptimeListeners();
      this.setupAvgPingListeners();
      this.setupNotificationListListeners();
      this.setupTagListListeners();
      this.setupMaintenanceListListeners();
      this.setupStatusPageListListeners();
      this.setupDockerHostListListeners();

      // If JWT token is provided, use token-based authentication
      if (jwtToken) {
        this.socket.emit('loginByToken', jwtToken, (response: LoginResponse) => {
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
        token
      };
      
      if ( !loginData.username ) {
        this.socket.emit('login');
        resolve({ ok: true, tokenRequired: false });
      } else {
        this.socket.emit('login', loginData, (response: LoginResponse) => {
          if (response.ok) {
            resolve(response);
          } else {
            reject(new Error(response.msg || 'Login failed'));
          }
        });
      }
    });
  }

  getSettings(): Promise<GetSettingsResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('getSettings', (response: GetSettingsResponse) => {
        if (response.ok && response.data) {
          // Filter out sensitive fields like steamAPIKey
          const { steamAPIKey, ...filteredData } = response.data as any;
          this.safeLog('debug', 'Successfully retrieved settings from Uptime Kuma');
          resolve({ ...response, data: filteredData as Settings });
        } else if (response.ok) {
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to get settings'));
        }
      });
    });
  }

  /**
   * Pause a monitor
   * 
   * @param monitorID - The ID of the monitor to pause
   * @returns Promise resolving to the API response
   */
  pauseMonitor(monitorID: number): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('pauseMonitor', monitorID, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully paused monitor ${monitorID}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to pause monitor'));
        }
      });
    });
  }

  /**
   * Resume a monitor
   * 
   * @param monitorID - The ID of the monitor to resume
   * @returns Promise resolving to the API response
   */
  resumeMonitor(monitorID: number): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('resumeMonitor', monitorID, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully resumed monitor ${monitorID}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to resume monitor'));
        }
      });
    });
  }

  /**
   * Set up event listeners for monitor list updates
   * These listeners keep the cached monitor list in sync with the server
   */
  private setupMonitorListListeners(): void {
    if (!this.socket) return;

    // Listen for the full monitor list (sent after login or on major changes)
    this.socket.on('monitorList', (monitorList: { [monitorID: string]: any }) => {
      const monitorCount = Object.keys(monitorList).length;
      this.safeLog('debug', `Received monitorList with ${monitorCount} monitors`);
      this.monitorListCache = monitorList as { [monitorID: string]: MonitorRawData };
    });

    // Listen for updates to specific monitors
    this.socket.on('updateMonitorIntoList', (updates: { [monitorID: string]: any }) => {
      const updateCount = Object.keys(updates).length;
      const monitorIDs = Object.keys(updates).join(', ');
      this.safeLog('debug', `Received updateMonitorIntoList for ${updateCount} monitor(s): ${monitorIDs}`);
      Object.assign(this.monitorListCache, updates as { [monitorID: string]: MonitorRawData });
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
  static normaliseBeats(list: Heartbeat[]): Heartbeat[] {
    const seen = new Set<string>();
    const deduped: Heartbeat[] = [];
    for (const beat of list) {
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
    this.socket.on('heartbeatList', (monitorID: number, heartbeatList: Heartbeat[], overwrite?: boolean) => {
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
    this.socket.on('heartbeat', (heartbeat: Heartbeat) => {
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
      this.safeLog('debug', `Received heartbeat for monitor ${monitorID}: status=${heartbeat.status}, msgLength=${msgLength}, ping=${heartbeat.ping || 'N/A'}ms`);


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
  getMonitor<T extends boolean = true>(monitorID: number, includeTypeSpecificFields?: T): T extends true ? MonitorWithExtendedData | undefined : MonitorBaseWithExtendedData | undefined {
    const rawMonitor = this.monitorListCache[monitorID.toString()];
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
      return filterToBaseWithExtendedData(fullMonitor) as any;
    }
    
    return fullMonitor as any;
  }

  /**
   * Get the cached full list of monitors the user has access to
   * The list is populated after login and kept up-to-date via server events
   * 
   * @param filters - Optional filter criteria
   * @returns The cached monitor list
   */
  getMonitorList<T extends boolean = true>(filters?: {
    keywords?: string;
    type?: string;
    active?: boolean;
    maintenance?: boolean;
    tags?: string;
    parentId?: number | null;
    includeTypeSpecificFields?: T;
  }): MonitorList<T> {
    const result: MonitorList<true> = {};

    // Parse keywords into an array
    const keywordArray = filters?.keywords ? filters.keywords.trim().split(/\s+/) : [];

    // Parse type filter from comma-separated string
    const typeFilter = filters?.type ? filters.type.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

    // Parse tag filter from comma-separated string
    const tagFilter = filters?.tags ? filters.tags.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      // Filter by parent group — direct children only, matching Uptime Kuma's `parent` column
      if (!matchesParentFilter(monitor, filters?.parentId)) {
        continue;
      }

    // Filter by keywords if provided using fuzzy matching
    if (keywordArray.length > 0) {
      const pathName = monitor.pathName || '';
      const matchesAllKeywords = keywordArray.every(keyword => {
        const result = fuzzysort.single(keyword, pathName);
          return result && result.score > 0.3;
        });
        if (!matchesAllKeywords) {
          continue;
        }
      }
      
      // Filter by type
      if (typeFilter.length > 0 && !typeFilter.includes(monitor.type)) {
        continue;
      }
      
      // Filter by active status
      if (filters?.active !== undefined && monitor.active !== filters.active) {
        continue;
      }
      
      // Filter by maintenance status
      if (filters?.maintenance !== undefined && monitor.maintenance !== filters.maintenance) {
        continue;
      }
      
      // Filter by tags (name and optional value)
      if (tagFilter.length > 0) {
        const monitorTags = monitor.tags || [];
        const hasAllTags = tagFilter.every(tagFilter => {
          // Parse tag filter as 'name' or 'name=value'
          const [filterName, filterValue] = tagFilter.split('=').map(s => s.trim().toLowerCase());
          
          return monitorTags.some(tag => {
            const tagNameMatches = tag.name.toLowerCase() === filterName;
            
            // If no value specified in filter, just match name
            if (filterValue === undefined) {
              return tagNameMatches;
            }
            
            // If value specified, match both name and value
            const tagValue = tag.value?.toLowerCase() || '';
            return tagNameMatches && tagValue === filterValue;
          });
        });
        
        if (!hasAllTags) {
          continue;
        }
      }
      
      const avgPing = monitorID in this.avgPingCache ? this.avgPingCache[monitorID] : undefined;
      
      const fullMonitor: MonitorWithExtendedData = {
        ...monitor,
        uptime: this.uptimeCache[monitorID] || {},
        avgPing,
      } as MonitorWithExtendedData;
      
      // If includeTypeSpecificFields is false, filter to base fields only (excluding type-specific fields)
      if (filters?.includeTypeSpecificFields === false) {
        result[monitorID] = filterToBaseWithExtendedData(fullMonitor) as any;
      } else {
        result[monitorID] = fullMonitor as any;
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
      result[monitorID] = heartbeats.slice(0, maxHeartbeats);
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
    
    return heartbeats.slice(0, maxHeartbeats);
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
    return heartbeats && heartbeats.length > 0 ? heartbeats[0] : undefined;
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
  fetchImportantHeartbeats(monitorID: number, count: number = 25, offset: number = 0): Promise<Heartbeat[]> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit(
        'monitorImportantHeartbeatListPaged',
        monitorID,
        offset,
        count,
        (response: ApiResponse & { data?: Heartbeat[] }) => {
          if (response && response.ok) {
            resolve(UptimeKumaClient.normaliseBeats(response.data || []));
          } else {
            reject(new Error(response?.msg || 'Failed to fetch important heartbeats'));
          }
        }
      );
    });
  }

  /**
   * Get a summarized list of all monitors with their most recent heartbeat status
   * 
   * @param filters - Optional filter criteria
   * @returns Array of monitor summaries containing essential info and latest heartbeat status
   */
  getMonitorSummary(filters?: {
    keywords?: string;
    type?: string;
    active?: boolean;
    maintenance?: boolean;
    tags?: string;
    parentId?: number | null;
    status?: string;
  }): MonitorSummary[] {
    const summaries = [];
    
    // Parse keywords into an array
    const keywordArray = filters?.keywords ? filters.keywords.trim().split(/\s+/) : [];
    
    // Parse type filter from comma-separated string
    const typeFilter = filters?.type ? filters.type.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
    
    // Parse tag filter from comma-separated string
    const tagFilter = filters?.tags ? filters.tags.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
    
    // Parse status filter from comma-separated string
    const statusFilter = filters?.status ? filters.status.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)) : [];
    
    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      // Filter by parent group — direct children only, matching Uptime Kuma's `parent` column
      if (!matchesParentFilter(monitor, filters?.parentId)) {
        continue;
      }

      // Filter by keywords if provided using fuzzy matching
      if (keywordArray.length > 0) {
        const pathName = monitor.pathName || '';
        // All keywords must match with a reasonable score
        const matchesAllKeywords = keywordArray.every(keyword => {
          const result = fuzzysort.single(keyword, pathName);
          // Accept matches with score > 0.3 (0 = no match, 1 = perfect match)
          return result && result.score > 0.3;
        });
        if (!matchesAllKeywords) {
          continue;
        }
      }
      
      // Filter by type
      if (typeFilter.length > 0 && !typeFilter.includes(monitor.type)) {
        continue;
      }
      
      // Filter by active status
      if (filters?.active !== undefined && monitor.active !== filters.active) {
        continue;
      }
      
      // Filter by maintenance status
      if (filters?.maintenance !== undefined && monitor.maintenance !== filters.maintenance) {
        continue;
      }
      
      // Filter by tags (name and optional value)
      if (tagFilter.length > 0) {
        const monitorTags = monitor.tags || [];
        const hasAllTags = tagFilter.every(tagFilter => {
          // Parse tag filter as 'name' or 'name=value'
          const [filterName, filterValue] = tagFilter.split('=').map(s => s.trim().toLowerCase());
          
          return monitorTags.some(tag => {
            const tagNameMatches = tag.name.toLowerCase() === filterName;
            
            // If no value specified in filter, just match name
            if (filterValue === undefined) {
              return tagNameMatches;
            }
            
            // If value specified, match both name and value
            const tagValue = tag.value?.toLowerCase() || '';
            return tagNameMatches && tagValue === filterValue;
          });
        });
        
        if (!hasAllTags) {
          continue;
        }
      }
      
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
    this.socket.on('notificationList', (notificationList: { [id: string]: any }) => {
      this.safeLog('debug', `Received notificationList with ${Object.keys(notificationList).length} notifications`);
      this.notificationListCache = notificationList as { [id: string]: Notification };
    });
  }

  private setupTagListListeners(): void {
    if (!this.socket) return;
    this.socket.on('tagList', (tagList: { [id: string]: { id: number; name: string; color: string } } | Array<{ id: number; name: string; color: string }>) => {
      const tags = Array.isArray(tagList) ? tagList : Object.values(tagList);
      this.safeLog('debug', `Received tagList with ${tags.length} tags`);
      this.tagListCache = tags;
    });
  }

  private setupMaintenanceListListeners(): void {
    if (!this.socket) return;
    this.socket.on('maintenanceList', (maintenanceList: { [id: string]: any }) => {
      this.safeLog('debug', `Received maintenanceList with ${Object.keys(maintenanceList).length} windows`);
      this.maintenanceListCache = maintenanceList as { [id: string]: Maintenance };
    });
  }

  private setupStatusPageListListeners(): void {
    if (!this.socket) return;
    this.socket.on('statusPageList', (statusPageList: { [slug: string]: any }) => {
      this.safeLog('debug', `Received statusPageList with ${Object.keys(statusPageList).length} status pages`);
      this.statusPageListCache = statusPageList as { [slug: string]: StatusPage };
    });
  }

  private setupDockerHostListListeners(): void {
    if (!this.socket) return;
    this.socket.on('dockerHostList', (dockerHostList: DockerHost[]) => {
      this.safeLog('debug', `Received dockerHostList with ${dockerHostList.length} docker hosts`);
      this.dockerHostListCache = dockerHostList;
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

    const response = await new Promise<ApiResponse & { monitorID?: number }>((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('add', payload, (res: ApiResponse & { monitorID?: number }) => {
        if (res.ok) {
          this.safeLog('info', `Successfully created monitor (ID: ${res.monitorID})`);
          resolve(res);
        } else {
          reject(new Error(res.msg || 'Failed to create monitor'));
        }
      });
    });

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

    const response = await new Promise<ApiResponse & { monitorID?: number }>((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('editMonitor', payload, (res: ApiResponse & { monitorID?: number }) => {
        if (res.ok) {
          this.safeLog('info', `Successfully updated monitor (ID: ${monitorData['id']})`);
          resolve(res);
        } else {
          reject(new Error(res.msg || 'Failed to update monitor'));
        }
      });
    });

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
  private fetchTagList(): Promise<Array<{ id: number; name: string; color: string }>> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }
      this.socket.emit('getTags', (res: ApiResponse & { tags?: Array<{ id: number; name: string; color: string }> }) => {
        if (res.ok && res.tags) {
          this.tagListCache = res.tags;
          resolve(res.tags);
        } else {
          reject(new Error(res.msg || 'Failed to fetch tag list'));
        }
      });
    });
  }

  /**
   * Bind a tag to a monitor (socket: `addMonitorTag`).
   */
  private addMonitorTag(tagID: number, monitorID: number, value: string): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }
      this.socket.emit('addMonitorTag', tagID, monitorID, value, (res: ApiResponse) => {
        if (res.ok) resolve(res);
        else reject(new Error(res.msg || `Failed to add tag ${tagID} to monitor ${monitorID}`));
      });
    });
  }

  /**
   * Unbind a tag from a monitor (socket: `deleteMonitorTag`).
   */
  private deleteMonitorTag(tagID: number, monitorID: number, value: string): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }
      this.socket.emit('deleteMonitorTag', tagID, monitorID, value, (res: ApiResponse) => {
        if (res.ok) resolve(res);
        else reject(new Error(res.msg || `Failed to remove tag ${tagID} from monitor ${monitorID}`));
      });
    });
  }

  /**
   * Reconcile a monitor's tags against the desired list. Auto-creates any
   * tag name that isn't yet in the catalog. Tag identity is `(name, value)`.
   */
  private async reconcileMonitorTags(
    monitorID: number,
    desiredTags: Array<Record<string, unknown>>
  ): Promise<void> {
    const currentMonitor = this.monitorListCache[String(monitorID)];
    const currentTags = (currentMonitor?.tags ?? []) as Array<{
      tag_id?: number;
      name: string;
      value?: string;
      color?: string;
    }>;

    const key = (name: string, value: string | undefined) => `${name}\u0000${value ?? ''}`;
    const currentKeys = new Set(currentTags.map((t) => key(t.name, t.value)));
    const desiredKeys = new Set(
      desiredTags.map((t) => key(String(t.name), t.value as string | undefined))
    );

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
        const color = (t.color as string | undefined) ??
          freshTags.find((ft) => ft.name === name)?.color ?? '#808080';
        return { tag_id: tagID, name, value, color };
      });
      (this.monitorListCache[String(monitorID)] as any).tags = updatedTags;
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
  fetchMonitor(monitorID: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(
          new Error(
            `Timed out after ${FETCH_MONITOR_TIMEOUT_MS}ms waiting for the server to return monitor ${monitorID}`
          )
        );
      }, FETCH_MONITOR_TIMEOUT_MS);

      this.socket.emit('getMonitor', monitorID, (response: ApiResponse & { monitor?: Record<string, unknown> }) => {
        if (settled) return;
        clearTimeout(timer);
        if (response && response.ok && response.monitor) {
          resolve(response.monitor);
        } else {
          reject(new Error((response && response.msg) || `Failed to fetch monitor ${monitorID}`));
        }
      });
    });
  }

  /**
   * Delete a monitor
   *
   * @param monitorID - The ID of the monitor to delete
   * @returns Promise resolving to the API response
   */
  deleteMonitor(monitorID: number): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('deleteMonitor', monitorID, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully deleted monitor ${monitorID}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to delete monitor'));
        }
      });
    });
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
  addNotification(notification: Record<string, unknown>, notificationID?: number): Promise<ApiResponse & { id?: number }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      const id = notificationID ?? null;
      this.socket.emit('addNotification', notification, id, (response: ApiResponse & { id?: number }) => {
        if (response.ok) {
          this.safeLog('info', `Successfully saved notification (ID: ${response.id})`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to save notification'));
        }
      });
    });
  }

  /**
   * Delete a notification channel
   *
   * @param notificationID - The ID of the notification to delete
   * @returns Promise resolving to the API response
   */
  deleteNotification(notificationID: number): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('deleteNotification', notificationID, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully deleted notification ${notificationID}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to delete notification'));
        }
      });
    });
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
  addDockerHost(dockerHost: Record<string, unknown>, dockerHostID?: number): Promise<ApiResponse & { id?: number }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      const id = dockerHostID ?? null;
      this.socket.emit('addDockerHost', dockerHost, id, (response: ApiResponse & { id?: number }) => {
        if (response.ok) {
          this.safeLog('info', `Successfully saved docker host (ID: ${response.id})`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to save docker host'));
        }
      });
    });
  }

  /**
   * Delete a docker host. Any monitors referencing it will have their docker_host
   * field cleared by Uptime Kuma.
   *
   * @param dockerHostID - The ID of the docker host to delete
   * @returns Promise resolving to the API response
   */
  deleteDockerHost(dockerHostID: number): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('deleteDockerHost', dockerHostID, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully deleted docker host ${dockerHostID}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to delete docker host'));
        }
      });
    });
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

      this.socket.emit('testDockerHost', dockerHost, (response: ApiResponse) => {
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
  addTag(name: string, color: string): Promise<ApiResponse & { tag?: { id: number; name: string; color: string } }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('addTag', { name, color }, (response: ApiResponse & { tag?: { id: number; name: string; color: string } }) => {
        if (response.ok) {
          this.safeLog('info', `Successfully created tag "${name}" (ID: ${response.tag?.id})`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to create tag'));
        }
      });
    });
  }

  /**
   * Delete a tag
   *
   * @param tagID - The ID of the tag to delete
   * @returns Promise resolving to the API response
   */
  deleteTag(tagID: number): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('deleteTag', tagID, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully deleted tag ${tagID}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to delete tag'));
        }
      });
    });
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
  createMaintenance(maintenanceData: Record<string, unknown>): Promise<ApiResponse & { maintenanceID?: number }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('addMaintenance', maintenanceData, (response: ApiResponse & { maintenanceID?: number }) => {
        if (response.ok) {
          this.safeLog('info', `Successfully created maintenance window (ID: ${response.maintenanceID})`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to create maintenance window'));
        }
      });
    });
  }

  // ─── Status page operations ─────────────────────────────────────────────────

  /**
   * Get the cached status page list
   */
  getStatusPageList(): StatusPage[] {
    return Object.values(this.statusPageListCache);
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
  async getStatusPage(slug: string): Promise<ApiResponse & {
    config?: StatusPage;
    publicGroupList?: unknown[];
    incidents?: unknown[];
  }> {
    try {
      const baseUrl = this.url.replace(/\/$/, '');
      const res = await fetch(`${baseUrl}/api/status-page/${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        return { ok: false, msg: `Status page ${slug} not found` };
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json() as {
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
      throw new Error(`Failed to get status page ${slug}: ${msg}`);
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
  createStatusPage(title: string, slug: string): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('addStatusPage', title, slug, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully created status page ${slug}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || `Failed to create status page ${slug}`));
        }
      });
    });
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
  updateStatusPage(
    slug: string,
    config: Record<string, unknown>,
    publicGroupList: Array<Record<string, unknown>> = [],
    imgDataUrl: string = ''
  ): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('saveStatusPage', slug, config, imgDataUrl, publicGroupList, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully updated status page ${slug}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || `Failed to update status page ${slug}`));
        }
      });
    });
  }

  /**
   * Delete a status page
   *
   * @param slug - The status page slug
   * @returns Promise resolving to the API response
   */
  deleteStatusPage(slug: string): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('deleteStatusPage', slug, (response: ApiResponse) => {
        if (response.ok) {
          this.safeLog('info', `Successfully deleted status page ${slug}`);
          resolve(response);
        } else {
          reject(new Error(response.msg || `Failed to delete status page ${slug}`));
        }
      });
    });
  }

  // ─── Socket accessor ─────────────────────────────────────────────────────────

  /**
   * Get the socket instance (for advanced usage)
   */
  getSocket(): Socket | null {
    return this.socket;
  }
}
