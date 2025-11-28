import { z } from 'zod';
import { MonitorTagSchema } from './tags.js';
import { MonitorConditionSchema } from './monitor-conditions.js';

/**
 * Monitor Summary schema (for list views)
 */
export const MonitorSummarySchema = z.object({
  id: z.number().describe('Monitor ID'),
  name: z.string().describe('Monitor name'),
  type: z.string().describe('Monitor type'),
  active: z.boolean().describe('Active/enabled'),
  pathName: z.string().describe('Full hierarchical path'),
  maintenance: z.boolean().describe('In maintenance mode'),
  tags: z.array(MonitorTagSchema).optional().describe('Associated tags'),
  uptime: z.record(z.string(), z.number()).optional().describe('Uptime % by period (24h/720h/1y)'),
  avgPing: z.number().nullable().optional().describe('24h average ping (ms)'),
  status: z.number().optional().describe('0=DOWN 1=UP 2=PENDING 3=MAINT'),
  msg: z.string().optional().describe('Latest status message'),
});

/**
 * Monitor Summary type
 */
export type MonitorSummary = z.infer<typeof MonitorSummarySchema>;

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
 * Full monitor schema with all fields (for creation, updates, and detailed responses)
 */
export const MonitorBaseSchema = z.object({
  id: z.number().optional().describe('Monitor ID (omit for creation)'),
  name: z.string().describe('Monitor name'),
  description: z.string().nullable().optional().describe('Monitor description'),
  type: z.enum([
    'http',
    'keyword',
    'json-query',
    'ping',
    'port',
    'dns',
    'docker',
    'mqtt',
    'mongodb',
    'redis',
    'sqlserver',
    'postgres',
    'mysql',
    'grpc-keyword',
    'kafka-producer',
    'radius',
    'rabbitmq',
    'smtp',
    'snmp',
    'real-browser',
    'gamedig',
    'push',
    'group',
    'tailscale-ping',
    'manual',
  ]).describe('Monitor type'),
  active: z.boolean().optional().default(true).describe('Start monitoring immediately'),
  parent: z.number().nullable().optional().describe('Parent group ID (null for root)'),
  weight: z.number().nullable().optional().describe('Display order weight'),

  // Timing
  interval: z.number().min(20).max(86400).describe('Check interval in seconds (20-86400)'),
  retryInterval: z.number().describe('Retry interval in seconds'),
  resendInterval: z.number().default(0).describe('Notification resend interval (0 = disabled)'),
  timeout: z.number().nullable().optional().describe('Request timeout in seconds'),

  // Status Handling
  maxretries: z.number().default(0).describe('Max retries before marking as down'),
  upsideDown: z.boolean().default(false).describe('Invert status (down = up, up = down)'),
  accepted_statuscodes: z.array(z.string()).default(['200-299']).describe('Accepted status codes (must be strings)'),

  // Notifications
  notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Notification ID to enabled map'),

  // Tags (read-only, use TagsManager for modification)
  tags: z.array(MonitorTagSchema).optional().describe('Associated tags'),

  // Conditions
  conditions: z.array(MonitorConditionSchema).optional().describe('Monitor conditions'),

  // Read-only fields (set by system)
  user_id: z.number().optional().describe('Owner user ID'),
  maintenance: z.boolean().optional().describe('In maintenance mode'),
  path: z.array(z.string()).optional().describe('Hierarchical path array'),
  pathName: z.string().optional().describe('Full hierarchical path'),
  childrenIDs: z.array(z.number()).optional().describe('Child monitor IDs (for groups)'),
  forceInactive: z.boolean().optional().describe('Force inactive state'),
  includeSensitiveData: z.boolean().optional().describe('Whether sensitive data is included'),
});

/**
 * Base monitor type (for creation/update operations)
 */
export type MonitorBase = z.infer<typeof MonitorBaseSchema>;
