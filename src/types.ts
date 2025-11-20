import { z } from 'zod';

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
  id: z.number(),
  name: z.string(),
  type: z.string(),
  url: z.string().optional(),
  method: z.string().optional(),
  interval: z.number(),
  retryInterval: z.number(),
  resendInterval: z.number(),
  maxretries: z.number(),
  hostname: z.string().nullable().optional(),
  port: z.number().nullable().optional(),
  active: z.boolean(),
  tags: z.array(MonitorTagSchema).optional(),
  notificationIDList: z.record(z.string(), z.boolean()).optional(),
  accepted_statuscodes_json: z.string().optional(),
  conditions: z.array(z.any()).optional(),
  pathName: z.string(),
  maintenance: z.boolean(),
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
