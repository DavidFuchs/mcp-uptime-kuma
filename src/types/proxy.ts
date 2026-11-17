import { z } from 'zod';

/** The proxy protocols Uptime Kuma accepts (Proxy.SUPPORTED_PROXY_PROTOCOLS). */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks', 'socks5', 'socks5h', 'socks4'] as const;

/**
 * A proxy monitors can send their requests through. Uptime Kuma pushes these as raw rows
 * (snake_case, 0/1 flags); the client normalizes them to this shape.
 */
export const ProxySchema = z
  .object({
    id: z.number(),
    protocol: z.string().describe(`One of ${PROXY_PROTOCOLS.join(', ')}`),
    host: z.string(),
    port: z.number(),
    auth: z.boolean().describe('Whether the proxy takes a username and password'),
    username: z.string().nullable().optional(),
    password: z.string().nullable().optional().describe('A credential: "***" unless includeSecrets is set'),
    default: z.boolean().describe('New monitors created in the web UI use this proxy'),
    createdDate: z.string().nullable().optional(),
  })
  .passthrough();

export type KumaProxy = z.infer<typeof ProxySchema>;

/** A remote Chrome that real-browser monitors can run in instead of the built-in Chromium. */
export const RemoteBrowserSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    url: z
      .string()
      .describe(
        'WebSocket endpoint, e.g. ws://browserless:3000. Credentials in it read "***" unless includeSecrets is set'
      ),
  })
  .passthrough();

export type RemoteBrowser = z.infer<typeof RemoteBrowserSchema>;

/**
 * An API key, as Uptime Kuma lists it: the key itself is never returned after creation, only
 * this description of it.
 */
export const APIKeySchema = z
  .object({
    id: z.number(),
    name: z.string(),
    active: z.boolean(),
    expires: z.string().nullable().optional().describe('"YYYY-MM-DD HH:mm:ss", or null for never'),
    status: z.string().describe('active, inactive or expired'),
    createdDate: z.string().nullable().optional(),
  })
  .passthrough();

export type APIKey = z.infer<typeof APIKeySchema>;
