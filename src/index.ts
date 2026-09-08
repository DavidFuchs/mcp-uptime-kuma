#!/usr/bin/env node

// Load .env file only if not in test mode (when MCP_TEST_MODE is set)
// This allows tests to pass environment variables directly without .env file interference
if (!process.env.MCP_TEST_MODE) {
  await import('dotenv/config');
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer } from './server.js';
import { parseAllowedOrigins, createOriginMiddleware, createAuthMiddleware } from './http-security.js';
import type { UptimeKumaConfig } from './types/index.js';

/**
 * Main entry point for @davidfuchs/mcp-uptime-kuma
 * Supports both stdio (default) and streamable-http transports via CLI flags
 */

// Validate required environment variables
function validateEnvironment(): UptimeKumaConfig {
  const url = process.env.UPTIME_KUMA_URL;
  const username = process.env.UPTIME_KUMA_USERNAME;
  const password = process.env.UPTIME_KUMA_PASSWORD;
  const token = process.env.UPTIME_KUMA_2FA_TOKEN;
  const jwtToken = process.env.UPTIME_KUMA_JWT_TOKEN;
  // Global opt-in to unredacted credentials in read-tool output (issue #59). Only an
  // explicit "true"/"1" enables it — an unset or misspelled value must fail closed.
  const includeSecrets = /^(true|1)$/i.test(process.env.UPTIME_KUMA_INCLUDE_SECRETS ?? '');

  if (!url) {
    console.error('Error: UPTIME_KUMA_URL environment variable is required');
    process.exit(1);
  }

  // Fail loudly and early on a credential that cannot possibly work. Uptime Kuma rejects a
  // non-JWT with the opaque message "authInvalidToken", which is indistinguishable from an
  // expired credential — so say what is actually wrong. Reports the SHAPE only, never the value.
  if (jwtToken && String(jwtToken).split('.').length !== 3) {
    console.error(
      'WARNING: UPTIME_KUMA_JWT_TOKEN is not a JWT '
      + `(${String(jwtToken).split('.').length} dot-separated segment(s), length ${String(jwtToken).length}; expected 3). `
      + 'Uptime Kuma will reject every request with "authInvalidToken". '
      + `Regenerate with: mcp-uptime-kuma-get-jwt ${url} <username> <password>`
    );
  }

  return { url, username, password, token, jwtToken, includeSecrets };
}

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let transport: 'stdio' | 'streamable-http' = 'stdio';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t' || args[i] === '--transport') {
      const value = args[i + 1];
      if (value === 'stdio' || value === 'streamable-http') {
        transport = value;
        i++; // Skip next arg since we consumed it
      } else {
        console.error(`Invalid transport: ${value}. Must be 'stdio' or 'streamable-http'`);
        process.exit(1);
      }
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`Usage: mcp-uptime-kuma [options]

Options:
  -t, --transport <type>  Transport type: 'stdio' (default) or 'streamable-http'
  -h, --help              Show this help message

Examples:
  mcp-uptime-kuma                          # Run with stdio transport
  mcp-uptime-kuma -t stdio                 # Run with stdio transport
  mcp-uptime-kuma -t streamable-http       # Run with streamable HTTP transport (port 3000)
  PORT=8080 mcp-uptime-kuma -t streamable-http  # Run HTTP on custom port

Environment variables for the streamable HTTP transport:
  MCP_AUTH_TOKEN   Shared secret required as 'Authorization: Bearer <token>'. Unset = no auth.
  ALLOWED_ORIGIN   Comma-separated origins allowed to call /mcp. Default '*' = no validation.
  HOST             Address to bind. Default '0.0.0.0'; use '127.0.0.1' for local-only.
  PORT             Port to listen on. Default 3000.
  TRUST_PROXY      Trust reverse-proxy headers (X-Forwarded-For) for rate limiting.
                   Hop count ('1'), 'true'/'false', or IP/subnet list. Unset = no trust.
`);
      process.exit(0);
    }
  }
  
  return { transport };
}

