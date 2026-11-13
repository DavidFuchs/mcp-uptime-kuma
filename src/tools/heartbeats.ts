import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { HeartbeatSchema } from '../types/index.js';
import { redactHeartbeat } from '../redact.js';
import { numeric, requiredId } from './schema.js';

/** The tools that report check history. */
export function registerHeartbeatTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  // Register getHeartbeats tool
  server.registerTool(
    'getHeartbeats',
    {
      title: 'Get Heartbeats',
      description:
        'Retrieves historical heartbeat data for a specific monitor (response times, status changes over time). Use this for analyzing patterns or history for one monitor. Beats are returned NEWEST-FIRST. By default returns only the most recent heartbeat; set maxHeartbeats (up to 100) for historical analysis. Keep maxHeartbeats ≤10 unless user requests more. Set important:true for the status CHANGES only (Uptime Kuma\'s own event list) — that is history, not current state, so do not read status from it. Credentials embedded in a status message URL (user:pass@host) read "***" unless includeSecrets is set.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to get heartbeats for'),
        maxHeartbeats: numeric(z.number().int().positive().max(100))
          .optional()
          .describe(
            'If set, returns the most recent X heartbeats (up to 100). If unset, returns only the most recent heartbeat (default: 1)'
          ),
        important: z
          .boolean()
          .optional()
          .describe(
            "Return only IMPORTANT beats — the status changes behind Uptime Kuma's event list — fetched live from the server rather than the cache. History only: the newest important beat is not the monitor's current status."
          ),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        monitorID: z.number(),
        heartbeats: z.array(HeartbeatSchema),
        count: z.number(),
      },
    },
    async ({ monitorID, maxHeartbeats, important, includeSecrets }) => {
      await authenticateClient();

      try {
        const count = maxHeartbeats ?? 1;
        // The important/event feed is fetched live rather than served from the cache, but it
        // is heartbeat data all the same — it carries the same `msg`, so it goes through the
        // same redaction. Redacting only the cached path would leave the event list as an
        // unguarded second way to read the credentials out of a status message (#59).
        const raw = important
          ? await client.fetchImportantHeartbeats(monitorID, count)
          : client.getHeartbeatsForMonitor(monitorID, count);
        // Heartbeats are projected to their declared fields (dropping passthrough columns
        // like response) and a msg that quotes the monitor's URL has its credentials scrubbed.
        const heartbeatsArray = wantsSecrets(includeSecrets) ? raw : raw.map((hb) => redactHeartbeat(hb));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(heartbeatsArray),
            },
          ],
          structuredContent: {
            monitorID,
            heartbeats: heartbeatsArray,
            count: heartbeatsArray.length,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get heartbeats: ${errorMessage}`);
      }
    }
  );

  // Register listAllHeartbeats tool
  server.registerTool(
    'listHeartbeats',
    {
      title: 'List Heartbeats',
      description:
        'Retrieves historical heartbeat data for ALL monitors (response times, status changes over time). Use this for analyzing patterns across multiple monitors or correlating events. Beats are returned NEWEST-FIRST. By default returns only the most recent heartbeat per monitor; set maxHeartbeats (up to 100) for historical analysis. Keep maxHeartbeats ≤5 unless user requests more. Credentials embedded in a status message URL (user:pass@host) read "***" unless includeSecrets is set.',
      inputSchema: {
        maxHeartbeats: numeric(z.number().int().positive().max(100))
          .optional()
          .describe(
            'If set, returns the most recent X heartbeats per monitor (up to 100). If unset, returns only the most recent heartbeat per monitor (default: 1)'
          ),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        heartbeats: z
          .record(z.string(), z.array(HeartbeatSchema))
          .describe('Map of monitor IDs to their heartbeat arrays'),
        monitorCount: z.number(),
        totalHeartbeatCount: z.number(),
      },
    },
    async ({ maxHeartbeats, includeSecrets }) => {
      await authenticateClient();

      try {
        const count = maxHeartbeats ?? 1;
        const raw = client.getHeartbeatList(count);
        // Heartbeats are projected to their declared fields (dropping passthrough columns
        // like response) and a msg that quotes the monitor's URL has its credentials scrubbed.
        const heartbeatList = wantsSecrets(includeSecrets)
          ? raw
          : Object.fromEntries(Object.entries(raw).map(([id, beats]) => [id, beats.map((hb) => redactHeartbeat(hb))]));

        // Calculate total heartbeat count
        const totalCount = Object.values(heartbeatList).reduce((sum, heartbeats) => sum + heartbeats.length, 0);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(heartbeatList),
            },
          ],
          structuredContent: {
            heartbeats: heartbeatList,
            monitorCount: Object.keys(heartbeatList).length,
            totalHeartbeatCount: totalCount,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list heartbeats: ${errorMessage}`);
      }
    }
  );
}
