import { z } from 'zod';

/**
 * Monitor Condition type.
 *
 * Uptime Kuma names a comparison "expression" (server/monitor-conditions/expression.js:
 * `condition.type === "expression"`). This used to say "condition", which no monitor has ever
 * held, so getMonitor failed output validation on any monitor with a condition set (#112).
 */
export type MonitorCondition = {
  type: 'expression' | 'group';
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
  type: z.enum(['expression', 'group']).describe('A single comparison, or a group of nested conditions'),
  variable: z.string().optional().describe('Variable to check'),
  operator: z.string().optional().describe('Comparison operator'),
  value: z.string().optional().describe('Expected value'),
  andOr: z.enum(['and', 'or']).optional().describe('Group logic operator'),
  children: z.array(z.lazy(() => MonitorConditionSchema)).optional().describe('Nested conditions'),
});
