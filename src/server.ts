import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode, SetLevelRequestSchema, LoggingLevelSchema, type LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomBytes, randomInt } from 'node:crypto';
import { UptimeKumaClient } from './uptime-kuma-client.js';
import { HeartbeatSchema, MonitorBaseSchema, MonitorSummarySchema, SettingsSchema, NotificationSchema, MaintenanceSchema, StatusPageSchema, DockerHostSchema } from './types/index.js';
import type { UptimeKumaConfig } from './types/index.js';
import {
  INCLUDE_SECRETS_DESCRIPTION,
  redactNotifications,
  redactSecrets,
  rehydrateSecrets,
  rehydrateUrlCredentials,
} from './redact.js';
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
        - Use 'listDockerHosts' to see configured docker daemons (used by docker container monitors).

        WRITE operations:
        - Use 'createMonitor' / 'updateMonitor' / 'deleteMonitor' to manage monitors.
        - Use 'addNotification' / 'updateNotification' / 'deleteNotification' to manage notification channels.
        - Use 'addTag' / 'deleteTag' to manage tags.
        - Use 'createMaintenance' to schedule a maintenance window.
        - Use 'addDockerHost' / 'updateDockerHost' / 'deleteDockerHost' to manage docker daemon connections.
        - Use 'testDockerHost' to verify a docker daemon is reachable before saving.
        - Use 'createStatusPage' / 'updateStatusPage' / 'deleteStatusPage' to manage status pages. Creating returns an empty page — follow up with updateStatusPage to set groups and monitors.
        - Use 'pauseMonitor' / 'resumeMonitor' to temporarily stop/start checks.

        CREDENTIALS:
        - Read tools return "***" in place of passwords, tokens, API keys and HTTP headers.
          To attach a notification channel to a monitor you only need its id, so the common
          workflows never need the real values.
        - Pass includeSecrets: true (or set UPTIME_KUMA_INCLUDE_SECRETS=true) only when the
          value itself is needed. It will be written to this conversation's transcript.
        - "***" sent back to updateMonitor / updateNotification restores the stored value
          rather than overwriting it, so a read-edit-write round trip is safe.
      `,
      capabilities: {
        logging: {}
      }
    }
  );

  // Reject unknown keys instead of silently stripping them.
  //
  // registerTool is normally handed a raw Zod *shape*, which the SDK turns into a plain
  // z.object(shape). A plain object schema DROPS keys it doesn't know about rather than
  // erroring, and the write handlers then merge what survived over the monitor's existing
  // config — so a field this server doesn't declare is refilled with its old value and
  // Uptime Kuma answers {"ok":true,"msg":"Saved."}. A partial write reported as a complete
  // one. That is the shared mechanism behind #58, #60, #63 and #65; each was reported
  // separately because there is nothing in the response to connect them.
  //
  // getZodSchemaObject / normalizeObjectSchema both accept an already-built Zod object and
  // pass it through untouched, so upgrading every shape to .strict() here converts the whole
  // class from silent data loss into a loud error that names the offending key. It also puts
  // additionalProperties: false into the advertised JSON Schema, so callers are told up front
  // rather than discovering it from a write that didn't happen.
  //
  // Done by wrapping the method once rather than editing ~31 schemas by hand: one seam, no
  // chance of missing one, and it covers any tool added later.
  const registerToolUnstrict = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: Record<string, unknown>,
    cb: unknown
  ) => {
    const shape = config?.inputSchema as Record<string, unknown> | undefined;
    // Only upgrade raw shapes; anything already a Zod schema is left alone.
    if (shape && typeof shape === 'object' && !('_def' in shape) && !('_zod' in shape)) {
      config = { ...config, inputSchema: strictInputSchema(name, shape as z.ZodRawShape) };
    }
    return (registerToolUnstrict as unknown as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as typeof server.registerTool;

  /**
   * Builds the strict schema, and makes an unknown key the FIRST thing the caller reads.
   *
   * Zod appends `unrecognized_keys` after the per-field issues, which leaves the second half
   * of #65 intact: `getMonitor {monitorId: 1}` reports BOTH "unknown key monitorId" and
   * "monitorID: expected number, received nan" — because z.coerce.number() coerces the
   * now-missing monitorID to NaN — and the NaN line comes first. That line is the misleading
   * one: it points at a field the caller never got wrong. Reordering turns a message that
   * sends you hunting for a type bug into one that says "you misspelled this key".
   */
  function strictInputSchema(toolName: string, shape: z.ZodRawShape) {
    const schema = z.object(shape).strict();
    const accepted = Object.keys(shape);

    const reorder = (result: z.SafeParseReturnType<unknown, unknown>) => {
      if (result.success) return result;
      const issues = result.error?.issues;
      if (!Array.isArray(issues)) return result;
      const unknown = issues.filter((i) => i.code === 'unrecognized_keys');
      if (unknown.length === 0) return result;

      const named = unknown.flatMap((i) => (i as z.ZodIssue & { keys?: string[] }).keys ?? []);
      const lead = {
        code: 'unrecognized_keys',
        keys: named,
        path: [],
        message:
          `Unknown field(s) for ${toolName}: ${named.map((k) => `'${k}'`).join(', ')}. ` +
          'Field names are case-sensitive — check spelling and casing first (monitorID, not monitorId). ' +
          `Accepted fields: ${accepted.join(', ')}. ` +
          'Any other issue reported below may be a knock-on effect of this one: a required field ' +
          'that looks absent is usually the misspelled key.',
      } as unknown as z.ZodIssue;
      const rest = issues.filter((i) => i.code !== 'unrecognized_keys');
      return { success: false as const, error: new z.ZodError([lead, ...rest]) };
    };

    const safeParse = schema.safeParse.bind(schema);
    const safeParseAsync = schema.safeParseAsync.bind(schema);
    (schema as unknown as { safeParse: unknown }).safeParse = (data: unknown, params?: unknown) =>
      reorder(safeParse(data, params as never));
    (schema as unknown as { safeParseAsync: unknown }).safeParseAsync = async (data: unknown, params?: unknown) =>
      reorder(await safeParseAsync(data, params as never));

    return schema;
  }

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

  // Issue #59: read tools withhold credentials by default. Captured here because the
  // registerTool wrapper above shadows `config` with the per-tool registration object.
  //
  // The env var is the global switch and the per-call `includeSecrets` parameter is the
  // narrow one; the parameter wins where both are present, in either direction, so a
  // globally-permissive deployment can still ask a single call to redact.
  const includeSecretsByDefault = config.includeSecrets === true;
  const wantsSecrets = (perCall?: boolean): boolean =>
    perCall === undefined ? includeSecretsByDefault : perCall;
  const includeSecretsParam = z.boolean().optional().describe(INCLUDE_SECRETS_DESCRIPTION);

  let isAuthenticated = false;
  let authInFlight: Promise<void> | null = null;

  // The client reports when the authenticated session is known to be gone (socket dropped,
  // or a re-auth on reconnect was refused). Clearing the flag here is what lets the next
  // tool call transparently re-authenticate, instead of the process staying wedged.
  client.onAuthLost = (reason: string) => {
    if (!isAuthenticated) return;
    isAuthenticated = false;
    process.stderr.write(`Uptime Kuma session invalidated: ${reason}. Will re-authenticate on next call.\n`);
  };

  // UPTIME_KUMA_JWT_TOKEN must be a real JWT — Uptime Kuma verifies it with jwt.verify()
  // against its jwtSecret. Anything else (a password, an API key, a truncated paste) is
  // rejected with the opaque message "authInvalidToken", which reads exactly like an
  // expired credential and sends you looking for a token-lifetime problem that isn't there.
  // Only the credential's SHAPE is ever reported — never its value.
  const describeCredential = (): string | null => {
    const t = config.jwtToken;
    if (!t) return null;
    const segments = String(t).split('.').length;
    if (segments === 3) return null;
    return `UPTIME_KUMA_JWT_TOKEN is not a JWT: it has ${segments} dot-separated segment(s), expected 3 `
      + `(length ${String(t).length}). Uptime Kuma will always reject this with "authInvalidToken". `
      + `Generate a real token with: mcp-uptime-kuma-get-jwt ${config.url} <username> <password>. `
      + 'Note this variable may also be set in your shell environment as well as your MCP client '
      + 'config — check both and make sure they agree.';
  };

  // Function to authenticate the client (to be called after transport is connected).
  //
  // Memoised on two axes. Returning early when already authenticated makes it safe to call
  // from every tool handler; sharing one in-flight promise stops concurrent calls opening a
  // second socket.io connection during the handshake.
  const authenticateClient = async (): Promise<void> => {
    if (isAuthenticated) return;
    if (authInFlight) return authInFlight;

    authInFlight = (async () => {
      try {
        // Reuse a live socket. connect() unconditionally assigns a new one, so every retry
        // orphaned the previous socket — still holding listeners, still reconnecting.
        await client.ensureConnected();
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
        const credentialProblem = describeCredential();
        const detail = credentialProblem ? `${errorMessage}. ${credentialProblem}` : errorMessage;
        await server.sendLoggingMessage({
          level: 'error',
          data: `Failed to authenticate with Uptime Kuma: ${detail}`
        });
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to authenticate with Uptime Kuma: ${detail}`
        );
      }
    })();

    try {
      return await authInFlight;
    } finally {
      // Always clear the in-flight promise once it settles. Clearing only on failure meant
      // that after the first success it stayed set forever, so once a session could be
      // invalidated, authenticateClient() would return that stale resolved promise and skip
      // re-authenticating entirely.
      authInFlight = null;
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
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"'),
        // Issue #65: there was no way to list a group's members, so callers passing
        // `parentId` got the entire monitor list back, which reads as a broken filter.
        parentId: z.union([z.null(), z.coerce.number().int()]).optional().describe('Filter to the DIRECT children of this group monitor. Pass null for top-level monitors (those with no parent). Not recursive — use the group\'s own childrenIDs to walk deeper.'),
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
      await authenticateClient();

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
      await authenticateClient();

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
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        settings: SettingsSchema.describe('Current Uptime Kuma server settings')
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const response = await client.getSettings();

        if (!response.data) {
          throw new Error('No settings data returned');
        }

        // SettingsSchema declares a safe subset, but the text content below stringifies
        // whatever Uptime Kuma actually sent — which includes steamAPIKey. Redacting the
        // object covers both channels; redacting only structuredContent would not.
        const settings = wantsSecrets(includeSecrets) ? response.data : redactSecrets(response.data);

        return {
          content: [{ type: 'text', text: JSON.stringify(settings, null, 2) }],
          structuredContent: { settings },
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
      await authenticateClient();

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
      await authenticateClient();

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
      await authenticateClient();

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

  // Uptime Kuma's editMonitor handler reads these fields under camelCase names on the wire
  // (server/server.js: `bean.jsonPath = monitor.jsonPath`, `bean.pushToken = monitor.pushToken`,
  // …) while the database columns are snake_case (json_path, push_token). The snake_case
  // spellings are what the schema documentation, the database and issue #60 all use, so they
  // are the ones callers reach for first. Accept both and normalise onto the name Kuma reads,
  // rather than letting a reasonable guess silently do nothing.
  const MONITOR_FIELD_ALIASES: Record<string, string> = {
    json_path: 'jsonPath',
    json_path_operator: 'jsonPathOperator',
    expected_value: 'expectedValue',
    push_token: 'pushToken',
  };

  const normaliseMonitorAliases = (fields: Record<string, unknown>): Record<string, unknown> => {
    for (const [alias, canonical] of Object.entries(MONITOR_FIELD_ALIASES)) {
      if (!(alias in fields)) continue;
      if (canonical in fields && fields[canonical] !== fields[alias]) {
        throw new Error(
          `Conflicting values for ${canonical} (${JSON.stringify(fields[canonical])}) and its alias ${alias} (${JSON.stringify(fields[alias])}) — pass only '${canonical}'.`
        );
      }
      fields[canonical] = fields[alias];
      delete fields[alias];
    }
    return fields;
  };

  // Uptime Kuma generates push tokens in the browser (src/pages/EditMonitor.vue:
  // genSecret(pushTokenLength) with pushTokenLength = 32). Match its length and alphabet.
  const generatePushToken = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(32 * 2);
    let token = '';
    // Rejection sampling — modulo on a raw byte would bias the alphabet.
    const max = 256 - (256 % chars.length);
    for (let i = 0; token.length < 32 && i < bytes.length; i++) {
      if (bytes[i] < max) token += chars[bytes[i] % chars.length];
    }
    while (token.length < 32) token += chars[randomInt(0, chars.length)];
    return token;
  };

  // Uptime Kuma's own intent for an unset timeout is 0.8 x interval; only its unit handling is
  // wrong. Storing the value at creation means the buggy runtime fallback never runs.
  // push never polls and group has no request of its own, so both correctly keep 0.
  const defaultTimeoutForInterval = (type: string, interval?: number): number | undefined => {
    if (type === 'push' || type === 'group') return undefined;
    const seconds = Math.round((interval ?? 60) * 0.8 * 10) / 10;
    // Monitor.validate() rejects a ping timeout outside PING_GLOBAL_TIMEOUT_MIN/MAX (1..300).
    if (type === 'ping') return Math.min(Math.max(Math.round(seconds), 1), 300);
    return seconds;
  };

  server.registerTool(
    'createMonitor',
    {
      title: 'Create Monitor',
      description: 'Creates a new monitor in Uptime Kuma. Requires at minimum a name and type. Use listMonitorTypes to see supported types. For HTTP monitors include url; for TCP/port monitors include hostname and port; for json-query include url, jsonPath, jsonPathOperator and expectedValue. A push monitor is given a generated push token (Uptime Kuma only generates one in its own web UI) and the resulting ping URL is returned. timeout defaults to 0.8 x interval seconds for polled types.',
      inputSchema: {
        name: z.string().describe('Display name for the monitor'),
        type: z.string().describe('Monitor type (e.g. http, port, ping, dns, push, keyword). Use listMonitorTypes for all options.'),
        description: z.string().nullable().optional().describe('Free-text description shown on the monitor page'),
        active: z.boolean().optional().describe('Whether the monitor starts checking immediately (default: true). Pass false to create it paused.'),
        resendInterval: z.coerce.number().optional().describe('Resend notification every N checks while down (0 = disabled, the default)'),
        timeout: z.coerce.number().nullable().optional().describe('Request timeout in SECONDS. Omit for 0.8 x interval. Avoid 0: Uptime Kuma\'s runtime fallback for a stored 0 computes interval * 1000 * 0.8 and then multiplies by 1000 again, yielding a ~13 hour timeout, so the monitor can never report DOWN against a host that accepts the connection and never answers.'),
        jsonPath: z.string().optional().describe('JSONata expression for json-query monitors. Must resolve to a primitive.'),
        json_path: z.string().optional().describe('Alias for jsonPath (the database column name). Prefer jsonPath.'),
        jsonPathOperator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Comparison operator for json-query monitors. UP while value <operator> expectedValue.'),
        json_path_operator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Alias for jsonPathOperator. Prefer jsonPathOperator.'),
        expectedValue: z.coerce.string().optional().describe('Threshold the json-query result is compared against. Stored as a string.'),
        expected_value: z.coerce.string().optional().describe('Alias for expectedValue. Prefer expectedValue.'),
        pushToken: z.string().min(8).optional().describe('Push token for push monitors — the secret in the ping URL. Omit and one is generated and returned.'),
        push_token: z.string().min(8).optional().describe('Alias for pushToken (the database column name). Prefer pushToken.'),
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
        docker_container: z.string().optional().describe('Docker container name (required for docker type)'),
        docker_host: z.coerce.number().optional().describe('Docker host ID (required for docker type). Use listDockerHosts to find available IDs.'),
        dns_resolve_server: z.string().optional().describe('DNS server to use for resolution (required for dns type, default: 1.1.1.1)'),
        dns_resolve_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'CAA']).optional().describe('DNS record type to query (required for dns type, default: A)'),
      },
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
        pushToken: z.string().optional().describe('Push monitors only. The token, so the sender can be wired up without a second, wider read.'),
        pushURL: z.string().optional().describe('Push monitors only. The URL the sender should GET.'),
        timeout: z.number().optional().describe('The timeout in seconds actually stored, including the default applied when omitted.'),
      },
    },
    async (input) => {
      await authenticateClient();

      try {
        const defaults: Record<string, unknown> = {
          notificationIDList: {} as Record<string, boolean>,
          accepted_statuscodes: ['200-299'],
          conditions: [] as string[],
          retryInterval: 60,
        };
        if (input.type === 'dns') {
          defaults.dns_resolve_server = '1.1.1.1';
          defaults.dns_resolve_type = 'A';
        }

        const requested = normaliseMonitorAliases({ ...input } as Record<string, unknown>);

        // Issue #59: nothing to restore on a create, so the redaction marker must be refused
        // rather than persisted — writing "***" produces a credential that looks set and can
        // never work. Reached by copying a redacted monitor to make a similar one.
        const markers = rehydrateSecrets(requested, undefined).missing;
        if (markers.length > 0) {
          throw new Error(
            `"***" is the redaction marker, not a credential — pass the real value for ${markers.join(', ')}, or omit the field.`
          );
        }

        // A json-query monitor without a query is accepted by Uptime Kuma and then fails
        // every single check, which looks like a broken target rather than a broken config.
        if (requested.type === 'json-query') {
          const missing = ['jsonPath', 'jsonPathOperator', 'expectedValue'].filter(
            (f) => requested[f] === undefined || requested[f] === ''
          );
          if (missing.length > 0) {
            throw new Error(
              `A json-query monitor needs ${missing.join(', ')}. Without them Uptime Kuma creates the monitor and then fails every check.`
            );
          }
        }

        // Uptime Kuma generates push tokens in the browser only (src/pages/EditMonitor.vue,
        // genSecret(32)); the server has no such code path. Without this an API-created push
        // monitor has an empty push_token, no ping URL, and can never report — while looking
        // identical to one that is merely awaiting its first beat.
        let generatedPushToken = false;
        if (requested.type === 'push' && !requested.pushToken) {
          requested.pushToken = generatePushToken();
          generatedPushToken = true;
        }

        // Never leave timeout at 0 — see the schema description for why that is a ~13 hour
        // timeout rather than a default.
        if (requested.timeout === undefined || requested.timeout === null) {
          const fallback = defaultTimeoutForInterval(
            requested.type as string,
            requested.interval as number | undefined
          );
          if (fallback !== undefined) requested.timeout = fallback;
          else delete requested.timeout;
        }

        const monitorData = {
          ...defaults,
          ...requested,
        };
        const response = await client.createMonitor(monitorData as Record<string, unknown>);

        const structuredContent: Record<string, unknown> = {
          ok: response.ok,
          monitorID: response.monitorID,
          msg: response.msg,
        };
        if (requested.timeout !== undefined) structuredContent.timeout = Number(requested.timeout);

        let text = response.msg || `Monitor created with ID ${response.monitorID}`;
        if (requested.type === 'push' && requested.pushToken) {
          const base = config.url.replace(/\/+$/, '');
          structuredContent.pushToken = requested.pushToken;
          structuredContent.pushURL = `${base}/api/push/${requested.pushToken}?status=up&msg=OK&ping=`;
          text += `\n\nPush monitor ${response.monitorID}: point the sender at (GET, not POST)\n  ${structuredContent.pushURL}\nThis URL contains a secret — treat it as a credential.${generatedPushToken ? ' The token was generated because Uptime Kuma only ever generates one in its own web UI.' : ''}`;
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
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
        // `parent` was declared on createMonitor but not here, so an existing monitor could
        // never be moved into or out of a group (issue #63). The merge below then folded the
        // old value back in and Uptime Kuma replied "Saved." — a no-op reported as success.
        parent: z.coerce.number().int().nullable().optional().describe('Parent group monitor ID — re-parents this monitor into that group. Pass null to move it to the top level.'),
        parentID: z.coerce.number().int().nullable().optional().describe('Alias for parent. Prefer parent.'),
        parent_id: z.coerce.number().int().nullable().optional().describe('Alias for parent. Prefer parent.'),
        description: z.string().nullable().optional().describe('Free-text description shown on the monitor page'),
        resendInterval: z.coerce.number().optional().describe('Resend notification every N checks while down (0 = disabled)'),
        timeout: z.coerce.number().nullable().optional().describe('Request timeout in SECONDS. Avoid 0 — Uptime Kuma\'s runtime fallback for a stored 0 yields a ~13 hour timeout, so the monitor can never report DOWN against a black-holed endpoint.'),
        jsonPath: z.string().optional().describe('JSONata expression for json-query monitors. Must resolve to a primitive.'),
        json_path: z.string().optional().describe('Alias for jsonPath (the database column name). Prefer jsonPath.'),
        jsonPathOperator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Comparison operator for json-query monitors.'),
        json_path_operator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Alias for jsonPathOperator. Prefer jsonPathOperator.'),
        expectedValue: z.coerce.string().optional().describe('Threshold the json-query result is compared against, stored as a string.'),
        expected_value: z.coerce.string().optional().describe('Alias for expectedValue. Prefer expectedValue.'),
        pushToken: z.string().min(8).optional().describe('Push token — the secret in the ping URL. Changing it invalidates the existing URL and any sender still using it stops beating.'),
        push_token: z.string().min(8).optional().describe('Alias for pushToken (the database column name). Prefer pushToken.'),
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
        docker_container: z.string().optional().describe('Docker container name (required for docker type)'),
        docker_host: z.coerce.number().optional().describe('Docker host ID (required for docker type). Use listDockerHosts to find available IDs.'),
        dns_resolve_server: z.string().optional().describe('DNS server to use for resolution (for dns type)'),
        dns_resolve_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'CAA']).optional().describe('DNS record type to query (for dns type)'),
      },
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorID, ...rest }) => {
      await authenticateClient();

      try {
        const existing = client.getMonitor(monitorID, true);
        if (!existing) {
          throw new Error(`Monitor ${monitorID} not found`);
        }
        // Strip undefined values so existing config is preserved for omitted fields
        const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        // Fold `parentID` / `parent_id` onto the single field Uptime Kuma's editMonitor
        // handler reads (`bean.parent = monitor.parent`), along with the snake_case
        // type-specific aliases, so a reasonable guess at a name cannot become a silent no-op.
        for (const alias of ['parentID', 'parent_id']) {
          if (alias in defined) {
            if ('parent' in defined && defined.parent !== defined[alias]) {
              throw new Error(`Conflicting values for parent (${defined.parent}) and ${alias} (${defined[alias]}) — pass only 'parent'.`);
            }
            defined.parent = defined[alias];
            delete defined[alias];
          }
        }
        normaliseMonitorAliases(defined);

        // Issue #59: a caller that read this monitor back holds "***" where a credential
        // was, and the natural edit-one-field-and-write-it-back loop would then persist
        // the marker. Restore the stored value instead. Runs AFTER alias normalisation so
        // `push_token: "***"` is matched against the stored `pushToken`.
        //
        // `existing` is the unredacted cache row: redaction lives at the tool output
        // boundary only, precisely so this comparison still has a real value to find.
        const { preserved, missing } = rehydrateSecrets(defined, existing as unknown as Record<string, unknown>);
        if (missing.length > 0) {
          throw new Error(
            `Cannot write the redaction marker "***" to ${missing.join(', ')} — the monitor has no stored value ` +
            'to restore, so this would create a credential that looks set and cannot work. ' +
            'Pass the real value, or omit the field to leave it unchanged.'
          );
        }

        const merged = { ...existing, ...defined, id: monitorID };
        // Ensure retryInterval is valid — Kuma rejects values < 1 on edit even if
        // it stored 0 during creation (pre-existing monitors or older defaults)
        if (!merged.retryInterval || (merged as any).retryInterval < 1) {
          (merged as any).retryInterval = (merged as any).interval || 60;
        }
        const response = await client.updateMonitor(merged as unknown as Record<string, unknown>);
        let text = response.msg || `Monitor ${monitorID} updated successfully`;
        if (preserved.length > 0) {
          text += `\n\nKept the existing value for ${preserved.join(', ')} — "***" was sent, which is the redaction marker, not a credential.`;
        }
        return {
          content: [{ type: 'text', text }],
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
      await authenticateClient();

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
      description: 'Returns all configured notification channels (Slack, ntfy, Discord, email, webhooks, etc.). To attach a channel to a monitor you only need its id — the credentials in `config` are withheld by default and the names of the withheld fields are listed in `redactedConfigKeys`.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        notifications: z.array(NotificationSchema).describe('Array of notification channel configurations. By default `config` is reduced to its non-secret fields and `redactedConfigKeys` names what was withheld.'),
        count: z.number(),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const raw = client.getNotificationList();
        // getNotificationList() returns references into notificationListCache, so this
        // must not mutate — redactNotifications builds new objects.
        const notifications = wantsSecrets(includeSecrets)
          ? raw
          : redactNotifications(raw as unknown as Record<string, unknown>[]);
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
      await authenticateClient();

      try {
        const notification = { name, type, isDefault, applyExisting, ...config };

        // Issue #59: as with createMonitor, there is no stored value to restore on a create,
        // so the redaction marker is refused rather than saved as the credential. This is the
        // path you hit cloning an existing channel from a redacted listNotifications.
        const markers = rehydrateSecrets(notification as Record<string, unknown>, undefined).missing;
        if (markers.length > 0) {
          throw new Error(
            `"***" is the redaction marker, not a credential — pass the real value for ${markers.join(', ')}. ` +
            'To copy an existing channel, read it with listNotifications { includeSecrets: true }.'
          );
        }

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
      await authenticateClient();

      try {
        const notification: Record<string, unknown> = { ...config };
        if (name !== undefined) notification['name'] = name;
        if (type !== undefined) notification['type'] = type;
        if (isDefault !== undefined) notification['isDefault'] = isDefault;
        if (applyExisting !== undefined) notification['applyExisting'] = applyExisting;

        // Issue #59, and the sharper edge of it. Uptime Kuma's addNotification REPLACES the
        // row rather than merging, so the read-edit-write loop writes back whatever the
        // caller was shown — and after redaction that is `smtpPassword: "***"`. Renaming a
        // channel would otherwise destroy the credential that makes it work.
        const stored = client
          .getNotificationList()
          .find((n) => (n as Record<string, unknown>)['id'] === notificationID) as
          | Record<string, unknown>
          | undefined;
        let storedConfig: Record<string, unknown> | undefined;
        const rawStored = stored?.['config'];
        if (typeof rawStored === 'string') {
          try {
            const parsed: unknown = JSON.parse(rawStored);
            if (parsed && typeof parsed === 'object') storedConfig = parsed as Record<string, unknown>;
          } catch {
            storedConfig = undefined;
          }
        } else if (rawStored && typeof rawStored === 'object') {
          storedConfig = rawStored as Record<string, unknown>;
        }

        const { preserved, missing } = rehydrateSecrets(notification, storedConfig);
        if (missing.length > 0) {
          throw new Error(
            `Cannot write the redaction marker "***" to ${missing.join(', ')} — notification ${notificationID} has ` +
            'no stored value to restore. Pass the real value, or call listNotifications with includeSecrets ' +
            'to read the current one.'
          );
        }

        const response = await client.addNotification(notification, notificationID);
        let text = response.msg || `Notification ${notificationID} updated`;
        if (preserved.length > 0) {
          text += `\n\nKept the existing value for ${preserved.join(', ')} — "***" was sent, which is the redaction marker, not a credential.`;
        }
        return {
          content: [{ type: 'text', text }],
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
      await authenticateClient();

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

  // ─── Docker host tools ───────────────────────────────────────────────────

  server.registerTool(
    'listDockerHosts',
    {
      title: 'List Docker Hosts',
      description: 'Returns all docker daemon connections configured in Uptime Kuma. These are referenced by docker container monitors via docker_host.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        dockerHosts: z.array(DockerHostSchema).describe('Array of docker host configurations. Any credentials embedded in a dockerDaemon URL read "***" unless includeSecrets is set.'),
        count: z.number(),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const raw = client.getDockerHostList();
        // A TCP dockerDaemon can be http://user:pass@host:2375 — the field name gives no
        // hint of that, so the URL scrub in redactSecrets is what catches it.
        const dockerHosts = wantsSecrets(includeSecrets) ? raw : raw.map((h) => redactSecrets(h));
        return {
          content: [{ type: 'text', text: JSON.stringify(dockerHosts, null, 2) }],
          structuredContent: { dockerHosts, count: dockerHosts.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list docker hosts: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addDockerHost',
    {
      title: 'Add Docker Host',
      description: 'Creates a new docker daemon connection. For a unix socket use dockerType="socket" and dockerDaemon="/var/run/docker.sock". For a TCP proxy (e.g. tecnativa/docker-socket-proxy) use dockerType="tcp" and dockerDaemon="http://host:2375". Consider calling testDockerHost first to verify reachability.',
      inputSchema: {
        name: z.string().describe('Human-readable name for this docker host'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z.string().describe('Unix socket path (e.g. /var/run/docker.sock) when dockerType=socket, or TCP URL (e.g. http://docker-proxy:2375) when dockerType=tcp'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        const response = await client.addDockerHost({ name, dockerType, dockerDaemon });
        return {
          content: [{ type: 'text', text: response.msg || `Docker host created with ID ${response.id}` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateDockerHost',
    {
      title: 'Update Docker Host',
      description: 'Updates an existing docker daemon connection. Use listDockerHosts to find the docker host ID. Only the fields you pass are changed — the others are preserved.',
      inputSchema: {
        dockerHostID: z.coerce.number().int().nonnegative().describe('The ID of the docker host to update'),
        name: z.string().optional().describe('New human-readable name'),
        dockerType: z.enum(['socket', 'tcp']).optional().describe('New connection type'),
        dockerDaemon: z.string().optional().describe('New socket path or TCP URL'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ dockerHostID, name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        // Merge new values onto the current record so callers can omit unchanged fields.
        // Uptime Kuma's addDockerHost handler overwrites every column it receives, so we
        // need to send the full set to avoid clobbering existing values with undefined.
        const existing = client.getDockerHostList().find(h => h.id === dockerHostID);
        if (!existing) {
          throw new Error(`Docker host ${dockerHostID} not found — call listDockerHosts to see available IDs`);
        }

        const merged: Record<string, unknown> = {
          name: name ?? existing.name,
          dockerType: dockerType ?? existing.dockerType,
          dockerDaemon: dockerDaemon ?? existing.dockerDaemon,
        };

        // Issue #59: listDockerHosts scrubs inline URL credentials to "***:***@host", and a
        // dockerDaemon TCP URL is written back here wholesale. The read-edit-write loop an agent
        // performs would otherwise persist those markers over the real credentials. Restore them
        // from the stored URL. The marker sits inside the URL userinfo, not as a bare "***", so
        // rehydrateSecrets cannot catch it — rehydrateUrlCredentials is its URL-shaped counterpart.
        // Only reached when the caller passed dockerDaemon; omitting it already keeps the stored URL.
        let preservedCreds = false;
        if (dockerDaemon !== undefined) {
          const restored = rehydrateUrlCredentials(dockerDaemon, existing.dockerDaemon);
          if (restored.missing) {
            throw new Error(
              'Cannot write the redaction marker "***" into dockerDaemon — the docker host has no ' +
              'stored credential to restore, so this would save an endpoint that looks authenticated ' +
              'and cannot connect. Pass the real URL, or call listDockerHosts with includeSecrets to ' +
              'read the current one.'
            );
          }
          merged.dockerDaemon = restored.value;
          preservedCreds = restored.preserved;
        }

        const response = await client.addDockerHost(merged, dockerHostID);
        let text = response.msg || `Docker host ${dockerHostID} updated`;
        if (preservedCreds) {
          text += '\n\nKept the existing credentials embedded in dockerDaemon — "***" was sent, ' +
            'which is the redaction marker, not a credential.';
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteDockerHost',
    {
      title: 'Delete Docker Host',
      description: 'Permanently deletes a docker daemon connection. Any monitors referencing it will have their docker_host cleared by Uptime Kuma (the monitors themselves are not deleted).',
      inputSchema: {
        dockerHostID: z.coerce.number().int().nonnegative().describe('The ID of the docker host to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ dockerHostID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteDockerHost(dockerHostID);
        return {
          content: [{ type: 'text', text: response.msg || `Docker host ${dockerHostID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'testDockerHost',
    {
      title: 'Test Docker Host',
      description: 'Tests connectivity to a docker daemon without persisting it. On success the message includes the number of containers. Use this before addDockerHost to avoid saving a broken configuration.',
      inputSchema: {
        name: z.string().describe('Display name (used only in the test request)'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z.string().describe('Unix socket path or TCP URL to probe'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        const response = await client.testDockerHost({ name, dockerType, dockerDaemon });
        return {
          content: [{ type: 'text', text: response.msg || (response.ok ? 'Docker host reachable' : 'Docker host unreachable') }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to test docker host: ${errorMessage}`);
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
      await authenticateClient();

      try {
        const tags = await client.getTagList();
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
      await authenticateClient();

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
      await authenticateClient();

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
      await authenticateClient();

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
        description: z.string().default('').describe('Description or reason for the maintenance'),
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
      await authenticateClient();

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
      await authenticateClient();

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
      await authenticateClient();

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
      await authenticateClient();

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
      await authenticateClient();

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
      await authenticateClient();

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
