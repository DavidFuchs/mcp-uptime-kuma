import { io, Socket } from 'socket.io-client';
import fuzzysort from 'fuzzysort';
import type {
  MonitorBase,
  MonitorWithAdditionalFields,
  Monitor,
  ApiResponse,
  LoginResponse,
  GetMonitorResponse,
  MonitorList,
  Heartbeat,
  HeartbeatList,
  GetSettingsResponse,
  Settings,
} from './types.js';

/**
 * Uptime Kuma Socket.io API Client
 */
export class UptimeKumaClient {
  private socket: Socket | null = null;
  private url: string;
  private monitorListCache: MonitorList<true> = {};
  private heartbeatListCache: HeartbeatList<true> = {};
  private uptimeCache: { [monitorID: string]: { [periodKey: string]: number } } = {};
  private avgPingCache: { [monitorID: string]: number | null } = {};
  private server?: { sendLoggingMessage: (params: { level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'; data: unknown }) => Promise<void> };

  constructor(url: string, server?: { sendLoggingMessage: (params: { level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'; data: unknown }) => Promise<void> }) {
    this.url = url;
    this.server = server;
  }

  /**
   * Helper to safely log messages - only logs if server is available and connected
   */
  private async safeLog(level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency', data: string): Promise<void> {
    if (this.server) {
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
        reconnectionAttempts: 5,
      });

      this.socket.on('connect', () => {
        this.safeLog('info', 'Successfully connected to Uptime Kuma server');
        resolve();
      });

      this.socket.on('connect_error', (error: Error) => {
        this.safeLog('error', `Connection error: ${error.message}`);
        reject(new Error(`Connection failed: ${error.message}`));
      });
    });
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
      
      this.socket.disconnect();
      this.socket = null;
    }
    
    // Clear the caches
    this.monitorListCache = {};
    this.heartbeatListCache = {};
    this.uptimeCache = {};
    this.avgPingCache = {};
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

      // Set up listeners for monitor list and heartbeat updates before login
      this.setupMonitorListListeners();
      this.setupHeartbeatListeners();
      this.setupUptimeListeners();
      this.setupAvgPingListeners();

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
    this.socket.on('monitorList', (monitorList: MonitorList<true>) => {
      const monitorCount = Object.keys(monitorList).length;
      this.safeLog('debug', `Received monitorList with ${monitorCount} monitors`);
      this.monitorListCache = monitorList;
    });

    // Listen for updates to specific monitors
    this.socket.on('updateMonitorIntoList', (updates: MonitorList<true>) => {
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
   * @returns The monitor data with all fields, or undefined if not found
   */
  getMonitor(monitorID: number): MonitorWithAdditionalFields | undefined {
    const monitor = this.monitorListCache[monitorID.toString()];
    if (!monitor) return undefined;
    
    const monitorIDStr = monitorID.toString();
    
    // Merge uptime and avgPing data into the monitor object
    const uptime = this.uptimeCache[monitorIDStr];
    const avgPing = monitorIDStr in this.avgPingCache ? this.avgPingCache[monitorIDStr] : undefined;
    
    return {
      ...monitor,
      uptime: uptime || {},
      avgPing,
    };
  }

  /**
   * Get the cached full list of monitors the user has access to
   * The list is populated after login and kept up-to-date via server events
   * 
   * @returns The cached monitor list with all fields including uptime data
   */
  getMonitorList(): MonitorList<true> {
    const result: MonitorList<true> = {};
    
    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      const avgPing = monitorID in this.avgPingCache ? this.avgPingCache[monitorID] : undefined;
      
      result[monitorID] = {
        ...monitor,
        uptime: this.uptimeCache[monitorID] || {},
        avgPing,
      };
    }
    
    return result;
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
   * @param keywords - Optional space-separated keywords to filter by pathName (case-insensitive)
   * @returns Array of monitor summaries containing essential info and latest heartbeat status
   */
  getMonitorSummary(keywords?: string): Array<{
    id: number;
    name: string;
    pathName: string;
    active: boolean;
    maintenance: boolean;
    status?: number;
    msg?: string;
    uptime?: { [periodKey: string]: number };
    avgPing?: number | null;
  }> {
    const summaries = [];
    
    // Parse keywords into an array
    const keywordArray = keywords ? keywords.trim().split(/\s+/) : [];
    
    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      // Filter by keywords if provided using fuzzy matching
      if (keywordArray.length > 0) {
        const pathName = monitor.pathName;
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
      
      // Get the most recent heartbeat for this monitor
      const heartbeats = this.heartbeatListCache[monitorID];
      const latestHeartbeat = heartbeats && heartbeats.length > 0 ? heartbeats[0] : undefined;
      
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
      });
    }
    
    return summaries;
  }

  /**
   * Get the socket instance (for advanced usage)
   */
  getSocket(): Socket | null {
    return this.socket;
  }
}

/**
 * Utility function to filter a monitor object to only include defined fields
 * 
 * @param monitor - The monitor object with all fields
 * @returns The monitor object with only defined fields
 */
export function filterMonitorFields(monitor: MonitorWithAdditionalFields): MonitorBase {
  const filtered: MonitorBase = {
    id: monitor.id,
    name: monitor.name,
    type: monitor.type,
    interval: monitor.interval,
    retryInterval: monitor.retryInterval,
    resendInterval: monitor.resendInterval,
    maxretries: monitor.maxretries,
    active: monitor.active,
    pathName: monitor.pathName,
    maintenance: monitor.maintenance,
  };

  // Add optional fields if they exist
  if (monitor.url !== undefined) filtered.url = monitor.url;
  if (monitor.method !== undefined) filtered.method = monitor.method;
  if (monitor.hostname !== undefined) filtered.hostname = monitor.hostname;
  if (monitor.port !== undefined) filtered.port = monitor.port;
  if (monitor.tags !== undefined) filtered.tags = monitor.tags;
  if (monitor.notificationIDList !== undefined) filtered.notificationIDList = monitor.notificationIDList;
  if (monitor.accepted_statuscodes_json !== undefined) filtered.accepted_statuscodes_json = monitor.accepted_statuscodes_json;
  if (monitor.conditions !== undefined) filtered.conditions = monitor.conditions;
  if (monitor.uptime !== undefined) filtered.uptime = monitor.uptime;
  if (monitor.avgPing !== undefined) filtered.avgPing = monitor.avgPing;

  return filtered;
}
