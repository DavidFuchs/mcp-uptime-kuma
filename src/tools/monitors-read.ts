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

  // Register getMonitor tool
  server.registerTool(
    'getMonitor',
    {
      title: 'Get Monitor',
      description: 'Retrieves configuration details for a specific monitor by ID (URL, check interval, notification settings, etc.). Use this when you need to examine or modify settings for a specific monitor. For current status, use getMonitorSummary instead. By default returns only common fields plus runtime data (uptime, avgPing); set includeTypeSpecificFields to true to include type-specific fields (e.g., url for HTTP, hostname/port for TCP).',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to retrieve'),
        includeTypeSpecificFields: z.boolean().optional().describe('Include type-specific fields (url, hostname, port, etc.) in addition to common fields. Default: false. When false, only returns MonitorBase fields plus uptime/avgPing.'),
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        monitor: MonitorBaseSchema.passthrough().describe('Monitor object with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true. Credentials (pushToken, basic_auth_pass, bearer_token, headers, ...) read "***" unless includeSecrets is set.')
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
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get monitor: ${errorMessage}`
        );
      }
    }
  );

  // Register listMonitors tool
  server.registerTool(
    'listMonitors',
    {
      title: 'List Monitors',
      description: 'Retrieves configuration details for all monitors (URLs, check intervals, notification settings, etc.). Use this when you need to examine or modify monitor settings. For status checks ("how is everything doing?", "what\'s down?"), use getMonitorSummary instead. By default returns only common fields plus runtime data (uptime, avgPing); set includeTypeSpecificFields to true to include type-specific fields (e.g., url for HTTP, hostname/port for TCP). Supports filtering by keywords, type, active/maintenance status, tags, and parent group.',
      inputSchema: {
        includeTypeSpecificFields: z.boolean().optional().describe('Include type-specific fields (url, hostname, port, etc.) in addition to common fields. Default: false. When false, only returns MonitorBase fields plus uptime/avgPing.'),
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive fuzzy match). All keywords must match for a monitor to be included.'),
        type: z.string().optional().describe('Filter by monitor type(s). Comma-separated for multiple types. Use listMonitorTypes tool to see all available types.'),
        active: z.boolean().optional().describe('Filter by active status. true=only active monitors, false=only inactive monitors.'),
        maintenance: z.boolean().optional().describe('Filter by maintenance status. true=only monitors in maintenance, false=only monitors not in maintenance.'),
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"'),
        // Issue #65: there was no way to list a group's members, so callers passing
        // `parentId` got the entire monitor list back, which reads as a broken filter.
        parentId: numeric(z.number().int()).nullable().optional().describe('Filter to the DIRECT children of this group monitor. Pass null for top-level monitors (those with no parent). Not recursive — use the group\'s own childrenIDs to walk deeper.'),
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        monitors: z.array(MonitorBaseSchema.passthrough()).describe('Array of monitor objects with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true. Credentials (pushToken, basic_auth_pass, bearer_token, headers, ...) read "***" unless includeSecrets is set.'),
        count: z.number()
      },
    },
    async ({ includeTypeSpecificFields, keywords, type, active, maintenance, tags, parentId, includeSecrets }) => {
      await authenticateClient();

      try {
        const monitorList = includeTypeSpecificFields
          ? client.getMonitorList({ keywords, type, active, maintenance, tags, parentId, includeTypeSpecificFields: true })
          : client.getMonitorList({ keywords, type, active, maintenance, tags, parentId, includeTypeSpecificFields: false });
        const raw = Object.values(monitorList);
        // This is the tool an agent reaches for to answer "what am I monitoring?", so it
        // is both the highest-volume caller and the one carrying the most credentials.
        const monitors = wantsSecrets(includeSecrets) ? raw : raw.map((m) => redactSecrets(m));

        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(monitors) 
          }],
          structuredContent: { 
            monitors,
            count: monitors.length 
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list monitors: ${errorMessage}`
        );
      }
    }
  );

  // Register listMonitorTypes tool
  server.registerTool(
    'listMonitorTypes',
    {
      title: 'List Monitor Types',
      description: 'Returns every monitor type Uptime Kuma supports, with what each one checks. Use it to choose the type for createMonitor — there are dedicated types for game servers, MQTT, RADIUS, SNMP, SMTP, gRPC, Docker containers and more — and to find valid values for type filters in other tools.',
      inputSchema: {},
      outputSchema: {
        types: z.array(z.object({
          type: z.string().describe('The monitor type identifier'),
          description: z.string().describe('Description of what this monitor type does')
        })).describe('Array of available monitor types')
      },
    },
    async () => {
      const monitorTypes = MONITOR_TYPES;
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify(monitorTypes) 
        }],
        structuredContent: { 
          types: monitorTypes 
        },
      };
    }
  );

  // Register getMonitorSummary tool
  server.registerTool(
    'getMonitorSummary',
    {
      title: 'Get Monitor Summary',
      description: 'START HERE for status overview questions. Retrieves current status for all monitors showing UP/DOWN/PENDING/MAINTENANCE states with the most recent heartbeat message. Use this when asked "how is everything doing?", "what\'s down?", "what\'s up?", or for any general status overview. Returns essential information (ID, name, pathName, active state, maintenance state, status, message, lastBeatTime, type, tags). Supports filtering by keywords, type, active/maintenance status, tags, parent group, and current status. Check lastBeatTime before trusting the status of a push monitor — one that has stopped beating keeps reporting its last known status. lastBeatTime is UTC with no zone marker, so measure staleness against the current UTC time.',
      inputSchema: {
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive fuzzy match). All keywords must match for a monitor to be included.'),
        type: z.string().optional().describe('Filter by monitor type(s). Comma-separated for multiple types. Use listMonitorTypes tool to see all available types.'),
        active: z.boolean().optional().describe('Filter by active status. true=only active monitors, false=only inactive monitors.'),
        maintenance: z.boolean().optional().describe('Filter by maintenance status. true=only monitors in maintenance, false=only monitors not in maintenance.'),
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"'),
        // "What's down in this group?" is a status question, so it arrives here rather than at
        // listMonitors — but the #65 parent filter only reached listMonitors, leaving the tool
        // the instructions send callers to FIRST unable to answer it.
        parentId: numeric(z.number().int()).nullable().optional().describe('Filter to the DIRECT children of this group monitor. Pass null for top-level monitors (those with no parent). Not recursive — use the group\'s own childrenIDs to walk deeper.'),
        status: z.string().optional().describe('Filter by current heartbeat status, by number or name. Comma-separated for multiple statuses. 0=down, 1=up, 2=pending, 3=maintenance. Examples: "down", "0", "down,pending". Any other value is an error.')
      },
      outputSchema: { 
        summaries: z.array(MonitorSummarySchema).describe('Array of monitor summaries'),
        count: z.number()
      },
    },
    async ({ keywords, type, active, maintenance, tags, parentId, status }) => {
      await authenticateClient();

      try {
        const summaries = client.getMonitorSummary({ keywords, type, active, maintenance, tags, parentId, status });
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(summaries) 
          }],
          structuredContent: { 
            summaries,
            count: summaries.length 
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get monitor summary: ${errorMessage}`
        );
      }
    }
  );
}
