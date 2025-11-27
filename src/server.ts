import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode, SetLevelRequestSchema, LoggingLevelSchema, type LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { UptimeKumaClient } from './uptime-kuma-client.js';
import { HeartbeatSchema, MonitorBaseSchema, MonitorSummarySchema, SettingsSchema } from './types/index.js';
import type { UptimeKumaConfig } from './types/index.js';
import { VERSION } from './version.js';

/**
 * Creates and configures the MCP server with tools, resources, and prompts
 * Note: Authentication must be done separately after connecting the transport
 */
export async function createServer(config: UptimeKumaConfig): Promise<{ server: McpServer; client: UptimeKumaClient; authenticateClient: () => Promise<void> }> {
  // Track current logging level (default: info)
  let currentLogLevel: LoggingLevel = 'info';

  const server = new McpServer(
    {
      name: 'mcp-uptime-kuma',
      version: VERSION,
    },
    {
      instructions: `
        This MCP server provides access to Uptime Kuma monitoring data for system status and uptime/downtime information.

        START with 'getMonitorSummary' for status overview questions ("how is everything?", "what's down?").
        Use 'getHeartbeats' or 'listHeartbeats' for historical data (limit to 5-10 heartbeats unless user requests more).
        Use 'listMonitors' only when you need configuration details (URLs, intervals, notification settings).
      `,
      capabilities: {
        logging: {}
      }
    }
  );

  // Handle logging level changes via the underlying server
  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const level = request.params?.level as LoggingLevel | undefined;
    if (level && LoggingLevelSchema.safeParse(level).success) {
      currentLogLevel = level;
      return {};
    }
    throw new McpError(ErrorCode.InvalidParams, `Invalid log level: ${level}`);
  });

  // Initialize Uptime Kuma client with a function to check if a log level should be sent
  // LoggingLevelSchema enum values are already in order: debug < info < notice < ... < emergency
  const logLevels = LoggingLevelSchema.options;
  const shouldLog = (level: LoggingLevel): boolean => {
    return logLevels.indexOf(level) >= logLevels.indexOf(currentLogLevel);
  };
  
  const client = new UptimeKumaClient(config.url, server, shouldLog);
  let isAuthenticated = false;
  
  // Function to authenticate the client (to be called after transport is connected)
  const authenticateClient = async () => {
    try {
      await client.connect();
      await client.login(config.username, config.password, config.token, config.jwtToken);

      // Logging in anonymously gives no indication that authentication failed.
      // So instead, we issue a getSettings call after login, to prove the connection is working.
      await client.getSettings();
      isAuthenticated = true;
      
      await server.sendLoggingMessage({
        level: 'info',
        data: 'Successfully authenticated with Uptime Kuma'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await server.sendLoggingMessage({
        level: 'error',
        data: `Failed to authenticate with Uptime Kuma: ${errorMessage}`
      });
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to authenticate with Uptime Kuma: ${errorMessage}`
      );
    }
  };

  // Register getMonitor tool
  server.registerTool(
    'getMonitor',
    {
      title: 'Get Monitor',
      description: 'Retrieves configuration details for a specific monitor by ID (URL, check interval, notification settings, etc.). Use this when you need to examine or modify settings for a specific monitor. For current status, use getMonitorSummary instead. By default returns only common fields plus runtime data (uptime, avgPing); set includeTypeSpecificFields to true to include type-specific fields (e.g., url for HTTP, hostname/port for TCP).',
      inputSchema: { 
        monitorID: z.number().int().nonnegative().describe('The ID of the monitor to retrieve'),
        includeTypeSpecificFields: z.boolean().optional().describe('Include type-specific fields (url, hostname, port, etc.) in addition to common fields. Default: false. When false, only returns MonitorBase fields plus uptime/avgPing.')
      },
      outputSchema: { 
        monitor: MonitorBaseSchema.passthrough().describe('Monitor object with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true.')
      },
    },
    async ({ monitorID, includeTypeSpecificFields }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const monitor = includeTypeSpecificFields 
          ? client.getMonitor(monitorID, true)
          : client.getMonitor(monitorID, false);
        
        if (!monitor) {
          throw new Error(`Monitor with ID ${monitorID} not found`);
        }
        
        const result = monitor;
        
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
      description: 'Retrieves configuration details for all monitors (URLs, check intervals, notification settings, etc.). Use this when you need to examine or modify monitor settings. For status checks ("how is everything doing?", "what\'s down?"), use getMonitorSummary instead. By default returns only common fields plus runtime data (uptime, avgPing); set includeTypeSpecificFields to true to include type-specific fields (e.g., url for HTTP, hostname/port for TCP). Supports filtering by keywords, type, active/maintenance status, and tags.',
      inputSchema: {
        includeTypeSpecificFields: z.boolean().optional().describe('Include type-specific fields (url, hostname, port, etc.) in addition to common fields. Default: false. When false, only returns MonitorBase fields plus uptime/avgPing.'),
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive fuzzy match). All keywords must match for a monitor to be included.'),
        type: z.string().optional().describe('Filter by monitor type(s). Comma-separated for multiple types. Use listMonitorTypes tool to see all available types.'),
        active: z.boolean().optional().describe('Filter by active status. true=only active monitors, false=only inactive monitors.'),
        maintenance: z.boolean().optional().describe('Filter by maintenance status. true=only monitors in maintenance, false=only monitors not in maintenance.'),
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"')
      },
      outputSchema: { 
        monitors: z.array(MonitorBaseSchema.passthrough()).describe('Array of monitor objects with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true.'),
        count: z.number()
      },
    },
    async ({ includeTypeSpecificFields, keywords, type, active, maintenance, tags }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const monitorList = includeTypeSpecificFields
          ? client.getMonitorList({ keywords, type, active, maintenance, tags, includeTypeSpecificFields: true })
          : client.getMonitorList({ keywords, type, active, maintenance, tags, includeTypeSpecificFields: false });
        const monitors = Object.values(monitorList);
        
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

  // Register listMonitorTypes tool
  server.registerTool(
    'listMonitorTypes',
    {
      title: 'List Monitor Types',
      description: 'Returns a list of all available monitor types supported by Uptime Kuma. Use this to discover valid values for type filters in other tools.',
      inputSchema: {},
      outputSchema: {
        types: z.array(z.object({
          type: z.string().describe('The monitor type identifier'),
          description: z.string().describe('Description of what this monitor type does')
        })).describe('Array of available monitor types')
      },
    },
    async () => {
      const monitorTypes = [
        { type: 'http', description: 'HTTP/HTTPS monitoring with status code and response time checks' },
        { type: 'keyword', description: 'HTTP monitoring that searches for a specific keyword in the response' },
        { type: 'json-query', description: 'HTTP monitoring that validates JSON response using JSONPath queries' },
        { type: 'port', description: 'TCP port connectivity check' },
        { type: 'ping', description: 'ICMP ping check' },
        { type: 'dns', description: 'DNS resolution check for A, AAAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, or CAA records' },
        { type: 'docker', description: 'Docker container status check' },
        { type: 'mqtt', description: 'MQTT broker connectivity and topic monitoring' },
        { type: 'mongodb', description: 'MongoDB database connectivity check' },
        { type: 'redis', description: 'Redis database connectivity check' },
        { type: 'sqlserver', description: 'SQL Server database connectivity check' },
        { type: 'postgres', description: 'PostgreSQL database connectivity check' },
        { type: 'mysql', description: 'MySQL/MariaDB database connectivity check' },
        { type: 'grpc-keyword', description: 'gRPC service health check with keyword validation' },
        { type: 'kafka-producer', description: 'Kafka producer connectivity and message publishing check' },
        { type: 'radius', description: 'RADIUS server authentication check' },
        { type: 'rabbitmq', description: 'RabbitMQ server connectivity check' },
        { type: 'smtp', description: 'SMTP server connectivity check' },
        { type: 'snmp', description: 'SNMP device monitoring with OID queries' },
        { type: 'real-browser', description: 'Real browser-based monitoring using Chrome/Chromium' },
        { type: 'gamedig', description: 'Game server status check using GameDig protocol' },
        { type: 'push', description: 'Push-based monitoring (monitor receives heartbeats from external sources)' },
        { type: 'group', description: 'Group/folder for organizing monitors (not an actual check)' },
        { type: 'tailscale-ping', description: 'Tailscale network ping check' },
        { type: 'manual', description: 'Manual status monitor (status set manually, not automatically checked)' }
      ];
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify(monitorTypes, null, 2) 
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
      description: 'START HERE for status overview questions. Retrieves current status for all monitors showing UP/DOWN/PENDING/MAINTENANCE states with the most recent heartbeat message. Use this when asked "how is everything doing?", "what\'s down?", "what\'s up?", or for any general status overview. Returns essential information (ID, name, pathName, active state, maintenance state, status, message, type, tags). Supports filtering by keywords, type, active/maintenance status, tags, and current status.',
      inputSchema: {
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive fuzzy match). All keywords must match for a monitor to be included.'),
        type: z.string().optional().describe('Filter by monitor type(s). Comma-separated for multiple types. Use listMonitorTypes tool to see all available types.'),
        active: z.boolean().optional().describe('Filter by active status. true=only active monitors, false=only inactive monitors.'),
        maintenance: z.boolean().optional().describe('Filter by maintenance status. true=only monitors in maintenance, false=only monitors not in maintenance.'),
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"'),
        status: z.string().optional().describe('Filter by current heartbeat status. Comma-separated for multiple statuses. 0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE. Examples: "0", "1", "0,2"')
      },
      outputSchema: { 
        summaries: z.array(MonitorSummarySchema).describe('Array of monitor summaries'),
        count: z.number()
      },
    },
    async ({ keywords, type, active, maintenance, tags, status }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const summaries = client.getMonitorSummary({ keywords, type, active, maintenance, tags, status });
        
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
        monitorID: z.number().int().nonnegative().describe('The ID of the monitor to get heartbeats for'),
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

  // Register getSettings tool
  server.registerTool(
    'getSettings',
    {
      title: 'Get Settings',
      description: 'Retrieves the current Uptime Kuma server settings including timezone, authentication status, primary base URL, and other configuration options.',
      inputSchema: {},
      outputSchema: {
        settings: SettingsSchema.describe('Current Uptime Kuma server settings')
      },
    },
    async () => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const response = await client.getSettings();
        
        if (!response.data) {
          throw new Error('No settings data returned');
        }
        
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }],
          structuredContent: { settings: response.data },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get settings: ${errorMessage}`
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

  // Register pauseMonitor tool
  server.registerTool(
    'pauseMonitor',
    {
      title: 'Pause Monitor',
      description: 'Pauses a monitor, stopping it from performing checks. The monitor will remain in the system but will not send notifications or collect data until resumed.',
      inputSchema: {
        monitorID: z.number().int().nonnegative().describe('The ID of the monitor to pause')
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional()
      },
    },
    async ({ monitorID }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const response = await client.pauseMonitor(monitorID);
        
        return {
          content: [{ 
            type: 'text', 
            text: response.msg || `Monitor ${monitorID} paused successfully` 
          }],
          structuredContent: {
            ok: response.ok,
            msg: response.msg
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to pause monitor: ${errorMessage}`
        );
      }
    }
  );

  // Register resumeMonitor tool
  server.registerTool(
    'resumeMonitor',
    {
      title: 'Resume Monitor',
      description: 'Resumes a paused monitor, restarting all checks. Use this to re-enable monitoring after pausing.',
      inputSchema: {
        monitorID: z.number().int().nonnegative().describe('The ID of the monitor to resume')
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional()
      },
    },
    async ({ monitorID }) => {
      if (!isAuthenticated) {
        throw new McpError(
          ErrorCode.InternalError,
          'Not authenticated with Uptime Kuma'
        );
      }

      try {
        const response = await client.resumeMonitor(monitorID);
        
        return {
          content: [{ 
            type: 'text', 
            text: response.msg || `Monitor ${monitorID} resumed successfully` 
          }],
          structuredContent: {
            ok: response.ok,
            msg: response.msg
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to resume monitor: ${errorMessage}`
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

  return { server, client, authenticateClient };
}
