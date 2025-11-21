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
        This MCP server provides access to Uptime Kuma monitoring data. This data is useful if the user is asking
        for information about the status of a system, or historical uptime/downtime information.

        Monitors contain configuration information (URLs, check intervals, notification settings, etc.).
        Heartbeats contain actual status data (up/down status, response times, timestamps, etc.).
        To check if something is up or down, use heartbeat tools, not monitor tools.
        Prefer to use the 'getMonitorSummary' tool to get a quick overview of all monitors and their current status
        before using other monitor or heartbeat tools.
        
        Be clear in your response how many heartbeats you're consulting for status information.
        Do not exceed 5 heartbeats when using the 'listHeartbeats' tool unless the user asks you to.
        Do not exceed 10 heartbeats when using the 'getHeartbeats' tool unless the user asks you to.

        By default, monitor tools return only essential fields. Set includeAdditionalFields=true to get all available data.
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
      description: 'Retrieves detailed information about a specific monitor by its ID. By default returns only core fields; set includeAdditionalFields to true to return all fields.',
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
      description: 'Retrieves the full list of all monitors the user has access to. By default returns only core fields; set includeAdditionalFields to true to return all fields.',
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
      description: 'Retrieves a summarized list of all monitors with essential information (ID, name, pathName, active state, maintenance state) and the status and message from the most recent heartbeat. This is useful for getting a quick overview of all monitors. Optionally filter by keywords in the pathName of the monitor.',
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
      description: 'Retrieves heartbeats for a specific monitor. By default returns only the most recent heartbeat; set maxHeartbeats to return up to 100 heartbeats.',
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
      description: 'Retrieves the heartbeats for all monitors. By default, each monitor ID maps to an array of the one most recent heartbeat; set maxHeartbeats to return up to 100 heartbeats for each monitor.',
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
