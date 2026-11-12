import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { UptimeKumaClient } from '../uptime-kuma-client.js';

/** What every group of tools is registered with. */
export interface ToolContext {
  server: McpServer;
  client: UptimeKumaClient;
  /** Logs in to Uptime Kuma if not already logged in. Called first by every tool that needs it. */
  authenticateClient: () => Promise<void>;
  /** Whether a read should return credentials: the per-call argument, else the server's default. */
  wantsSecrets: (perCall?: boolean) => boolean;
  /** The `includeSecrets` argument, declared the same way on every tool that takes it. */
  includeSecretsParam: z.ZodOptional<z.ZodBoolean>;
  /** The address this server connects to Uptime Kuma with. */
  kumaUrl: string;
}
