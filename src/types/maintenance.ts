import { z } from 'zod';

/**
 * Maintenance window schema
 */
export const MaintenanceSchema = z.object({
  id: z.number().optional().describe('Maintenance ID (assigned by server)'),
  title: z.string().describe('Title of the maintenance window'),
  description: z.string().optional().describe('Description of the maintenance'),
  strategy: z.enum(['single', 'recurring-interval', 'recurring-weekday', 'recurring-day-of-month', 'manual']).optional()
    .describe('Scheduling strategy'),
  active: z.boolean().optional().describe('Whether the maintenance window is active'),
  timezone: z.string().optional().describe('Timezone for the maintenance window'),
  dateRange: z.array(z.string()).optional().describe('Date range [startDate, endDate] in ISO format'),
  timeRange: z.array(z.object({
    hours: z.number(),
    minutes: z.number(),
  })).optional().describe('Time range within the day'),
  weekdays: z.array(z.number()).optional().describe('Days of week (0=Sunday, 6=Saturday)'),
  daysOfMonth: z.array(z.number()).optional().describe('Days of month (1-31)'),
  intervalDay: z.number().optional().describe('Interval in days for recurring-interval strategy'),
}).passthrough();

export type Maintenance = z.infer<typeof MaintenanceSchema>;
