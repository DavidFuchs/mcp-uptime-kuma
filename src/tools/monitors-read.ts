import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { MonitorBaseSchema, MonitorSummarySchema } from '../types/index.js';
import { redactSecrets } from '../redact.js';
import { numeric, requiredId } from './schema.js';
import { MONITOR_TYPES } from '../monitors/fields.js';

/** The tools that report on monitors: their configuration, their types and their current status. */
export function registerMonitorReadTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  // One copy of the arguments listMonitors and getMonitorSummary share, so the two filters
  // cannot drift apart again (#65) and the text is not paid for twice in a different wording.
  const includeTypeSpecificFields = z
    .boolean()
    .optional()
    .describe('Also return type-specific fields such as url, hostname and port (default: false)');
  const monitorFilters = {
    keywords: z
      .string()
      .optional()
      .describe("Space-separated keywords matched against the monitor's pathName, case-insensitively; all must match"),
    type: z.string().optional().describe('Monitor type(s), comma-separated. listMonitorTypes lists them.'),
    active: z.boolean().optional().describe('true: only active monitors; false: only paused ones'),
    maintenance: z
      .boolean()
      .optional()
      .describe('true: only monitors in maintenance; false: only those not in maintenance'),
    tags: z
      .string()
      .optional()
      .describe(
        'Tags a monitor must all have, comma-separated, each "name" or "name=value", case-insensitive. E.g. "production,env=staging"'
      ),
    // Issue #65: there was no way to list a group's members, so callers passing `parentId`
    // got the entire monitor list back, which reads as a broken filter. getMonitorSummary needs
    // it too: "what's down in this group?" is a status question.
    parentId: numeric(z.number().int())
      .nullable()
      .optional()
      .describe('Only the direct children of this group monitor (not recursive); null for top-level monitors'),
  };

  // Register getMonitor tool
  server.registerTool(
    'getMonitor',
    {
      title: 'Get Monitor',
      description:
        "Returns one monitor's configuration by ID (check interval, notifications, tags, parent group) with its uptime and average ping. Type-specific fields such as url, hostname and port are returned only with includeTypeSpecificFields. Read it before updateMonitor. For current status use getMonitorSummary; for check history, listHeartbeats. Find IDs with listMonitors.",
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to retrieve'),
        includeTypeSpecificFields,
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        monitor: MonitorBaseSchema.passthrough().describe(
          'Monitor object with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true. Credentials (pushToken, basic_auth_pass, bearer_token, headers, ...) read "***" unless includeSecrets is set.'
        ),
      },
    },
    async ({ monitorID, includeTypeSpecificFields, includeSecrets }) => {
      await authenticateClient();

      try {
        const monitor = includeTypeSpecificFields
          ? client.getMonitor(monitorID, true)
          : client.getMonitor(monitorID, false);

        if (!monitor) {
          throw new Error(`Monitor with ID ${monitorID} not found`);
        }

        // Redact on a copy. getMonitor() spreads the cached row, but nested values are
        // still shared with monitorListCache — which updateMonitor merges over on write.
        const result = wantsSecrets(includeSecrets) ? monitor : redactSecrets(monitor);

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { monitor: result },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get monitor: ${errorMessage}`);
      }
    }
  );

  // Register listMonitors tool
  server.registerTool(
    'listMonitors',
    {
      title: 'List Monitors',
      description:
        'Returns the configuration of every monitor, or of those matching the filters (keywords, type, active, maintenance, tags, parent group). Use it to find monitor IDs or compare settings; for current UP/DOWN status use getMonitorSummary instead. Type-specific fields such as url, hostname and port are returned only with includeTypeSpecificFields.',
      inputSchema: {
        includeTypeSpecificFields,
        ...monitorFilters,
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        monitors: z
          .array(MonitorBaseSchema.passthrough())
          .describe(
            'Array of monitor objects with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true. Credentials (pushToken, basic_auth_pass, bearer_token, headers, ...) read "***" unless includeSecrets is set.'
          ),
        count: z.number(),
      },
    },
    async ({ includeTypeSpecificFields, keywords, type, active, maintenance, tags, parentId, includeSecrets }) => {
      await authenticateClient();

      try {
        const monitorList = includeTypeSpecificFields
          ? client.getMonitorList({
              keywords,
              type,
              active,
              maintenance,
              tags,
              parentId,
              includeTypeSpecificFields: true,
            })
          : client.getMonitorList({
              keywords,
              type,
              active,
              maintenance,
              tags,
              parentId,
              includeTypeSpecificFields: false,
            });
        const raw = Object.values(monitorList);
        // This is the tool an agent reaches for to answer "what am I monitoring?", so it
        // is both the highest-volume caller and the one carrying the most credentials.
        const monitors = wantsSecrets(includeSecrets) ? raw : raw.map((m) => redactSecrets(m));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(monitors),
            },
          ],
          structuredContent: {
            monitors,
            count: monitors.length,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list monitors: ${errorMessage}`);
      }
    }
  );

  // Register listMonitorTypes tool
  server.registerTool(
    'listMonitorTypes',
    {
      title: 'List Monitor Types',
      description:
        'Returns every monitor type Uptime Kuma supports and what each one checks. Use it to choose the type for createMonitor (there are dedicated types for game servers, MQTT, SNMP, gRPC, Docker containers and more) and for the valid values of type filters. For the fields a type takes, call getMonitorTypeFields.',
      inputSchema: {},
      outputSchema: {
        types: z
          .array(
            z.object({
              type: z.string().describe('The monitor type identifier'),
              description: z.string().describe('Description of what this monitor type does'),
            })
          )
          .describe('Array of available monitor types'),
      },
    },
    async () => {
      const monitorTypes = MONITOR_TYPES;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(monitorTypes),
          },
        ],
        structuredContent: {
          types: monitorTypes,
        },
      };
    }
  );

  // Register getMonitorSummary tool
  server.registerTool(
    'getMonitorSummary',
    {
      title: 'Get Monitor Summary',
      description:
        'START HERE for status questions ("what\'s down?", "how is everything doing?"). Returns the current status of every monitor (UP, DOWN, PENDING or MAINTENANCE) with its latest heartbeat message, lastBeatTime, type and tags. Filters: keywords, type, status, active, maintenance, tags, parent group. A push monitor that has stopped beating keeps its last status, so check lastBeatTime, which is UTC with no zone marker. For configuration use listMonitors; for history, listHeartbeats.',
      inputSchema: {
        ...monitorFilters,
        status: z
          .string()
          .optional()
          .describe(
            'Current status, comma-separated, by name or number: down (0), up (1), pending (2), maintenance (3). E.g. "down,pending"'
          ),
      },
      outputSchema: {
        summaries: z.array(MonitorSummarySchema).describe('Array of monitor summaries'),
        count: z.number(),
      },
    },
    async ({ keywords, type, active, maintenance, tags, parentId, status }) => {
      await authenticateClient();

      try {
        const summaries = client.getMonitorSummary({ keywords, type, active, maintenance, tags, parentId, status });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(summaries),
            },
          ],
          structuredContent: {
            summaries,
            count: summaries.length,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get monitor summary: ${errorMessage}`);
      }
    }
  );
}
