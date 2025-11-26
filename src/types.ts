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
}

/**
 * Filter options for querying monitors
 */
export interface MonitorFilterOptions {
  /** Space-separated keywords to filter by pathName (case-insensitive, fuzzy match) */
  keywords?: string;
  /** Filter by monitor type(s). Comma-separated for multiple types - e.g., 'http' or 'http,ping,dns' */
  type?: string;
  /** Filter by active/inactive status */
  active?: boolean;
  /** Filter by maintenance status */
  maintenance?: boolean;
  /** Filter by tag name and optional value. Comma-separated for multiple tags. Format: 'tagName' or 'tagName=value'. Case-insensitive. */
  tags?: string;
  /** Filter by current status. Comma-separated for multiple statuses - 0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE */
  status?: string;
}

/**
 * Zod schema for Monitor tag object
 */
const MonitorTagSchema = z.object({
  tag_id: z.number().describe('Tag ID'),
  monitor_id: z.number().describe('Monitor ID'),
  value: z.string().nullable().describe('Tag value'),
  name: z.string().describe('Tag name'),
  color: z.string().describe('Tag color'),
});

/**
 * Zod schema for Base Monitor Object structure from Uptime Kuma (defined fields only)
 */
export const MonitorBaseSchema = z.object({
  id: z.number().describe('Monitor ID'),
  name: z.string().describe('Monitor name (e.g., "nginx")'),
  type: z.string().describe('Type: http, ping, dns, etc.'),
  url: z.string().optional().describe('URL to monitor'),
  method: z.string().optional().describe('HTTP method'),
  interval: z.number().describe('Check interval (seconds)'),
  retryInterval: z.number().describe('Retry interval (seconds)'),
  resendInterval: z.number().describe('Notification resend interval (seconds)'),
  maxretries: z.number().describe('Max retries before down'),
  hostname: z.string().nullable().optional().describe('Hostname for port/ping'),
  port: z.number().nullable().optional().describe('Port number'),
  active: z.boolean().describe('Active/enabled'),
  tags: z.array(MonitorTagSchema).optional().describe('Associated tags'),
  notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Notification ID to enabled map'),
  accepted_statuscodes_json: z.string().optional().describe('Accepted HTTP status codes (JSON)'),
  conditions: z.array(z.any()).optional().describe('Monitor conditions'),
  pathName: z.string().describe('Full hierarchical path (e.g., "Homelab / Web / nginx")'),
  maintenance: z.boolean().describe('In maintenance mode'),
  uptime: z.record(z.string(), z.number()).optional().describe('Uptime % by period (24/720/1y)'),
  avgPing: z.number().nullable().optional().describe('24h avg ping (ms)'),
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
  serverTimezone: z.string().describe('Server timezone'),
  checkUpdate: z.boolean().describe('Check for updates'),
  searchEngineIndex: z.boolean().describe('Allow search engine indexing'),
  entryPage: z.string().describe('Entry page (dashboard/statuspage)'),
  dnsCache: z.boolean().describe('DNS cache enabled'),
  keepDataPeriodDays: z.number().describe('Data retention period (days)'),
  tlsExpiryNotifyDays: z.array(z.number()).describe('TLS expiry notification days'),
  trustProxy: z.boolean().describe('Trust proxy headers'),
  nscd: z.boolean().describe('NSCD enabled'),
  disableAuth: z.boolean().describe('Authentication disabled'),
  primaryBaseURL: z.string().optional().describe('Primary base URL'),
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
  status: z.number().describe('0=DOWN 1=UP 2=PENDING 3=MAINT'),
  time: z.string().describe('Timestamp'),
  msg: z.string().describe('Status message'),
  important: z.union([z.boolean(), z.number()]).transform(val => Boolean(val)).describe('Status change flag'),
  // Optional fields
  id: z.number().optional().describe('Heartbeat ID'),
  monitor_id: z.number().optional().describe('Monitor ID'),
  ping: z.number().nullable().optional().describe('Response time (ms)'),
  duration: z.number().optional().describe('Seconds since last check'),
  down_count: z.number().optional().describe('Consecutive down count'),
  retries: z.number().optional().describe('Retry attempts'),
  end_time: z.string().optional().describe('Check end time'),
  monitorID: z.number().optional().describe('Monitor ID (camelCase)'),
  localDateTime: z.string().optional().describe('Local formatted time'),
  timezone: z.string().optional().describe('Server timezone'),
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
  id: z.number().describe('Monitor ID'),
  name: z.string().describe('Monitor name (e.g., "mx2")'),
  pathName: z.string().describe('Full hierarchical path (e.g., "Homelab / App / E-Mail / mx2") where intermediate segments are groups/folders, not monitors'),
  active: z.boolean().describe('Active/enabled'),
  maintenance: z.boolean().describe('In maintenance mode'),
  status: z.number().optional().describe('0=DOWN 1=UP 2=PENDING 3=MAINT'),
  msg: z.string().optional().describe('Latest status message'),
  uptime: z.record(z.string(), z.number()).optional().describe('Uptime % by period (24/720/1y)'),
  avgPing: z.number().nullable().optional().describe('24h avg ping (ms)'),
  type: z.string().describe('Type: http, ping, dns, port, etc.'),
  tags: z.array(MonitorTagSchema).optional().describe('Associated tags'),
});

/**
 * Monitor Summary type inferred from the Zod schema
 */
export type MonitorSummary = z.infer<typeof MonitorSummarySchema>;
