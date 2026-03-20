import { z } from 'zod';

/**
 * Notification configuration schema
 * Covers common fields for all notification types (Slack, ntfy, Discord, etc.)
 */
export const NotificationSchema = z.object({
  id: z.number().optional().describe('Notification ID (assigned by server)'),
  name: z.string().optional().describe('Human-readable name for this notification channel'),
  type: z.string().optional().describe('Notification type (e.g. slack, ntfy, discord, telegram, email, webhook)'),
  isDefault: z.boolean().optional().describe('Whether this notification is enabled by default for new monitors'),
  applyExisting: z.boolean().optional().describe('Apply this notification to all existing monitors'),
  active: z.boolean().optional().describe('Whether this notification is active'),
}).passthrough();

export type Notification = z.infer<typeof NotificationSchema>;
