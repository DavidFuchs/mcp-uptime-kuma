import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { numeric, requiredId } from './schema.js';
import { ProxySchema, PROXY_PROTOCOLS, type KumaProxy } from '../types/index.js';
import { redactSecrets, SECRET_MARKER } from '../redact.js';

/** The proxy tools: the HTTP and SOCKS proxies monitors can send their requests through. */
export function registerProxyTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  const show = (proxy: KumaProxy | undefined, includeSecrets?: boolean) =>
    proxy && (wantsSecrets(includeSecrets) ? proxy : redactSecrets(proxy));

  const port = numeric(z.number().int().min(1).max(65535));
  const protocol = z.enum(PROXY_PROTOCOLS);
  const applyExisting = z
    .boolean()
    .optional()
    .describe('Also route every existing monitor through this proxy now. One-off: it is not stored.');
  const isDefault = z
    .boolean()
    .optional()
    .describe('Make it the proxy the web UI preselects for new monitors; the previous default stops being one');

  server.registerTool(
    'listProxies',
    {
      title: 'List Proxies',
      description:
        'Returns the proxies monitors can send their requests through, with protocol, host, port and username. An HTTP-type monitor uses one by ID in its proxyId field. Passwords read "***" unless includeSecrets is set.',
      inputSchema: { includeSecrets: includeSecretsParam },
      outputSchema: { proxies: z.array(ProxySchema), count: z.number() },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();
      const proxies = client.getProxyList().map((p) => show(p, includeSecrets)!);
      return {
        content: [{ type: 'text', text: JSON.stringify(proxies) }],
        structuredContent: { proxies, count: proxies.length },
      };
    }
  );

  server.registerTool(
    'createProxy',
    {
      title: 'Create Proxy',
      description:
        'Adds an HTTP or SOCKS proxy. Monitors use it once their proxyId is set to its ID (createMonitor / updateMonitor), or all at once with applyExisting. Pass username and password for a proxy that needs them.',
      inputSchema: {
        protocol: protocol.describe(`Proxy protocol: ${PROXY_PROTOCOLS.join(', ')}`),
        host: z.string().trim().min(1).describe('Proxy host name or IP address'),
        port: port.describe('Proxy port'),
        username: z.string().optional().describe('For a proxy that needs a login'),
        password: z.string().optional().describe('For a proxy that needs a login. A credential.'),
        default: isDefault,
        applyExisting,
        includeSecrets: includeSecretsParam,
      },
      outputSchema: { ok: z.boolean(), proxyID: z.number().optional(), proxy: ProxySchema.optional() },
    },
    async ({ protocol, host, port, username, password, default: makeDefault, applyExisting, includeSecrets }) => {
      await authenticateClient();

      try {
        const response = await client.saveProxy(
          {
            protocol,
            host,
            port,
            auth: !!username,
            username: username ?? '',
            password: password ?? '',
            default: makeDefault ?? false,
            applyExisting: applyExisting ?? false,
          },
          null
        );
        const proxy = show(
          client.getProxyList().find((p) => p.id === response.id),
          includeSecrets
        );
        return {
          content: [{ type: 'text', text: `Proxy ${response.id} created: ${protocol}://${host}:${port}` }],
          structuredContent: { ok: response.ok, proxyID: response.id, proxy },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create proxy: ${message.trim()}`);
      }
    }
  );

  server.registerTool(
    'updateProxy',
    {
      title: 'Update Proxy',
      description:
        'Changes a proxy. Only the fields you pass change; a password sent back as "***" keeps the stored one. Clear username (pass "") to stop sending a login. Find the ID with listProxies.',
      inputSchema: {
        proxyID: requiredId('The ID of the proxy to change'),
        protocol: protocol.optional().describe(`New protocol: ${PROXY_PROTOCOLS.join(', ')}`),
        host: z.string().trim().min(1).optional().describe('New host name or IP address'),
        port: port.optional().describe('New port'),
        username: z.string().optional().describe('"" stops sending a login'),
        password: z.string().optional().describe('A credential: "***" keeps the stored one'),
        default: isDefault,
        applyExisting,
        includeSecrets: includeSecretsParam,
      },
      outputSchema: { ok: z.boolean(), proxyID: z.number(), proxy: ProxySchema.optional() },
    },
    async ({ proxyID, includeSecrets, applyExisting, password, ...changes }) => {
      await authenticateClient();

      try {
        const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
        if (Object.keys(defined).length === 0 && password === undefined && !applyExisting) {
          throw new Error('nothing to change — pass a field to change, or applyExisting');
        }
        // addProxy writes every column from what it is sent, so the stored proxy is the base.
        const stored = client.getProxyList().find((p) => p.id === proxyID);
        if (!stored) throw new Error(`Proxy ${proxyID} not found — call listProxies to see available IDs`);

        const merged = { ...stored, ...defined };
        if (password !== undefined && password !== SECRET_MARKER) merged.password = password;
        merged.auth = !!merged.username;
        if (!merged.auth) merged.password = '';

        const response = await client.saveProxy(
          {
            protocol: merged.protocol,
            host: merged.host,
            port: merged.port,
            auth: merged.auth,
            username: merged.username ?? '',
            password: merged.password ?? '',
            default: merged.default,
            applyExisting: applyExisting ?? false,
          },
          proxyID
        );
        const proxy = show(
          client.getProxyList().find((p) => p.id === proxyID),
          includeSecrets
        );
        return {
          content: [{ type: 'text', text: `Proxy ${proxyID} updated.` }],
          structuredContent: { ok: response.ok, proxyID, proxy },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update proxy: ${message.trim()}`);
      }
    }
  );

  server.registerTool(
    'deleteProxy',
    {
      title: 'Delete Proxy',
      description:
        'Permanently deletes a proxy. Monitors that used it are kept and send their requests directly from then on. Find the ID with listProxies.',
      inputSchema: { proxyID: requiredId('The ID of the proxy to delete') },
      outputSchema: { ok: z.boolean(), msg: z.string().optional() },
    },
    async ({ proxyID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteProxy(proxyID);
        return {
          content: [{ type: 'text', text: `Proxy ${proxyID} deleted.` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const hint = /proxy not found/i.test(message) ? ' — call listProxies to see available IDs' : '';
        throw new McpError(ErrorCode.InternalError, `Failed to delete proxy: ${message}${hint}`);
      }
    }
  );
}
