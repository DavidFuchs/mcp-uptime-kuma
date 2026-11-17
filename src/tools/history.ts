import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { numeric, requiredId } from './schema.js';
import type { UptimeBucket } from '../types/index.js';

/** Uptime Kuma keeps a year of daily statistics. */
const MAX_HOURS = 365 * 24;
/** How many buckets with failed checks are listed; the count says how many there were. */
const MAX_DOWNTIME_BUCKETS = 50;

/** Uptime Kuma's bucket size for a period, as getMonitorChartData picks it. */
const granularityFor = (hours: number): 'minute' | 'hour' | 'day' =>
  hours <= 24 ? 'minute' : hours <= 720 ? 'hour' : 'day';

/** Uptime, ping and the buckets with failed checks, from Uptime Kuma's uptime buckets. */
export function summarizeUptime(buckets: UptimeBucket[], hours: number) {
  let up = 0;
  let down = 0;
  let maintenance = 0;
  let pingSum = 0;
  let pingCount = 0;
  let minPing: number | null = null;
  let maxPing: number | null = null;
  for (const b of buckets) {
    up += b.up ?? 0;
    down += b.down ?? 0;
    maintenance += b.maintenance ?? 0;
    // avgPing is the mean over the bucket's UP checks, so it is weighted by them.
    if (typeof b.avgPing === 'number' && (b.up ?? 0) > 0) {
      pingSum += b.avgPing * b.up;
      pingCount += b.up;
    }
    if (typeof b.minPing === 'number') minPing = minPing === null ? b.minPing : Math.min(minPing, b.minPing);
    if (typeof b.maxPing === 'number') maxPing = maxPing === null ? b.maxPing : Math.max(maxPing, b.maxPing);
  }
  const withDown = buckets
    .filter((b) => (b.down ?? 0) > 0)
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((b) => ({ start: new Date(b.timestamp * 1000).toISOString(), down: b.down, up: b.up ?? 0 }));
  return {
    hours,
    granularity: granularityFor(hours),
    checks: { up, down, maintenance },
    // Uptime Kuma's own definition: maintenance is neither up nor down.
    uptimePercent: up + down > 0 ? Math.round((up / (up + down)) * 100000) / 1000 : null,
    ping: {
      avg: pingCount > 0 ? Math.round((pingSum / pingCount) * 10) / 10 : null,
      min: minPing,
      max: maxPing,
    },
    downtimeBucketCount: withDown.length,
    downtimeBuckets: withDown.slice(0, MAX_DOWNTIME_BUCKETS),
  };
}

