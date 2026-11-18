import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { HeartbeatSchema, type Heartbeat } from '../types/index.js';
import { redactHeartbeat } from '../redact.js';
import { numeric } from './schema.js';
import { HeartbeatSummarySchema, summariseHeartbeats } from './heartbeat-summary.js';

/** The tool that reports check history. */
export function registerHeartbeatTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  // One tool for one monitor and for all of them: they were getHeartbeats and listHeartbeats,
  // which differed only in that filter. The result is always keyed by monitor ID, so the shape
  // does not depend on whether monitorID was passed.
  server.registerTool(
    'listHeartbeats',
    {
      title: 'List Heartbeats',
      description:
        'Returns check history (status, response time, message), newest first, keyed by monitor ID: for one monitor when monitorID is given, otherwise for every monitor. Only the latest beat per monitor is returned unless maxHeartbeats is set (up to 100). For more than one beat it returns a summary per monitor instead of the rows: the time span, counts by status, ping min/avg/max, the latest beat and since when it has had that status, and each period of DOWN beats with its first message. That answers whether and when it went down, why, and whether it is back; pass raw: true only when the user wants the individual beats. important: true returns only the status changes for one monitor, which is history and not the current status. For current status use getMonitorSummary. Credentials inside a message URL read "***" unless includeSecrets is set.',
      inputSchema: {
        monitorID: numeric(z.number().int().positive())
          .optional()
          .describe('The monitor to read. Omit for every monitor. Find IDs with listMonitors.'),
        maxHeartbeats: numeric(z.number().int().positive().max(100))
          .optional()
          .describe('How many of the most recent beats to return per monitor, up to 100 (default: 1)'),
        important: z
          .boolean()
          .optional()
          .describe(
            "Return only IMPORTANT beats — the status changes behind Uptime Kuma's event list — fetched live from the server rather than the cache. Needs monitorID. History only: the newest important beat is not the monitor's current status."
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            'Return the individual beats instead of the summary when maxHeartbeats is more than 1 (default: false). Only when the user wants the beats themselves; then keep maxHeartbeats at 10 or less for one monitor and 5 or less for all, unless asked for more.'
          ),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        heartbeats: z
          .record(z.string(), z.array(HeartbeatSchema))
          .optional()
          .describe(
            'Map of monitor IDs to their heartbeats, newest first. Returned for one beat, with raw, or with important.'
          ),
        summaries: z
          .record(z.string(), HeartbeatSummarySchema)
          .optional()
          .describe(
            'Map of monitor IDs to a summary of their beats; a monitor with no beats is left out. Returned for more than one beat, unless raw.'
          ),
        monitorCount: z.number(),
        totalHeartbeatCount: z.number(),
      },
    },
    async ({ monitorID, maxHeartbeats, important, raw: wantsRows, includeSecrets }) => {
      if (important && monitorID === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'important: true reads one monitor at a time — pass monitorID. Find IDs with listMonitors.'
        );
      }

      await authenticateClient();

      try {
        const count = maxHeartbeats ?? 1;
        let raw: Record<string, Heartbeat[]>;
        if (monitorID === undefined) {
          raw = client.getHeartbeatList(count);
        } else {
          // The important/event feed is fetched live rather than served from the cache, but it
          // is heartbeat data all the same — it carries the same `msg`, so it goes through the
          // same redaction. Redacting only the cached path would leave the event list as an
          // unguarded second way to read the credentials out of a status message (#59).
          const beats = important
            ? await client.fetchImportantHeartbeats(monitorID, count)
            : client.getHeartbeatsForMonitor(monitorID, count);
          raw = { [String(monitorID)]: beats };
        }

        // Heartbeats are projected to their declared fields (dropping passthrough columns
        // like response) and a msg that quotes the monitor's URL has its credentials scrubbed.
        const heartbeats = wantsSecrets(includeSecrets)
          ? raw
          : Object.fromEntries(Object.entries(raw).map(([id, beats]) => [id, beats.map((hb) => redactHeartbeat(hb))]));

        const totalHeartbeatCount = Object.values(heartbeats).reduce((sum, beats) => sum + beats.length, 0);
        const counts = { monitorCount: Object.keys(heartbeats).length, totalHeartbeatCount };

        // One beat is already as small as its summary, and the event list (important) is a list
        // of status changes the caller asked to read, so both stay rows. The summary is built
        // from the redacted beats, so the messages it quotes are scrubbed as the rows would be.
        if (count === 1 || important || wantsRows) {
          return {
            content: [{ type: 'text', text: JSON.stringify(heartbeats) }],
            structuredContent: { heartbeats, ...counts },
          };
        }

        const summaries = Object.fromEntries(
          Object.entries(heartbeats).flatMap(([id, beats]) => {
            const summary = summariseHeartbeats(beats);
            return summary ? [[id, summary]] : [];
          })
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(summaries) }],
          structuredContent: { summaries, ...counts },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list heartbeats: ${errorMessage}`);
      }
    }
  );
}
