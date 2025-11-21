import { io, Socket } from 'socket.io-client';
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
} from './types.js';

/**
 * Uptime Kuma Socket.io API Client
 */
export class UptimeKumaClient {
  private socket: Socket | null = null;
  private url: string;
  private monitorListCache: MonitorList<true> = {};
  private heartbeatListCache: HeartbeatList<true> = {};

  constructor(url: string) {
    this.url = url;
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
        resolve();
      });

      this.socket.on('connect_error', (error: Error) => {
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
  }

  /**
   * Login using username and password
   * 
   * @param username - Username (can be empty string)
   * @param password - Password/API key
   * @param token - Optional 2FA token if required
   * @returns Promise resolving to the login response
   */
  login(username: string, password: string, token?: string): Promise<LoginResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      const loginData: { username: string; password: string; token?: string } = {
        username,
        password
      };
      
      if (token) {
        loginData.token = token;
      }

      // Set up listeners for monitor list and heartbeat updates before login
      this.setupMonitorListListeners();
      this.setupHeartbeatListeners();

      this.socket.emit('login', loginData, (response: LoginResponse) => {
        if (response.ok) {
          resolve(response);
        } else {
          reject(new Error(response.msg || 'Login failed'));
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
      this.monitorListCache = monitorList;
    });

    // Listen for updates to specific monitors
    this.socket.on('updateMonitorIntoList', (updates: MonitorList<true>) => {
      Object.assign(this.monitorListCache, updates);
    });

    // Listen for monitor deletions
    this.socket.on('deleteMonitorFromList', (monitorID: number) => {
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
      console.error(`Received heartbeatList for monitor ${monitorID}:`, heartbeatList.length, 'heartbeats');
      this.heartbeatListCache[monitorID.toString()] = heartbeatList;
    });

    // Listen for individual heartbeat updates (real-time)
    this.socket.on('heartbeat', (heartbeat: Heartbeat) => {
      // The heartbeat event should always include monitorID
      if (!heartbeat.monitorID) {
        console.error('Received heartbeat without monitorID:', heartbeat);
        return;
      }
      
      const monitorID = heartbeat.monitorID.toString();
      
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
   * Get a specific monitor by ID from the cache
   * 
   * @param monitorID - The ID of the monitor to retrieve
   * @returns The monitor data with all fields, or undefined if not found
   */
  getMonitor(monitorID: number): MonitorWithAdditionalFields | undefined {
    return this.monitorListCache[monitorID.toString()];
  }

  /**
   * Get the cached full list of monitors the user has access to
   * The list is populated after login and kept up-to-date via server events
   * 
   * @returns The cached monitor list with all fields
   */
  getMonitorList(): MonitorList<true> {
    return this.monitorListCache;
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
  }> {
    const summaries = [];
    
    // Parse keywords into an array
    const keywordArray = keywords ? keywords.trim().split(/\s+/).map(k => k.toLowerCase()) : [];
    
    for (const [monitorID, monitor] of Object.entries(this.monitorListCache)) {
      // Filter by keywords if provided
      if (keywordArray.length > 0) {
        const pathNameLower = monitor.pathName.toLowerCase();
        const matchesAllKeywords = keywordArray.every(keyword => pathNameLower.includes(keyword));
        if (!matchesAllKeywords) {
          continue;
        }
      }
      
      // Get the most recent heartbeat for this monitor
      const heartbeats = this.heartbeatListCache[monitorID];
      const latestHeartbeat = heartbeats && heartbeats.length > 0 ? heartbeats[0] : undefined;
      
      summaries.push({
        id: monitor.id,
        name: monitor.name,
        pathName: monitor.pathName,
        active: monitor.active,
        maintenance: monitor.maintenance,
        status: latestHeartbeat?.status,
        msg: latestHeartbeat?.msg,
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

  return filtered;
}
