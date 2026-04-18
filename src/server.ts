import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode, SetLevelRequestSchema, LoggingLevelSchema, type LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { UptimeKumaClient } from './uptime-kuma-client.js';
import { HeartbeatSchema, MonitorBaseSchema, MonitorSummarySchema, SettingsSchema, NotificationSchema, MaintenanceSchema, StatusPageSchema } from './types/index.js';
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
        This MCP server provides access to Uptime Kuma monitoring data and management operations.

        READ operations:
        - START with 'getMonitorSummary' for status overview ("how is everything?", "what's down?").
        - Use 'getHeartbeats' or 'listHeartbeats' for historical data (limit to 5-10 heartbeats unless user requests more).
        - Use 'listMonitors' when you need configuration details (URLs, intervals, notification settings).
        - Use 'listNotifications' to see notification channels.
        - Use 'listTags' to see available tags.
        - Use 'getMaintenanceWindows' to see scheduled maintenance.
        - Use 'listStatusPages' to see status page configurations, or 'getStatusPage' for one page's full details (groups + monitors).

        WRITE operations:
        - Use 'createMonitor' / 'updateMonitor' / 'deleteMonitor' to manage monitors.
        - Use 'addNotification' / 'updateNotification' / 'deleteNotification' to manage notification channels.
        - Use 'addTag' / 'deleteTag' to manage tags.
        - Use 'createMaintenance' to schedule a maintenance window.
        - Use 'createStatusPage' / 'updateStatusPage' / 'deleteStatusPage' to manage status pages. Creating returns an empty page — follow up with updateStatusPage to set groups and monitors.
        - Use 'pauseMonitor' / 'resumeMonitor' to temporarily stop/start checks.
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
        monitorID: z.coerce.number().int().nonnegative().describe('The ID of the monitor to retrieve'),
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
        monitorID: z.coerce.number().int().nonnegative().describe('The ID of the monitor to get heartbeats for'),
        maxHeartbeats: z.coerce.number().int().positive().max(100).optional().describe('If set, returns the most recent X heartbeats (up to 100). If unset, returns only the most recent heartbeat (default: 1)')
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
        maxHeartbeats: z.coerce.number().int().positive().max(100).optional().describe('If set, returns the most recent X heartbeats per monitor (up to 100). If unset, returns only the most recent heartbeat per monitor (default: 1)')
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
        monitorID: z.coerce.number().int().nonnegative().describe('The ID of the monitor to pause')
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
        monitorID: z.coerce.number().int().nonnegative().describe('The ID of the monitor to resume')
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

  // ─── Monitor write tools ──────────────────────────────────────────────────

  server.registerTool(
    'createMonitor',
    {
      title: 'Create Monitor',
      description: 'Creates a new monitor in Uptime Kuma. Requires at minimum a name and type. Use listMonitorTypes to see supported types. For HTTP monitors include url; for TCP/port monitors include hostname and port.',
      inputSchema: {
        name: z.string().describe('Display name for the monitor'),
        type: z.string().describe('Monitor type (e.g. http, port, ping, dns, push, keyword). Use listMonitorTypes for all options.'),
        url: z.string().optional().describe('URL to monitor (required for http/keyword/json-query types)'),
        hostname: z.string().optional().describe('Hostname to monitor (required for port/ping/dns types)'),
        port: z.coerce.number().optional().describe('Port number (required for port/tcp types)'),
        interval: z.coerce.number().optional().describe('Check interval in seconds (default: 60)'),
        retryInterval: z.coerce.number().optional().describe('Retry interval in seconds when monitor is down (default: 60)'),
        maxretries: z.coerce.number().optional().describe('Max retries before marking as down (default: 0)'),
        notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Map of notification IDs to enable (e.g. {"1": true, "3": true})'),
        tags: z.array(z.object({
          name: z.string(),
          value: z.string().optional(),
          color: z.string().optional(),
        })).optional().describe('Tags to assign to the monitor'),
        keyword: z.string().optional().describe('Keyword to search for (keyword monitor type)'),
        invertKeyword: z.boolean().optional().describe('Invert keyword match'),
        method: z.string().optional().describe('HTTP method (GET, POST, etc.) for http type'),
        body: z.string().optional().describe('HTTP request body'),
        headers: z.string().optional().describe('HTTP headers as JSON string'),
        accepted_statuscodes: z.array(z.string()).optional().describe('Accepted HTTP status codes (e.g. ["200-299"])'),
        ignoreTls: z.boolean().optional().describe('Ignore TLS/SSL errors'),
        maxredirects: z.coerce.number().optional().describe('Max HTTP redirects (default: 10)'),
        upsideDown: z.boolean().optional().describe('Invert status — treat up as down'),
        parent: z.coerce.number().nullable().optional().describe('Parent group monitor ID'),
      },
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async (input) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const monitorData = {
          notificationIDList: {},
          accepted_statuscodes: ['200-299'],
          conditions: [],
          ...input,
        };
        const response = await client.createMonitor(monitorData as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: response.msg || `Monitor created with ID ${response.monitorID}` }],
          structuredContent: { ok: response.ok, monitorID: response.monitorID, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create monitor: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateMonitor',
    {
      title: 'Update Monitor',
      description: 'Updates an existing monitor configuration. You must include the monitorID. Only the fields you provide will be changed (the server merges your changes with the existing config). Use getMonitor first to get the current config.',
      inputSchema: {
        monitorID: z.coerce.number().int().nonnegative().describe('The ID of the monitor to update'),
        name: z.string().optional().describe('Display name'),
        url: z.string().optional().describe('URL to monitor'),
        hostname: z.string().optional().describe('Hostname'),
        port: z.coerce.number().optional().describe('Port number'),
        interval: z.coerce.number().optional().describe('Check interval in seconds'),
        retryInterval: z.coerce.number().optional().describe('Retry interval in seconds'),
        maxretries: z.coerce.number().optional().describe('Max retries before marking as down'),
        notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Notification ID map'),
        tags: z.array(z.object({
          name: z.string(),
          value: z.string().optional(),
          color: z.string().optional(),
        })).optional().describe('Tags to assign'),
        keyword: z.string().optional().describe('Keyword to search for'),
        invertKeyword: z.boolean().optional().describe('Invert keyword match'),
        method: z.string().optional().describe('HTTP method'),
        body: z.string().optional().describe('HTTP request body'),
        headers: z.string().optional().describe('HTTP headers as JSON string'),
        accepted_statuscodes: z.array(z.string()).optional().describe('Accepted HTTP status codes'),
        ignoreTls: z.boolean().optional().describe('Ignore TLS/SSL errors'),
        maxredirects: z.coerce.number().optional().describe('Max HTTP redirects'),
        upsideDown: z.boolean().optional().describe('Invert status'),
        active: z.boolean().optional().describe('Whether the monitor is active'),
      },
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorID, ...rest }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const existing = client.getMonitor(monitorID, true);
        if (!existing) {
          throw new Error(`Monitor ${monitorID} not found`);
        }
        const merged = { ...existing, ...rest, id: monitorID };
        const response = await client.updateMonitor(merged as unknown as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: response.msg || `Monitor ${monitorID} updated successfully` }],
          structuredContent: { ok: response.ok, monitorID: response.monitorID, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update monitor: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteMonitor',
    {
      title: 'Delete Monitor',
      description: 'Permanently deletes a monitor and all its heartbeat history. This action cannot be undone.',
      inputSchema: {
        monitorID: z.coerce.number().int().nonnegative().describe('The ID of the monitor to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorID }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.deleteMonitor(monitorID);
        return {
          content: [{ type: 'text', text: response.msg || `Monitor ${monitorID} deleted successfully` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete monitor: ${errorMessage}`);
      }
    }
  );

  // ─── Notification tools ───────────────────────────────────────────────────

  server.registerTool(
    'listNotifications',
    {
      title: 'List Notifications',
      description: 'Returns all configured notification channels (Slack, ntfy, Discord, email, webhooks, etc.).',
      inputSchema: {},
      outputSchema: {
        notifications: z.array(NotificationSchema).describe('Array of notification channel configurations'),
        count: z.number(),
      },
    },
    async () => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const notifications = client.getNotificationList();
        return {
          content: [{ type: 'text', text: JSON.stringify(notifications, null, 2) }],
          structuredContent: { notifications, count: notifications.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list notifications: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addNotification',
    {
      title: 'Add Notification',
      description: 'Creates a new notification channel. The configuration fields depend on the notification type (e.g., for slack: webhookURL; for ntfy: ntfyTopic, ntfyServerUrl; for discord: discordWebhookUrl).',
      inputSchema: {
        name: z.string().describe('Human-readable name for this notification channel'),
        type: z.string().describe('Notification type (e.g. slack, ntfy, discord, telegram, webhook, smtp)'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Apply this notification to all existing monitors now'),
        config: z.record(z.string(), z.unknown()).describe('Type-specific configuration fields (e.g. webhookURL for slack, ntfyTopic for ntfy)'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, type, isDefault, applyExisting, config }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const notification = { name, type, isDefault, applyExisting, ...config };
        const response = await client.addNotification(notification as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: response.msg || `Notification created with ID ${response.id}` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add notification: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateNotification',
    {
      title: 'Update Notification',
      description: 'Updates an existing notification channel. Use listNotifications to find the notification ID.',
      inputSchema: {
        notificationID: z.coerce.number().int().nonnegative().describe('The ID of the notification to update'),
        name: z.string().optional().describe('Human-readable name'),
        type: z.string().optional().describe('Notification type'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Apply to all existing monitors now'),
        config: z.record(z.string(), z.unknown()).optional().describe('Type-specific configuration fields to update'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ notificationID, name, type, isDefault, applyExisting, config }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const notification: Record<string, unknown> = { ...config };
        if (name !== undefined) notification['name'] = name;
        if (type !== undefined) notification['type'] = type;
        if (isDefault !== undefined) notification['isDefault'] = isDefault;
        if (applyExisting !== undefined) notification['applyExisting'] = applyExisting;
        const response = await client.addNotification(notification, notificationID);
        return {
          content: [{ type: 'text', text: response.msg || `Notification ${notificationID} updated` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update notification: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteNotification',
    {
      title: 'Delete Notification',
      description: 'Permanently deletes a notification channel. Monitors that used this channel will no longer send alerts through it.',
      inputSchema: {
        notificationID: z.coerce.number().int().nonnegative().describe('The ID of the notification to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ notificationID }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.deleteNotification(notificationID);
        return {
          content: [{ type: 'text', text: response.msg || `Notification ${notificationID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete notification: ${errorMessage}`);
      }
    }
  );

  // ─── Tag tools ───────────────────────────────────────────────────────────

  server.registerTool(
    'listTags',
    {
      title: 'List Tags',
      description: 'Returns all tags defined in Uptime Kuma (name, color, and ID).',
      inputSchema: {},
      outputSchema: {
        tags: z.array(z.object({
          id: z.number(),
          name: z.string(),
          color: z.string(),
        })).describe('Array of tags'),
        count: z.number(),
      },
    },
    async () => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const tags = client.getTagList();
        return {
          content: [{ type: 'text', text: JSON.stringify(tags, null, 2) }],
          structuredContent: { tags, count: tags.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list tags: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addTag',
    {
      title: 'Add Tag',
      description: 'Creates a new tag that can be assigned to monitors.',
      inputSchema: {
        name: z.string().describe('Tag name'),
        color: z.string().describe('Tag color as a hex string (e.g. "#ff0000") or CSS color name'),
      },
      outputSchema: {
        ok: z.boolean(),
        tag: z.object({ id: z.number(), name: z.string(), color: z.string() }).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, color }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.addTag(name, color);
        return {
          content: [{ type: 'text', text: `Tag "${name}" created with ID ${response.tag?.id}` }],
          structuredContent: { ok: response.ok, tag: response.tag, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add tag: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteTag',
    {
      title: 'Delete Tag',
      description: 'Permanently deletes a tag. It will be removed from all monitors that use it. Use listTags to find the tag ID.',
      inputSchema: {
        tagID: z.coerce.number().int().nonnegative().describe('The ID of the tag to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ tagID }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.deleteTag(tagID);
        return {
          content: [{ type: 'text', text: response.msg || `Tag ${tagID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete tag: ${errorMessage}`);
      }
    }
  );

  // ─── Maintenance tools ────────────────────────────────────────────────────

  server.registerTool(
    'getMaintenanceWindows',
    {
      title: 'Get Maintenance Windows',
      description: 'Returns all scheduled maintenance windows defined in Uptime Kuma.',
      inputSchema: {},
      outputSchema: {
        maintenanceWindows: z.array(MaintenanceSchema).describe('Array of maintenance windows'),
        count: z.number(),
      },
    },
    async () => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const maintenanceWindows = client.getMaintenanceList();
        return {
          content: [{ type: 'text', text: JSON.stringify(maintenanceWindows, null, 2) }],
          structuredContent: { maintenanceWindows, count: maintenanceWindows.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get maintenance windows: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createMaintenance',
    {
      title: 'Create Maintenance',
      description: 'Schedules a new maintenance window. During maintenance, affected monitors are suppressed and show MAINTENANCE status instead of DOWN.',
      inputSchema: {
        title: z.string().describe('Title of the maintenance window'),
        description: z.string().optional().describe('Description or reason for the maintenance'),
        strategy: z.enum(['single', 'recurring-interval', 'recurring-weekday', 'recurring-day-of-month', 'manual'])
          .describe('Scheduling strategy: single=one-time, recurring-interval=every N days, recurring-weekday=specific weekdays, recurring-day-of-month=specific dates, manual=manually activated'),
        active: z.boolean().optional().describe('Whether the window is active (default: true)'),
        timezone: z.string().optional().describe('Timezone (e.g. "America/New_York", "UTC"). Defaults to server timezone.'),
        dateRange: z.array(z.string()).optional().describe('Date range as [startISO, endISO] (required for single strategy)'),
        timeRange: z.array(z.object({ hours: z.coerce.number(), minutes: z.coerce.number() })).optional()
          .describe('Start and end time within the day as [{hours, minutes}, {hours, minutes}]'),
        weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional()
          .describe('Days of week (0=Sunday … 6=Saturday) for recurring-weekday strategy'),
        daysOfMonth: z.array(z.coerce.number().int().min(1).max(31)).optional()
          .describe('Days of month (1-31) for recurring-day-of-month strategy'),
        intervalDay: z.coerce.number().int().positive().optional()
          .describe('Interval in days for recurring-interval strategy'),
      },
      outputSchema: {
        ok: z.boolean(),
        maintenanceID: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async (input) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.createMaintenance(input as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: response.msg || `Maintenance window created with ID ${response.maintenanceID}` }],
          structuredContent: { ok: response.ok, maintenanceID: response.maintenanceID, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create maintenance window: ${errorMessage}`);
      }
    }
  );

  // ─── Status page tools ────────────────────────────────────────────────────

  server.registerTool(
    'listStatusPages',
    {
      title: 'List Status Pages',
      description: 'Returns all configured status pages with their slug, title, visibility, and custom domain settings.',
      inputSchema: {},
      outputSchema: {
        statusPages: z.array(StatusPageSchema).describe('Array of status page configurations'),
        count: z.number(),
      },
    },
    async () => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const statusPages = client.getStatusPageList();
        return {
          content: [{ type: 'text', text: JSON.stringify(statusPages, null, 2) }],
          structuredContent: { statusPages, count: statusPages.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list status pages: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'getStatusPage',
    {
      title: 'Get Status Page',
      description: 'Returns the full configuration of a status page by slug, including the ordered list of groups, the monitors inside each group, and active incidents. Only works for published status pages (fetches the public `/api/status-page/{slug}` endpoint).',
      inputSchema: {
        slug: z.string().describe('The status page slug (the URL-safe identifier)'),
      },
      outputSchema: {
        ok: z.boolean(),
        config: StatusPageSchema.optional(),
        publicGroupList: z.array(z.record(z.string(), z.unknown())).optional().describe('Ordered groups with their monitorList'),
        incidents: z.array(z.record(z.string(), z.unknown())).optional().describe('Active incidents on the status page'),
        msg: z.string().optional(),
      },
    },
    async ({ slug }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.getStatusPage(slug);
        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
          structuredContent: {
            ok: response.ok,
            config: response.config,
            publicGroupList: response.publicGroupList as Array<Record<string, unknown>> | undefined,
            incidents: response.incidents as Array<Record<string, unknown>> | undefined,
            msg: response.msg,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createStatusPage',
    {
      title: 'Create Status Page',
      description: 'Creates a new (empty) status page with the given title and slug. After creating, call updateStatusPage to set the description, theme, groups, and monitors. Slug must be lowercase letters, digits, and dashes only.',
      inputSchema: {
        title: z.string().describe('Display title of the status page'),
        slug: z.string().regex(/^[a-z0-9-]+$/).describe('URL slug (lowercase letters, digits, and dashes only)'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ title, slug }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.createStatusPage(title, slug);
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} created` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateStatusPage',
    {
      title: 'Update Status Page',
      description: 'Updates an existing status page. Pass the full config (title, description, theme, published, etc.) and the full publicGroupList — both are replaced wholesale. Each group has a name, weight, and monitorList of [{id}]. Use getStatusPage first to read current state before modifying.',
      inputSchema: {
        slug: z.string().describe('The status page slug (immutable identifier)'),
        config: z.record(z.string(), z.unknown()).describe('Full status page config (title, description, theme, published, showTags, showPoweredBy, domainNameList, customCSS, footerText, icon, etc.)'),
        publicGroupList: z.array(z.record(z.string(), z.unknown())).optional().describe('Ordered groups. Each: {name, weight, monitorList: [{id}]}. Defaults to empty list.'),
        imgDataUrl: z.string().optional().describe('Icon as data URL. Omit or pass empty string to keep existing.'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug, config, publicGroupList, imgDataUrl }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.updateStatusPage(
          slug,
          config,
          publicGroupList ?? [],
          imgDataUrl ?? ''
        );
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} updated` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteStatusPage',
    {
      title: 'Delete Status Page',
      description: 'Permanently deletes a status page by slug. The status page URL will no longer be accessible.',
      inputSchema: {
        slug: z.string().describe('The status page slug to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug }) => {
      if (!isAuthenticated) {
        throw new McpError(ErrorCode.InternalError, 'Not authenticated with Uptime Kuma');
      }

      try {
        const response = await client.deleteStatusPage(slug);
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete status page: ${errorMessage}`);
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