/** Uptime over a period, and the tools that clear a monitor's history. */
export function registerHistoryTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  // Uptime Kuma answers a clear of a missing monitor with ok: true. Check first.
  const requireMonitor = (monitorID: number) => {
    if (!client.getMonitor(monitorID)) {
      throw new Error(`Monitor ${monitorID} not found — call listMonitors to see available IDs`);
    }
  };

  server.registerTool(
    'getMonitorUptime',
    {
      title: 'Get Monitor Uptime',
      description:
        'Returns a monitor\'s uptime percentage, check counts and ping (min/avg/max) over the last N hours, up to a year, with the minutes, hours or days in which checks failed, newest first. Use it for "what was the uptime this week?"; for the current status use getMonitorSummary, and for individual checks listHeartbeats. Counted as Uptime Kuma counts them: PENDING is down, and MAINTENANCE is neither.',
      inputSchema: {
        monitorID: requiredId('The monitor to report on. Find IDs with listMonitors.'),
        hours: numeric(z.number().int().min(1).max(MAX_HOURS))
          .optional()
          .describe(
            'How far back, in hours (default: 24; e.g. 168 for a week, 720 for 30 days). Up to 24 is counted per minute, up to 720 per hour, beyond that per whole day.'
          ),
      },
      outputSchema: {
        monitorID: z.number(),
        hours: z.number(),
        granularity: z.enum(['minute', 'hour', 'day']).describe('Size of each bucket in downtimeBuckets'),
        checks: z.object({ up: z.number(), down: z.number(), maintenance: z.number() }),
        uptimePercent: z.number().nullable().describe('up / (up + down) × 100; null when there were no checks'),
        ping: z.object({ avg: z.number().nullable(), min: z.number().nullable(), max: z.number().nullable() }),
        downtimeBucketCount: z.number().describe('Buckets with at least one failed check'),
        downtimeBuckets: z
          .array(z.object({ start: z.string().describe('ISO 8601, UTC'), down: z.number(), up: z.number() }))
          .describe(`The newest ${MAX_DOWNTIME_BUCKETS} of them`),
      },
    },
    async ({ monitorID, hours }) => {
      await authenticateClient();

      try {
        requireMonitor(monitorID);
        // Beyond 30 days Uptime Kuma counts whole days, so round up to them.
        const requested = hours ?? 24;
        const period = requested > 720 ? Math.ceil(requested / 24) * 24 : requested;
        const summary = summarizeUptime(await client.getMonitorChartData(monitorID, period), period);
        const structuredContent = { monitorID, ...summary };
        const text =
          summary.uptimePercent === null
            ? `Monitor ${monitorID} has no checks recorded in the last ${period} hours.`
            : `Monitor ${monitorID}: ${summary.uptimePercent}% up over the last ${period} hours ` +
              `(${summary.checks.up} up, ${summary.checks.down} down, ${summary.checks.maintenance} in maintenance). ` +
              JSON.stringify(structuredContent);
        return { content: [{ type: 'text', text }], structuredContent };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get monitor uptime: ${message}`);
      }
    }
  );

  server.registerTool(
    'clearMonitorEvents',
    {
      title: 'Clear Monitor Events',
      description:
        "Empties a monitor's event list, the status changes listHeartbeats returns with important: true: every heartbeat's message is blanked and none counts as a status change any more. The heartbeats and the uptime statistics are kept. Cannot be undone.",
      inputSchema: {
        monitorID: requiredId('The monitor whose events to clear. Find IDs with listMonitors.'),
      },
      outputSchema: { ok: z.boolean(), monitorID: z.number() },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        requireMonitor(monitorID);
        const response = await client.clearEvents(monitorID);
        return {
          content: [{ type: 'text', text: `Cleared the events of monitor ${monitorID}.` }],
          structuredContent: { ok: response.ok, monitorID },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to clear monitor events: ${message}`);
      }
    }
  );

  server.registerTool(
    'clearMonitorHeartbeats',
    {
      title: 'Clear Monitor Heartbeats',
      description:
        "Deletes all of one monitor's heartbeats and uptime statistics, so its history and uptime start again from the next check; an active monitor is restarted. The monitor and its settings are kept. Cannot be undone. To clear only its event list, use clearMonitorEvents; for every monitor at once, clearAllStatistics.",
      inputSchema: {
        monitorID: requiredId('The monitor whose history to delete. Find IDs with listMonitors.'),
      },
      outputSchema: { ok: z.boolean(), monitorID: z.number() },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        requireMonitor(monitorID);
        const response = await client.clearHeartbeats(monitorID);
        return {
          content: [{ type: 'text', text: `Deleted the heartbeats and uptime statistics of monitor ${monitorID}.` }],
          structuredContent: { ok: response.ok, monitorID },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to clear monitor heartbeats: ${message}`);
      }
    }
  );

  server.registerTool(
    'clearAllStatistics',
    {
      title: 'Clear All Statistics',
      description:
        'Deletes the heartbeats and uptime statistics of EVERY monitor, and restarts the active ones; monitors and settings are kept. Cannot be undone. Only when the user explicitly asks to reset all history: confirm with them first, then pass confirm: true. For one monitor use clearMonitorHeartbeats.',
      inputSchema: {
        confirm: z
          .literal(true)
          .describe("Must be true: confirms that the user asked to delete every monitor's history"),
      },
      outputSchema: { ok: z.boolean() },
    },
    async () => {
      await authenticateClient();

      try {
        const response = await client.clearStatistics();
        return {
          content: [{ type: 'text', text: 'Deleted the heartbeats and uptime statistics of every monitor.' }],
          structuredContent: { ok: response.ok },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to clear statistics: ${message}`);
      }
    }
  );
}
