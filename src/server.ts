import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { UptimeKumaClient, filterMonitorFields } from './uptime-kuma-client.js';
import { HeartbeatSchema, MonitorBaseSchema } from './types.js';

/**
 * Configuration interface for Uptime Kuma
 */
export interface UptimeKumaConfig {
  url: string;
  username: string;
  password: string;
}

/**
 * Creates and configures the MCP server with tools, resources, and prompts
 */
export async function createServer(config: UptimeKumaConfig): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'mcp-uptime-kuma',
      version: '0.3.0',
    },
    {
      instructions: `
        This MCP server provides access to Uptime Kuma monitoring data for system status and uptime/downtime information.

        START with 'getMonitorSummary' for status overview questions ("how is everything?", "what's down?").
        Use 'getHeartbeats' or 'listHeartbeats' for historical data (limit to 5-10 heartbeats unless user requests more).
        Use 'listMonitors' only when you need configuration details (URLs, intervals, notification settings).
      `
    }
  );


  // Initialize Uptime Kuma client and login
  const client = new UptimeKumaClient(config.url);
  let isAuthenticated = false;
  
  try {
    await client.connect();
    await client.login(config.username, config.password);
    isAuthenticated = true;
    console.error('Successfully authenticated with Uptime Kuma');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to authenticate with Uptime Kuma:', error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to authenticate with Uptime Kuma: ${errorMessage}`
    );
  }

  // Register getMonitor tool
  server.registerTool(
    'getMonitor',
    {
      title: 'Get Monitor',
      description: 'Retrieves configuration details for a specific monitor by ID (URL, check interval, notification settings, etc.). Use this when you need to examine or modify settings for a specific monitor. For current status, use getMonitorSummary instead. By default returns only core fields; set includeAdditionalFields to true to return all fields.',
      inputSchema: { 
        monitorID: z.number().int().positive().describe('The ID of the monitor to retrieve'),
        includeAdditionalFields: z.boolean().optional().describe('Include all additional fields from Uptime Kuma (default: false)')
      },
      outputSchema: { 
        monitor: MonitorBaseSchema.passthrough().describe('Monitor object (may include additional fields beyond base schema when includeAdditionalFields is true)')
      },
    },
    async ({ monitorID, includeAdditionalFields }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const monitor = client.getMonitor(monitorID);
        
        if (!monitor) {
          throw new Error(`Monitor with ID ${monitorID} not found`);
        }
        
        const result = (includeAdditionalFields ?? false) ? monitor : filterMonitorFields(monitor);
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      description: 'Retrieves configuration details for all monitors (URLs, check intervals, notification settings, etc.). Use this when you need to examine or modify monitor settings. For status checks ("how is everything doing?", "what\'s down?"), use getMonitorSummary instead. By default returns only core fields; set includeAdditionalFields to true to return all fields.',
      inputSchema: {
        includeAdditionalFields: z.boolean().optional().describe('Include all additional fields from Uptime Kuma (default: false)')
      },
      outputSchema: { 
        monitors: z.array(MonitorBaseSchema.passthrough()).describe('Array of monitor objects (may include additional fields beyond base schema when includeAdditionalFields is true)'),
        count: z.number()
      },
    },
    async ({ includeAdditionalFields }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const monitorList = client.getMonitorList();
        const monitors = Object.values(monitorList).map(monitor => 
          (includeAdditionalFields ?? false) ? monitor : filterMonitorFields(monitor)
        );
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(monitors, null, 2) 
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

  // Register getMonitorSummary tool
  server.registerTool(
    'getMonitorSummary',
    {
      title: 'Get Monitor Summary',
      description: 'START HERE for status overview questions. Retrieves current status for all monitors showing UP/DOWN/PENDING/MAINTENANCE states with the most recent heartbeat message. Use this when asked "how is everything doing?", "what\'s down?", "what\'s up?", or for any general status overview. Returns essential information (ID, name, pathName, active state, maintenance state, status, message). Optionally filter by keywords in the pathName.',
      inputSchema: {
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive). All keywords must match for a monitor to be included.')
      },
      outputSchema: { 
        summaries: z.array(z.object({
          id: z.number(),
          name: z.string(),
          pathName: z.string(),
          active: z.boolean(),
          maintenance: z.boolean(),
          status: z.number().optional().describe('0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE'),
          msg: z.string().optional().describe('Status message from the most recent heartbeat'),
        })).describe('Array of monitor summaries'),
        count: z.number()
      },
    },
    async ({ keywords }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const summaries = client.getMonitorSummary(keywords);
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(summaries, null, 2) 
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

  // Register getHeartbeats tool
  server.registerTool(
    'getHeartbeats',
    {
      title: 'Get Heartbeats',
      description: 'Retrieves historical heartbeat data for a specific monitor (response times, status changes over time). Use this for analyzing patterns or history for one monitor. By default returns only the most recent heartbeat; set maxHeartbeats (up to 100) for historical analysis. Keep maxHeartbeats ≤10 unless user requests more.',
      inputSchema: {
        monitorID: z.number().int().positive().describe('The ID of the monitor to get heartbeats for'),
        maxHeartbeats: z.number().int().positive().max(100).optional().describe('If set, returns the most recent X heartbeats (up to 100). If unset, returns only the most recent heartbeat (default: 1)')
      },
      outputSchema: { 
        monitorID: z.number(),
        heartbeats: z.array(HeartbeatSchema),
        count: z.number()
      },
    },
    async ({ monitorID, maxHeartbeats }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const count = maxHeartbeats ?? 1;
        const heartbeatsArray = client.getHeartbeatsForMonitor(monitorID, count);
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(heartbeatsArray, null, 2) 
          }],
          structuredContent: { 
            monitorID,
            heartbeats: heartbeatsArray,
            count: heartbeatsArray.length 
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get heartbeats: ${errorMessage}`
        );
      }
    }
  );

  // Register listAllHeartbeats tool
  server.registerTool(
    'listHeartbeats',
    {
      title: 'List Heartbeats',
      description: 'Retrieves historical heartbeat data for ALL monitors (response times, status changes over time). Use this for analyzing patterns across multiple monitors or correlating events. By default returns only the most recent heartbeat per monitor; set maxHeartbeats (up to 100) for historical analysis. Keep maxHeartbeats ≤5 unless user requests more.',
      inputSchema: {
        maxHeartbeats: z.number().int().positive().max(100).optional().describe('If set, returns the most recent X heartbeats per monitor (up to 100). If unset, returns only the most recent heartbeat per monitor (default: 1)')
      },
      outputSchema: { 
        heartbeats: z.record(z.string(), z.array(HeartbeatSchema)).describe('Map of monitor IDs to their heartbeat arrays'),
        monitorCount: z.number(),
        totalHeartbeatCount: z.number()
      },
    },
    async ({ maxHeartbeats }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const count = maxHeartbeats ?? 1;
        const heartbeatList = client.getHeartbeatList(count);
        
        // Calculate total heartbeat count
        const totalCount = Object.values(heartbeatList).reduce(
          (sum, heartbeats) => sum + heartbeats.length, 
          0
        );
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(heartbeatList, null, 2) 
          }],
          structuredContent: { 
            heartbeats: heartbeatList,
            monitorCount: Object.keys(heartbeatList).length,
            totalHeartbeatCount: totalCount
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list heartbeats: ${errorMessage}`
        );
      }
    }
  );

  // Clean up on server shutdown
  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    client.disconnect();
    process.exit(0);
  });

  return server;
}
