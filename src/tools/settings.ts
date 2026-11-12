import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { ToolContext } from './context.js';
import { SettingsSchema } from '../types/index.js';
import { redactSecrets } from '../redact.js';

/** The tool that reports Uptime Kuma's settings. */
export function registerSettingsTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  // Register getSettings tool
  server.registerTool(
    'getSettings',
    {
      title: 'Get Settings',
      description: 'Retrieves the current Uptime Kuma server settings, such as timezone, primary base URL and data retention. Uptime Kuma only returns settings that have been saved, so a setting missing from the result (for example primaryBaseURL) has never been set.',
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
          content: [{ type: 'text', text: JSON.stringify(settings) }],
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
}
