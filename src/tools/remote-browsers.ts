import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { requiredId } from './schema.js';
import { RemoteBrowserSchema, type RemoteBrowser } from '../types/index.js';
import { isSecretKey, redactUrlCredentials, SECRET_MARKER } from '../redact.js';

/**
 * A remote browser URL with its credentials masked: a `user:pass@` login, and query parameters
 * with secret names, such as browserless's `?token=`.
 */
export function redactRemoteBrowserUrl(url: string): string {
  const scrubbed = redactUrlCredentials(url);
  const q = scrubbed.indexOf('?');
  if (q === -1) return scrubbed;
  const [query, hash = ''] = scrubbed.slice(q + 1).split(/(?=#)/);
  const params = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // A malformed escape: judge the name as written.
      }
      return eq !== -1 && isSecretKey(decoded) ? `${name}=${SECRET_MARKER}` : pair;
    })
    .join('&');
  return `${scrubbed.slice(0, q)}?${params}${hash}`;
}

const wsUrl = z
  .string()
  .trim()
  .regex(/^wss?:\/\/\S+$/i, 'must be a ws:// or wss:// URL, e.g. ws://browserless:3000?token=…');

/** The remote browser tools: a remote Chrome that real-browser monitors can run in. */
export function registerRemoteBrowserTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  const show = (rb: RemoteBrowser, includeSecrets?: boolean): RemoteBrowser =>
    wantsSecrets(includeSecrets) ? rb : { ...rb, url: redactRemoteBrowserUrl(rb.url) };
  const find = (id: number) => client.getRemoteBrowserList().find((rb) => rb.id === id);
  const notFound = (id: number) =>
    new Error(`Remote browser ${id} not found — call listRemoteBrowsers to see available IDs`);

  server.registerTool(
    'listRemoteBrowsers',
    {
      title: 'List Remote Browsers',
      description:
        'Returns the remote browsers (a Chrome reachable over WebSocket, e.g. browserless) that real-browser monitors can run in instead of the built-in Chromium. A monitor uses one by ID in its remote_browser field. Tokens and logins in a URL read "***" unless includeSecrets is set.',
      inputSchema: { includeSecrets: includeSecretsParam },
      outputSchema: { remoteBrowsers: z.array(RemoteBrowserSchema), count: z.number() },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();
      const remoteBrowsers = client.getRemoteBrowserList().map((rb) => show(rb, includeSecrets));
      return {
        content: [{ type: 'text', text: JSON.stringify(remoteBrowsers) }],
        structuredContent: { remoteBrowsers, count: remoteBrowsers.length },
      };
    }
  );

  server.registerTool(
    'testRemoteBrowser',
    {
      title: 'Test Remote Browser',
      description:
        'Checks that Uptime Kuma can drive a browser at a WebSocket URL, without saving anything: pass url to try one before createRemoteBrowser, or remoteBrowserID to check a saved one.',
      inputSchema: {
        url: wsUrl.optional().describe('A ws:// or wss:// endpoint to try'),
        remoteBrowserID: requiredId('A saved remote browser to check').optional(),
      },
      outputSchema: { ok: z.boolean(), msg: z.string().optional() },
    },
    async ({ url, remoteBrowserID }) => {
      await authenticateClient();

      try {
        if ((url === undefined) === (remoteBrowserID === undefined)) {
          throw new Error('pass either url or remoteBrowserID');
        }
        let target = url;
        if (remoteBrowserID !== undefined) {
          const stored = find(remoteBrowserID);
          if (!stored) throw notFound(remoteBrowserID);
          target = stored.url;
        }
        const response = await client.testRemoteBrowser(target!);
        return {
          content: [{ type: 'text', text: response.msg ?? 'Connected.' }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Remote browser test failed: ${message}`);
      }
    }
  );

  server.registerTool(
    'createRemoteBrowser',
    {
      title: 'Create Remote Browser',
      description:
        'Adds a remote browser. Real-browser monitors use it once their remote_browser field is set to its ID. Check the URL first with testRemoteBrowser.',
      inputSchema: {
        name: z.string().trim().min(1).describe('A name to tell it apart'),
        url: wsUrl.describe('WebSocket endpoint, e.g. ws://browserless:3000?token=…'),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        ok: z.boolean(),
        remoteBrowserID: z.number().optional(),
        remoteBrowser: RemoteBrowserSchema.optional(),
      },
    },
    async ({ name, url, includeSecrets }) => {
      await authenticateClient();

      try {
        const response = await client.saveRemoteBrowser({ name, url }, null);
        const saved = response.id === undefined ? undefined : find(response.id);
        return {
          content: [{ type: 'text', text: `Remote browser ${response.id} created: ${name}` }],
          structuredContent: {
            ok: response.ok,
            remoteBrowserID: response.id,
            remoteBrowser: saved && show(saved, includeSecrets),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create remote browser: ${message}`);
      }
    }
  );

  server.registerTool(
    'updateRemoteBrowser',
    {
      title: 'Update Remote Browser',
      description:
        'Changes a remote browser\'s name or URL; what you leave out keeps its stored value. To change the URL pass it in full: a URL with "***" in it is refused, since it would overwrite the stored token. Find the ID with listRemoteBrowsers.',
      inputSchema: {
        remoteBrowserID: requiredId('The ID of the remote browser to change'),
        name: z.string().trim().min(1).optional().describe('New name'),
        url: wsUrl.optional().describe('New ws:// or wss:// endpoint, in full'),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: { ok: z.boolean(), remoteBrowserID: z.number(), remoteBrowser: RemoteBrowserSchema.optional() },
    },
    async ({ remoteBrowserID, name, url, includeSecrets }) => {
      await authenticateClient();

      try {
        if (name === undefined && url === undefined) throw new Error('nothing to change — pass name or url');
        if (url?.includes(SECRET_MARKER)) {
          throw new Error(
            'the url contains "***", the redaction marker: pass the full URL, or leave url out to keep the stored one'
          );
        }
        const stored = find(remoteBrowserID);
        if (!stored) throw notFound(remoteBrowserID);
        // addRemoteBrowser writes both columns from what it is sent.
        const response = await client.saveRemoteBrowser(
          { name: name ?? stored.name, url: url ?? stored.url },
          remoteBrowserID
        );
        const saved = find(remoteBrowserID);
        return {
          content: [{ type: 'text', text: `Remote browser ${remoteBrowserID} updated.` }],
          structuredContent: { ok: response.ok, remoteBrowserID, remoteBrowser: saved && show(saved, includeSecrets) },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update remote browser: ${message}`);
      }
    }
  );

  server.registerTool(
    'deleteRemoteBrowser',
    {
      title: 'Delete Remote Browser',
      description:
        'Permanently deletes a remote browser. Real-browser monitors that used it are kept and fall back to the built-in Chromium. Find the ID with listRemoteBrowsers.',
      inputSchema: { remoteBrowserID: requiredId('The ID of the remote browser to delete') },
      outputSchema: { ok: z.boolean(), msg: z.string().optional() },
    },
    async ({ remoteBrowserID }) => {
      await authenticateClient();

      try {
        if (!find(remoteBrowserID)) throw notFound(remoteBrowserID);
        const response = await client.deleteRemoteBrowser(remoteBrowserID);
        return {
          content: [{ type: 'text', text: `Remote browser ${remoteBrowserID} deleted.` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete remote browser: ${message}`);
      }
    }
  );
}
