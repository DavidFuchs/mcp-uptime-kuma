import { z } from 'zod';

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