// Run with the stdio transport
async function runStdio(config: UptimeKumaConfig) {
  try {
    const { server, client, authenticateClient } = await createServer(config);
    const transport = new StdioServerTransport();

    // Shut down cleanly when the client goes away. The socket.io connection to Uptime Kuma
    // keeps Node's event loop alive, so without this the process lingers forever once the
    // client disconnects. Spawned over stdio that orphaned process also holds the parent's
    // pipe open, which is what makes a wrapping command appear to hang after its work is done.
    // The client closing our stdin is the reliable signal here: a wrapper like npx can be
    // killed without its children, but stdin EOF still reaches us.
    let shuttingDown = false;
    const shutdown = (code = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { client.disconnect(); } catch { /* best effort on the way out */ }
      process.exit(code);
    };
    process.stdin.on('end', () => shutdown());
    process.stdin.on('close', () => shutdown());
    process.on('SIGINT', () => shutdown());
    process.on('SIGTERM', () => shutdown());

    await server.connect(transport);

    // Now authenticate after transport is connected so we can log properly.
    //
    // A startup auth failure must NOT kill the process. Uptime Kuma being briefly
    // unreachable — a container restart, a host still booting, a stopped service — would
    // otherwise exit here and the MCP client would report the server as permanently broken.
    // Leave the server up and let each tool call authenticate lazily, so it recovers on its
    // own once Uptime Kuma is back.
    try {
      await authenticateClient();
    } catch (error) {
      process.stderr.write(`Initial authentication failed, will retry on demand: ${error}\n`);
    }
  } catch (error) {
    process.stderr.write(`Fatal error in stdio transport: ${error}\n`);
    process.exit(1);
  }
}

// Run with the streamable HTTP transport (stateless mode - no session management)
async function runHttp(config: UptimeKumaConfig) {
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
  const trustProxy = process.env.TRUST_PROXY;
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

  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGIN);
  const authToken = process.env.MCP_AUTH_TOKEN;

  // Rate limiting: 100 requests per 15 minutes per IP.
  //
  // Stays outermost so that an unauthenticated flood is throttled before it reaches
  // anything that does work — including the guards below.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests from this IP, please try again later.',
    })
  );

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

  // Create the MCP server once (reused across requests)
  const { server, authenticateClient } = await createServer(config);
  
  // Track authentication state - authenticate on first request when transport is connected
  let isAuthenticated = false;

  // POST: Handle all MCP requests (stateless mode)
  app.post('/mcp', async (req, res) => {
    try {
      // Create a new transport for each request to prevent request ID collisions
      // Different clients may use the same JSON-RPC request IDs, which would cause
      // responses to be routed to the wrong HTTP connections if transport state is shared
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Disable session management
        enableJsonResponse: true, // Return JSON responses instead of SSE
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      
      // Authenticate on first request (when transport is connected so logging works)
      if (!isAuthenticated) {
        isAuthenticated = true;
        try {
          await authenticateClient();
        } catch (error) {
          console.error('[MCP] Failed to authenticate with Uptime Kuma:', error);
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Authentication failed',
            },
            id: null,
          });
          return;
        }
      }
      
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

  const port = parseInt(process.env.PORT || '3000');

  // Defaults to all interfaces. The MCP spec prefers binding to loopback for a local
  // server, but this image's whole purpose is to be reached from outside its container,
  // where 0.0.0.0 is mandatory — so the safer value is offered rather than imposed.
  const host = process.env.HOST || '0.0.0.0';

  const httpServer = app.listen(port, host, () => {
    console.log(`mcp-uptime-kuma server running on http://localhost:${port}/mcp`);
    console.log(`Health check available at http://localhost:${port}/health`);

    // Warn rather than refuse to start. Both settings default to permissive so that
    // upgrading cannot break a working deployment, which makes an unprotected server the
    // quiet outcome — and a quiet outcome is exactly what nobody notices.
    if (!authToken?.trim()) {
      console.warn(
        'WARNING: MCP_AUTH_TOKEN is not set. This endpoint is unauthenticated — anyone who can '
        + 'reach it has full read/write control of your Uptime Kuma instance, including deleting monitors.'
      );
    }
    if (allowedOrigins === '*') {
      console.warn(
        'WARNING: ALLOWED_ORIGIN is "*", so no Origin validation is performed. A website the user '
        + 'visits can reach this server via DNS rebinding. Set ALLOWED_ORIGIN to a comma-separated '
        + 'list of the origins your browser-based clients actually use.'
      );
    }
  }).on('error', (error) => {
    process.stderr.write(`Server error: ${error}\n`);
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[MCP] Shutting down gracefully...');
    httpServer.close(() => {
      console.log('[MCP] Server closed');
      process.exit(0);
    });
    
    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('[MCP] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Main entry point
async function main() {
  const { transport } = parseArgs();
  const config = validateEnvironment();
  
  if (transport === 'stdio') {
    await runStdio(config);
  } else {
    await runHttp(config);
  }
}

main();

// Also export the server creation function for programmatic use
export { createServer } from './server.js';
