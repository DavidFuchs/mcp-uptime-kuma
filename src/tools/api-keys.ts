import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { requiredId } from './schema.js';
import { APIKeySchema } from '../types/index.js';

/**
 * An expiry as the web UI's date picker sends it, "YYYY-MM-DD HH:mm:ss" in the server's local
 * time. A date alone means the end of that day; minutes alone get :00 seconds.
 */
export function normalizeExpiry(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) throw new Error(`expires must be "YYYY-MM-DD" or "YYYY-MM-DD HH:mm", not "${value}"`);
  const [, date, hh, mm, ss] = m;
  return hh === undefined ? `${date} 23:59:59` : `${date} ${hh}:${mm}:${ss ?? '00'}`;
}

/** The API key tools: keys for Uptime Kuma's API, such as its Prometheus /metrics endpoint. */
export function registerAPIKeyTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  // enableAPIKey, disableAPIKey and deleteAPIKey answer ok for an ID that does not exist.
  const requireKey = (keyID: number) => {
    if (!client.getAPIKeyList().some((k) => k.id === keyID)) {
      throw new Error(`API key ${keyID} not found — call listAPIKeys to see available IDs`);
    }
  };

  server.registerTool(
    'listAPIKeys',
    {
      title: 'List API Keys',
      description:
        "Returns the API keys for Uptime Kuma's API (such as its Prometheus /metrics endpoint) with name, status (active, inactive or expired) and expiry. The keys themselves cannot be read back: they are shown once, by createAPIKey.",
      inputSchema: {},
      outputSchema: { apiKeys: z.array(APIKeySchema), count: z.number() },
    },
    async () => {
      await authenticateClient();
      const apiKeys = client.getAPIKeyList();
      return {
        content: [{ type: 'text', text: JSON.stringify(apiKeys) }],
        structuredContent: { apiKeys, count: apiKeys.length },
      };
    }
  );

  server.registerTool(
    'createAPIKey',
    {
      title: 'Create API Key',
      description:
        "Creates an API key and returns it. It is sent as the password of HTTP basic auth, with any username. This is the only time the key can be read, and it stays in this conversation's transcript, so give it to the user to store and do not repeat it. Note: once any key exists, Uptime Kuma's /metrics endpoint takes API keys instead of the admin username and password, so a Prometheus scraper still using those must switch.",
      inputSchema: {
        name: z.string().trim().min(1).describe('What the key is for, e.g. "prometheus"'),
        expires: z
          .string()
          .optional()
          .describe(
            'When it stops working, in the server\'s local time: "YYYY-MM-DD" (end of that day) or "YYYY-MM-DD HH:mm". Omit for never.'
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        keyID: z.number().optional(),
        key: z.string().optional().describe('The key itself, e.g. "uk1_…". Shown only now.'),
        expires: z.string().nullable(),
      },
    },
    async ({ name, expires }) => {
      await authenticateClient();

      try {
        const normalized = expires === undefined ? null : normalizeExpiry(expires);
        const response = await client.addAPIKey({ name, active: true, expires: normalized });
        return {
          content: [
            {
              type: 'text',
              text:
                `API key ${response.keyID} "${name}" created${normalized ? `, expiring ${normalized}` : ''}. ` +
                `Key (shown only now): ${response.key}`,
            },
          ],
          structuredContent: { ok: response.ok, keyID: response.keyID, key: response.key, expires: normalized },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create API key: ${message}`);
      }
    }
  );

  server.registerTool(
    'setAPIKeyActive',
    {
      title: 'Set API Key Active',
      description:
        'Switches an API key off (active: false), so requests using it are refused, or back on (active: true). An expired key stays expired. To remove it for good use deleteAPIKey. Find the ID with listAPIKeys.',
      inputSchema: {
        keyID: requiredId('The ID of the API key'),
        active: z.boolean().describe('false switches the key off, true back on'),
      },
      outputSchema: { ok: z.boolean(), keyID: z.number(), active: z.boolean() },
    },
    async ({ keyID, active }) => {
      await authenticateClient();

      try {
        requireKey(keyID);
        const response = await client.setAPIKeyActive(keyID, active);
        return {
          content: [{ type: 'text', text: `API key ${keyID} ${active ? 'enabled' : 'disabled'}.` }],
          structuredContent: { ok: response.ok, keyID, active },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to ${active ? 'enable' : 'disable'} API key: ${message}`);
      }
    }
  );

  server.registerTool(
    'deleteAPIKey',
    {
      title: 'Delete API Key',
      description:
        'Permanently deletes an API key: anything still using it is refused from then on. To switch it off but keep it, use setAPIKeyActive. Find the ID with listAPIKeys.',
      inputSchema: { keyID: requiredId('The ID of the API key to delete') },
      outputSchema: { ok: z.boolean(), msg: z.string().optional() },
    },
    async ({ keyID }) => {
      await authenticateClient();

      try {
        requireKey(keyID);
        const response = await client.deleteAPIKey(keyID);
        return {
          content: [{ type: 'text', text: `API key ${keyID} deleted.` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete API key: ${message}`);
      }
    }
  );
}
