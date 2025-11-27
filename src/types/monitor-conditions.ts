import { z } from 'zod';

/**
 * Monitor Condition type
 */
export type MonitorCondition = {
  type: 'condition' | 'group';
  variable?: string;
  operator?: string;
  value?: string;
  andOr?: 'and' | 'or';
  children?: MonitorCondition[];
};

/**
 * Zod schema for Monitor Condition
 */
export const MonitorConditionSchema: z.ZodType<MonitorCondition> = z.object({
  type: z.enum(['condition', 'group']).describe('Condition or group'),
  variable: z.string().optional().describe('Variable to check'),
  operator: z.string().optional().describe('Comparison operator'),
  value: z.string().optional().describe('Expected value'),
  andOr: z.enum(['and', 'or']).optional().describe('Group logic operator'),
  children: z.array(z.lazy(() => MonitorConditionSchema)).optional().describe('Nested conditions'),
});
