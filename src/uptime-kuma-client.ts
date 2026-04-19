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

      this.socket.on('connect_error', (error: Error) => {
        this.safeLog('error', `Connection error: ${error.message}`);
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
          this.safeLog('error', `Re-authentication failed: ${response.msg || 'unknown error'}`);
        }
      });
    } else if (username) {
      this.socket.emit('login', { username, password, token }, (response: LoginResponse) => {
        if (response.ok) {
          this.safeLog('info', 'Re-authenticated after reconnection');
        } else {
          this.safeLog('error', `Re-authentication failed: ${response.msg || 'unknown error'}`);
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
   * Set up event listeners for heartbeat updates
   * These listeners keep the cached heartbeat list in sync with the server
   */
  private setupHeartbeatListeners(): void {
    if (!this.socket) return;

    // Listen for the full heartbeat list (sent after login)
    this.socket.on('heartbeatList', (monitorID: number, heartbeatList: Heartbeat[], important?: boolean | number) => {
      // The heartbeatList event sends data per monitor, not all at once
      // Format: (monitorID, array of heartbeats, important flag)
      this.safeLog('debug', `Received heartbeatList for monitor ${monitorID}: ${heartbeatList.length} heartbeats`);
      this.heartbeatListCache[monitorID.toString()] = heartbeatList;
    });

    // Listen for individual heartbeat updates (real-time)
    this.socket.on('heartbeat', (heartbeat: Heartbeat) => {
      // The heartbeat event should always include monitorID
      if (!heartbeat.monitorID) {
        this.safeLog('warning', 'Received heartbeat without monitorID');
        return;
      }
      
      const monitorID = heartbeat.monitorID.toString();
      this.safeLog('debug', `Received heartbeat for monitor ${monitorID}: status=${heartbeat.status}, msg="${heartbeat.msg || ''}", ping=${heartbeat.ping || 'N/A'}ms`);
      
      // Initialize array for this monitor if it doesn't exist
      if (!this.heartbeatListCache[monitorID]) {
        this.heartbeatListCache[monitorID] = [];
      }
      
      // Add the new heartbeat to the beginning of the array
      this.heartbeatListCache[monitorID].unshift(heartbeat);
      
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
      
      // Get the most recent heartbeat for this monitor
      const heartbeats = this.heartbeatListCache[monitorID];
      const latestHeartbeat = heartbeats && heartbeats.length > 0 ? heartbeats[0] : undefined;
      
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
    this.socket.on('tagList', (tagList: Array<{ id: number; name: string; color: string }>) => {
      this.safeLog('debug', `Received tagList with ${tagList.length} tags`);
      this.tagListCache = tagList;
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
   * Create a new monitor
   *
   * @param monitorData - Monitor configuration (type-specific fields should be included)
   * @returns Promise resolving to the API response with the new monitorID
   */
  createMonitor(monitorData: Record<string, unknown>): Promise<ApiResponse & { monitorID?: number }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('add', monitorData, (response: ApiResponse & { monitorID?: number }) => {
        if (response.ok) {
          this.safeLog('info', `Successfully created monitor (ID: ${response.monitorID})`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to create monitor'));
        }
      });
    });
  }

  /**
   * Update an existing monitor
   *
   * @param monitorData - Monitor configuration including the id field
   * @returns Promise resolving to the API response
   */
  updateMonitor(monitorData: Record<string, unknown>): Promise<ApiResponse & { monitorID?: number }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('editMonitor', monitorData, (response: ApiResponse & { monitorID?: number }) => {
        if (response.ok) {
          this.safeLog('info', `Successfully updated monitor (ID: ${monitorData['id']})`);
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Failed to update monitor'));
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
   * Get the cached tag list
   */
  getTagList(): Array<{ id: number; name: string; color: string }> {
    return this.tagListCache;
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

  // ─── Socket accessor ─────────────────────────────────────────────────────────

  /**
   * Get the socket instance (for advanced usage)
   */
  getSocket(): Socket | null {
    return this.socket;
  }
}
