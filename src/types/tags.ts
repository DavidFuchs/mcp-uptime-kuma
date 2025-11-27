import { z } from 'zod';

/**
 * Zod schema for Monitor Tag
 */
export const MonitorTagSchema = z.object({
  tag_id: z.number().optional().describe('Tag ID'),
  monitor_id: z.number().optional().describe('Monitor ID'),
  name: z.string().describe('Tag name'),
  color: z.string().describe('Tag color'),
  value: z.string().optional().describe('Tag value'),
});

/**
 * Monitor Tag type
 */
export type MonitorTag = z.infer<typeof MonitorTagSchema>;
