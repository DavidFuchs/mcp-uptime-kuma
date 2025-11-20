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
      version: '0.1.0',
    },
    {
      instructions: `
        This MCP server provides access to Uptime Kuma monitoring data.

        Available tools:
        - getMonitor: Retrieve configuration and details for a specific monitor by ID
        - listMonitors: Get all monitors with their configurations
        - getHeartbeats: Retrieve status checks and uptime data for a specific monitor
        - listAllHeartbeats: Get status checks and uptime data for all monitors

        Monitors contain configuration information (URLs, check intervals, notification settings, etc.).
        Heartbeats contain actual status data (up/down status, response times, timestamps, etc.).
        To check if something is up or down, use heartbeat tools, not monitor tools.

        By default, tools return only essential fields. Set includeAdditionalFields=true to get all available data.
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
      description: 'Retrieves detailed information about a specific monitor by its ID',
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
      description: 'Retrieves the full list of all monitors the user has access to from the cache. By default returns all fields; set includeAdditionalFields to false to return only defined fields.',
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

  // Register getHeartbeats tool
  server.registerTool(
    'getHeartbeats',
    {
      title: 'Get Heartbeats',
      description: 'Retrieves heartbeats for a specific monitor from the cache. By default returns up to 100 most recent heartbeats; set includeAll to false to return only the most recent heartbeat.',
      inputSchema: {
        monitorID: z.number().int().positive().describe('The ID of the monitor to get heartbeats for'),
        includeAll: z.boolean().optional().describe('If true, returns all heartbeats (up to 100). If false, returns only the most recent heartbeat (default: false)')
      },
      outputSchema: { 
        monitorID: z.number(),
        heartbeats: z.array(HeartbeatSchema),
        count: z.number()
      },
    },
    async ({ monitorID, includeAll }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const includeAllFlag = includeAll ?? false;
        let heartbeatsArray: any[];
        
        if (includeAllFlag) {
          heartbeatsArray = client.getHeartbeatsForMonitor(monitorID, true);
        } else {
          const singleHeartbeat = client.getHeartbeatsForMonitor(monitorID, false);
          heartbeatsArray = singleHeartbeat ? [singleHeartbeat] : [];
        }
        
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
    'listAllHeartbeats',
    {
      title: 'List All Heartbeats',
      description: 'Retrieves the complete heartbeat list for all monitors from the cache. By default, each monitor ID maps to an array of up to 100 recent heartbeats; set includeAll to false to return only the most recent heartbeat per monitor.',
      inputSchema: {
        includeAll: z.boolean().optional().describe('If true, returns all heartbeats (up to 100 per monitor). If false, returns only the most recent heartbeat per monitor (default: false)')
      },
      outputSchema: { 
        heartbeats: z.record(z.string(), z.array(HeartbeatSchema)).describe('Map of monitor IDs to their heartbeat arrays'),
        monitorCount: z.number(),
        totalHeartbeatCount: z.number()
      },
    },
    async ({ includeAll }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const includeAllFlag = includeAll ?? false;
        const rawHeartbeatList = includeAllFlag 
          ? client.getHeartbeatList(true)
          : client.getHeartbeatList(false);
        
        // Normalize to always return arrays for consistent schema
        const heartbeatList: { [monitorID: string]: any[] } = {};
        for (const [monitorID, heartbeats] of Object.entries(rawHeartbeatList)) {
          if (includeAllFlag) {
            heartbeatList[monitorID] = heartbeats as any[];
          } else {
            heartbeatList[monitorID] = heartbeats ? [heartbeats] : [];
          }
        }
        
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
