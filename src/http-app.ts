import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createKumaSession, createServer, type KumaSession } from './server.js';
import {
  parseAllowedOrigins,
  parseRateLimitMax,
  createOriginMiddleware,
  createAuthMiddleware,
  type AllowedOrigins,
} from './http-security.js';
import type { UptimeKumaConfig } from './types/index.js';

export interface HttpApp {
  app: Express;
  session: KumaSession;
  /** The settings the app was built with, for the startup warnings. */
  authToken: string | undefined;
  allowedOrigins: AllowedOrigins;
  rateLimitMax: number;
}

/**
 * Builds the Express app for the streamable HTTP transport (stateless mode - no session
 * management). Listening is left to the caller.
 */
export async function createHttpApp(
  config: UptimeKumaConfig,
  options: { env?: Record<string, string | undefined>; session?: KumaSession } = {}
): Promise<HttpApp> {
  const env = options.env ?? process.env;
  const app = express();
  app.use(express.json());

  // When running behind a reverse proxy (ingress, load balancer, sidecar proxy),
  // set TRUST_PROXY so express-rate-limit derives the real client IP from
  // X-Forwarded-For. Without it req.ip is the proxy's address, so every client
  // shares a single rate-limit bucket and all of them start getting 429s.
  // (express-rate-limit also logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR in that case —
  // its validations wrapper catches the error and console.errors it, so it is a
  // diagnostic signal rather than the failure itself.)
  // Accepts a hop count ("1"), "true"/"false", or an IP/subnet list.
  // Defaults to Express's built-in behaviour (no trust) when unset — secure by default.
  const trustProxy = env.TRUST_PROXY;
  if (trustProxy !== undefined && trustProxy !== '') {
    const numericHops = Number(trustProxy);
    app.set(
      'trust proxy',
      trustProxy === 'true'
        ? true
        : trustProxy === 'false'
          ? false
          : Number.isNaN(numericHops)
            ? trustProxy
            : numericHops
    );
  }

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGIN);
  const authToken = env.MCP_AUTH_TOKEN;
  const rateLimitMax = parseRateLimitMax(env.RATE_LIMIT_MAX);

  // Rate limiting: RATE_LIMIT_MAX requests per 15 minutes per IP; 0 switches it off.
  //
  // Stays outermost so that an unauthenticated flood is throttled before it reaches
  // anything that does work — including the guards below.
  if (rateLimitMax > 0) {
    app.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: 'Too many requests from this IP, please try again later.',
      })
    );
  }

  // Origin validation ahead of authentication, so a caller from an origin we do not
  // recognise never gets to probe whether its token is correct. Both guards are scoped
  // to the MCP endpoint: /health has to stay reachable for container healthchecks and
  // load balancer probes, and it discloses nothing beyond the fact that we are running.
  app.use('/mcp', createOriginMiddleware(allowedOrigins));

  // CORS configuration for MCP client compatibility. `Authorization` MUST be listed:
  // without it a browser-based client's preflight rejects the very header the auth
  // guard below requires.
  app.use(
    cors({
      origin: allowedOrigins,
      exposedHeaders: ['mcp-session-id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'mcp-protocol-version'],
    })
  );

  // Authentication AFTER cors, which answers `OPTIONS` preflights itself. A preflight
  // carries no `Authorization` header by definition, so a guard placed ahead of cors
  // would 401 every browser client before it ever sent its credential.
  app.use('/mcp', createAuthMiddleware(authToken));

  // One connection to Uptime Kuma for the whole process, shared by every request.
  const session = options.session ?? createKumaSession(config);

  // POST: Handle all MCP requests (stateless mode)
  app.post('/mcp', async (req, res) => {
    try {
      // A server and a transport per request. An McpServer can be connected to only one
      // transport at a time, so a shared one answered any request that arrived while another
      // was in flight with a 500 — and agents send tool calls in parallel. Separate transports
      // also keep JSON-RPC ids apart: different clients reuse the same ids, and shared
      // transport state would route a response to the wrong HTTP connection.
      //
      // The tools log in to Uptime Kuma on demand, so nothing is authenticated here: a
      // request that needs no data (initialize, tools/list) is answered even while Uptime
      // Kuma is down, and one that does reports the failure as its own tool error.
      const { server } = await createServer(config, session);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Disable session management
        enableJsonResponse: true, // Return JSON responses instead of SSE
      });

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // GET: Session management not supported - return HTTP 405
  app.get('/mcp', (req, res) => {
    res.status(405).end();
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: 'mcp-uptime-kuma' });
  });

  return { app, session, authToken, allowedOrigins, rateLimitMax };
}
