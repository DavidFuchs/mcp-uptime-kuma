import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { HeartbeatSchema, type Heartbeat } from '../types/index.js';
import { redactHeartbeat } from '../redact.js';
import { numeric } from './schema.js';

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
        'Returns check history (status, response time, message), newest first, keyed by monitor ID: for one monitor when monitorID is given, otherwise for every monitor. Only the latest beat per monitor is returned unless maxHeartbeats is set (up to 100; keep it at 10 or less for one monitor and 5 or less for all, unless asked for more). important: true returns only the status changes for one monitor, which is history and not the current status. For current status use getMonitorSummary. Credentials inside a message URL read "***" unless includeSecrets is set.',
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
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        heartbeats: z
          .record(z.string(), z.array(HeartbeatSchema))
          .describe('Map of monitor IDs to their heartbeats, newest first'),
        monitorCount: z.number(),
        totalHeartbeatCount: z.number(),
      },
    },
    async ({ monitorID, maxHeartbeats, important, includeSecrets }) => {
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

        return {
          content: [{ type: 'text', text: JSON.stringify(heartbeats) }],
          structuredContent: {
            heartbeats,
            monitorCount: Object.keys(heartbeats).length,
            totalHeartbeatCount,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list heartbeats: ${errorMessage}`);
      }
    }
  );
}
