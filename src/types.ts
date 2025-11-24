import { z } from 'zod';

/**
 * Configuration interface for Uptime Kuma
 */
export interface UptimeKumaConfig {
  url: string;
  username: string | undefined;
  password: string | undefined;
  token: string | undefined;
  jwtToken: string | undefined;
  readWriteEnabled: boolean;
}

/**
 * Zod schema for Monitor tag object
 */
const MonitorTagSchema = z.object({
  tag_id: z.number(),
  monitor_id: z.number(),
  value: z.string().nullable(),
  name: z.string(),
  color: z.string(),
});

/**
 * Zod schema for Base Monitor Object structure from Uptime Kuma (defined fields only)
 */
export const MonitorBaseSchema = z.object({
  id: z.number().describe('Unique monitor ID'),
  name: z.string().describe('Display name of the monitor'),
  type: z.string().describe('Monitor type (e.g., "http", "ping", "dns", etc.)'),
  url: z.string().optional().describe('URL to monitor (for HTTP/HTTPS monitors)'),
  method: z.string().optional().describe('HTTP method (GET, POST, etc.)'),
  interval: z.number().describe('Check interval in seconds'),
  retryInterval: z.number().describe('Retry interval in seconds when check fails'),
  resendInterval: z.number().describe('Resend notification interval in seconds'),
  maxretries: z.number().describe('Maximum number of retries before marking as down'),
  hostname: z.string().nullable().optional().describe('Hostname for port/ping monitors'),
  port: z.number().nullable().optional().describe('Port number for port monitors'),
  active: z.boolean().describe('Whether the monitor is currently active/enabled'),
  tags: z.array(MonitorTagSchema).optional().describe('Tags associated with this monitor'),
  notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Map of notification IDs to enabled state'),
  accepted_statuscodes_json: z.string().optional().describe('JSON string of accepted HTTP status codes'),
  conditions: z.array(z.any()).optional().describe('Monitor conditions (for advanced monitor types)'),
  pathName: z.string().describe('Full path name including parent groups (e.g., "Group / Monitor Name")'),
  maintenance: z.boolean().describe('Whether the monitor is currently in maintenance mode'),
  uptime: z.record(z.string(), z.number()).optional().describe('Map of period keys ("24", "720", "1y") to uptime percentages'),
  avgPing: z.number().nullable().optional().describe('24-hour average ping time in milliseconds'),
});

/**
 * Base Monitor type inferred from the Zod schema
 */
export type MonitorBase = z.infer<typeof MonitorBaseSchema>;

/**
 * Monitor with additional fields (includes all Uptime Kuma fields)
 */
export interface MonitorWithAdditionalFields extends MonitorBase {
  [key: string]: any; // Other monitor-type specific fields
}

/**
 * Monitor type - can include or exclude additional fields based on includeAdditionalFields option
 */
export type Monitor<T extends boolean = true> = T extends true 
  ? MonitorWithAdditionalFields 
  : MonitorBase;

/**
 * Response structure for API callbacks
 */
export interface ApiResponse {
  ok: boolean;
  msg?: string;
  msgi18n?: boolean;
}

/**
 * Login response
 */
export interface LoginResponse extends ApiResponse {
  token?: string;
  tokenRequired?: boolean;
}

/**
 * Zod schema for Uptime Kuma settings
 */
export const SettingsSchema = z.object({
  serverTimezone: z.string(),
  checkUpdate: z.boolean(),
  searchEngineIndex: z.boolean(),
  entryPage: z.string(),
  dnsCache: z.boolean(),
  keepDataPeriodDays: z.number(),
  tlsExpiryNotifyDays: z.array(z.number()),
  trustProxy: z.boolean(),
  nscd: z.boolean(),
  disableAuth: z.boolean(),
  primaryBaseURL: z.string().optional(),
});

/**
 * Settings type inferred from the Zod schema
 */
export type Settings = z.infer<typeof SettingsSchema>;

/*
 * Get settings response
*/
export interface GetSettingsResponse extends ApiResponse {
  data?: Settings;
}

/**
 * Get monitor response
 */
export interface GetMonitorResponse<T extends boolean = true> extends ApiResponse {
  monitor?: Monitor<T>;
}

/**
 * Monitor list structure
 */
export interface MonitorList<T extends boolean = true> {
  [monitorID: string]: Monitor<T>;
}

/**
 * Zod schema for Heartbeat object structure from Uptime Kuma
 */
export const HeartbeatSchema = z.object({
  // Required fields
  status: z.number().describe('0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE'),
  time: z.string().describe('Timestamp string'),
  msg: z.string().describe('Status message or error'),
  important: z.union([z.boolean(), z.number()]).transform(val => Boolean(val)).describe('Was this heartbeat a status change?'),
  // Optional fields
  id: z.number().optional().describe('Unique heartbeat ID'),
  monitor_id: z.number().optional().describe('The monitor this heartbeat belongs to'),
  ping: z.number().nullable().optional().describe('Response time in ms, null if not applicable'),
  duration: z.number().optional().describe('Seconds since the last heartbeat for this monitor'),
  down_count: z.number().optional().describe('Consecutive down count for resend logic'),
  retries: z.number().optional().describe('Number of retries attempted for this state'),
  end_time: z.string().optional().describe('End time of the heartbeat check'),
  monitorID: z.number().optional().describe('camelCase alias (used in some events)'),
  localDateTime: z.string().optional().describe('Formatted time in server\'s timezone'),
  timezone: z.string().optional().describe('Server\'s timezone name'),
});

/**
 * Heartbeat type inferred from the Zod schema
 */
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/**
 * Heartbeat list structure - maps monitor IDs to heartbeats
 * When includeAll is true, returns arrays of heartbeats
 * When includeAll is false, returns only the most recent heartbeat
 */
export type HeartbeatList<T extends boolean = true> = T extends true
  ? { [monitorID: string]: Heartbeat[] }
  : { [monitorID: string]: Heartbeat | undefined };

/**
 * Zod schema for Monitor Summary object
 */
export const MonitorSummarySchema = z.object({
  id: z.number().describe('Unique monitor ID'),
  name: z.string().describe('Display name of the monitor'),
  pathName: z.string().describe('Full path name including parent groups (e.g., "Group / Monitor Name")'),
  active: z.boolean().describe('Whether the monitor is currently active/enabled'),
  maintenance: z.boolean().describe('Whether the monitor is currently in maintenance mode'),
  status: z.number().optional().describe('0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE'),
  msg: z.string().optional().describe('Status message from the most recent heartbeat'),
  uptime: z.record(z.string(), z.number()).optional().describe('Map of period keys ("24", "720", "1y") to uptime percentages'),
  avgPing: z.number().nullable().optional().describe('24-hour average ping time in milliseconds'),
});

/**
 * Monitor Summary type inferred from the Zod schema
 */
export type MonitorSummary = z.infer<typeof MonitorSummarySchema>;
