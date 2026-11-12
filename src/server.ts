import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode, SetLevelRequestSchema, LoggingLevelSchema, type LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { UptimeKumaClient } from './uptime-kuma-client.js';
import type { UptimeKumaConfig } from './types/index.js';
import { INCLUDE_SECRETS_DESCRIPTION } from './redact.js';
import { VERSION } from './version.js';
import { createKumaSession, type KumaSession } from './kuma-session.js';
import { installToolRegistration } from './tools/registration.js';
import type { ToolContext } from './tools/context.js';
import { registerMonitorReadTools } from './tools/monitors-read.js';
import { registerMonitorWriteTools } from './tools/monitors-write.js';
import { registerHeartbeatTools } from './tools/heartbeats.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerDockerHostTools } from './tools/docker-hosts.js';
import { registerTagTools } from './tools/tags.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerStatusPageTools } from './tools/status-pages.js';

// The parts of this module that moved out, still importable from here.
export { createKumaSession, type KumaSession, type KumaLogSink } from './kuma-session.js';
export { READ_ONLY_TOOLS, WRITE_TOOLS, CHANGE_NOTHING_TOOLS, toolAnnotations, normalizeAdvertisedSchema } from './tools/registration.js';
export { MONITOR_TYPE_FIELD_NAMES } from './monitors/fields.js';
export { mergeStatusPageConfig } from './tools/status-pages.js';

/**
 * Creates and configures the MCP server with tools, resources, and prompts
 * Note: Authentication must be done separately after connecting the transport
 */
export async function createServer(config: UptimeKumaConfig, session?: KumaSession): Promise<{ server: McpServer; client: UptimeKumaClient; authenticateClient: () => Promise<void> }> {
  // Track current logging level (default: info)
  let currentLogLevel: LoggingLevel = 'info';

  // UPTIME_KUMA_READ_ONLY: the write tools are not registered (see
  // installToolRegistration), so the instructions must not send a model looking for them.
  const readOnlyMode = config.readOnly === true;
  const writeInstructions = readOnlyMode
    ? `        This server is running READ-ONLY (UPTIME_KUMA_READ_ONLY): it has no tools that create,
        change, pause or delete anything. Say so if asked to make a change.
`
    : `        WRITE operations:
        - Use 'createMonitor' / 'updateMonitor' / 'deleteMonitor' to manage monitors.
        - Call 'getMonitorTypeFields' before creating or reconfiguring a monitor: it names the fields a type needs. Type-specific fields go in the typeFields argument.
        - Use 'addNotification' / 'updateNotification' / 'deleteNotification' to manage notification channels.
        - Use 'addTag' / 'deleteTag' to manage tags.
        - Use 'createMaintenance' / 'updateMaintenance' / 'deleteMaintenance' to manage maintenance windows. Pass monitorIDs — a window with no monitors suppresses nothing.
        - Use 'pauseMaintenance' / 'resumeMaintenance' to switch a maintenance window off and on.
        - Use 'addDockerHost' / 'updateDockerHost' / 'deleteDockerHost' to manage docker daemon connections.
        - Use 'testDockerHost' to verify a docker daemon is reachable before saving.
        - Use 'createStatusPage' / 'updateStatusPage' / 'deleteStatusPage' to manage status pages. Creating returns an empty page — follow up with updateStatusPage to set groups and monitors.
        - Use 'pauseMonitor' / 'resumeMonitor' to temporarily stop/start checks.
`;

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
        - Use 'getHeartbeats' or 'listHeartbeats' for historical data (set maxHeartbeats to 5-10 unless the user asks for more).
        - Use 'listMonitors' when you need configuration details (URLs, intervals, notification settings).
        - Use 'listNotifications' to see notification channels.
        - Use 'listTags' to see available tags.
        - Use 'getMaintenanceWindows' to see maintenance windows and the monitors each one covers.
        - Use 'listStatusPages' to see status page configurations, or 'getStatusPage' for one page's full details (groups + monitors).
        - Use 'listDockerHosts' to see configured docker daemons (used by docker container monitors).

${writeInstructions}
        CREDENTIALS:
        - Read tools return "***" in place of passwords, tokens, API keys and HTTP headers.
          To attach a notification channel to a monitor you only need its id, so the common
          workflows never need the real values.
        - Pass includeSecrets: true (or set UPTIME_KUMA_INCLUDE_SECRETS=true) only when the
          value itself is needed. It will be written to this conversation's transcript.
${readOnlyMode ? '' : `        - "***" sent back to updateMonitor / updateNotification restores the stored value
          rather than overwriting it, so a read-edit-write round trip is safe.`}
      `,
      capabilities: {
        logging: {}
      }
    }
  );

  // Must come before the first registerTool: it changes what registering a tool does.
  installToolRegistration(server, readOnlyMode);

  // Handle logging level changes via the underlying server
  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const level = request.params?.level as LoggingLevel | undefined;
    if (level && LoggingLevelSchema.safeParse(level).success) {
      currentLogLevel = level;
      return {};
    }
    throw new McpError(ErrorCode.InvalidParams, `Invalid log level: ${level}`);
  });

  // LoggingLevelSchema enum values are already in order: debug < info < notice < ... < emergency
  const logLevels = LoggingLevelSchema.options;
  const shouldLog = (level: LoggingLevel): boolean => {
    return logLevels.indexOf(level) >= logLevels.indexOf(currentLogLevel);
  };

  // The connection to Uptime Kuma. Handed in when several servers share one (the HTTP
  // transport builds a server per request); otherwise this server gets its own.
  const kuma = session ?? createKumaSession(config);
  const { client, authenticateClient } = kuma;

  // Log through this server for as long as it is connected, at the level its client asked for.
  const detachLogSink = kuma.attachLogSink({
    shouldLog,
    send: (params) => server.sendLoggingMessage(params),
  });
  server.server.onclose = () => detachLogSink();

  // Issue #59: read tools withhold credentials by default.
  //
  // The env var is the global switch and the per-call `includeSecrets` parameter is the
  // narrow one; the parameter wins where both are present, in either direction, so a
  // globally-permissive deployment can still ask a single call to redact.
  const includeSecretsByDefault = config.includeSecrets === true;
  const wantsSecrets = (perCall?: boolean): boolean =>
    perCall === undefined ? includeSecretsByDefault : perCall;
  const includeSecretsParam = z.boolean().optional().describe(INCLUDE_SECRETS_DESCRIPTION);

  // Registered in the order tools/list advertises them.
  const ctx: ToolContext = { server, client, authenticateClient, wantsSecrets, includeSecretsParam, kumaUrl: config.url };
  registerMonitorReadTools(ctx);
  registerHeartbeatTools(ctx);
  registerSettingsTools(ctx);
  registerMonitorWriteTools(ctx);
  registerNotificationTools(ctx);
  registerDockerHostTools(ctx);
  registerTagTools(ctx);
  registerMaintenanceTools(ctx);
  registerStatusPageTools(ctx);

  return { server, client, authenticateClient };
}
