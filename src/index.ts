#!/usr/bin/env node

// Load .env file only if not in test mode (when MCP_TEST_MODE is set)
// This allows tests to pass environment variables directly without .env file interference
if (!process.env.MCP_TEST_MODE) {
  await import('dotenv/config');
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { createHttpApp, type HttpApp } from './http-app.js';
import { parseExtraHeaders } from './extra-headers.js';
import { parsePort, listenUrl } from './http-listen.js';
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
  // Leave out every tool that creates, changes or deletes. Same parsing as above: only an
  // explicit "true"/"1" enables it.
  const readOnly = /^(true|1)$/i.test(process.env.UPTIME_KUMA_READ_ONLY ?? '');

  if (!url) {
    console.error('Error: UPTIME_KUMA_URL environment variable is required');
    process.exit(1);
  }

  // Unlike a bad JWT, malformed headers are fatal: silently dropping them would just move
  // the failure to an opaque 403 from the proxy in front of Kuma.
  let extraHeaders: Record<string, string> | undefined;
  try {
    extraHeaders = parseExtraHeaders(process.env.UPTIME_KUMA_HEADERS);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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

  return { url, username, password, token, jwtToken, includeSecrets, readOnly, extraHeaders };
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
  RATE_LIMIT_MAX   Requests allowed per client IP every 15 minutes. Default 1000; 0 = no limit.
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
    // The reader of our stdout can vanish before stdin closes (a killed client). The next write
    // then fails with EPIPE, which crashes the process as an unhandled 'error' event unless
    // something listens for it. Nobody is left to answer, so shut down.
    process.stdout.on('error', () => shutdown());
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
  let httpApp: HttpApp;
  let port: number;
  try {
    port = parsePort(process.env.PORT);
    httpApp = await createHttpApp(config);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const { app, session, authToken, allowedOrigins } = httpApp;

  // Log in now so the first tool call finds the monitor list already loaded. Not fatal:
  // Uptime Kuma may still be starting, and every tool call logs in on demand.
  session.authenticateClient().catch((error) => {
    console.error(`[MCP] Initial authentication failed, will retry on demand: ${error}`);
  });

  // Defaults to all interfaces. The MCP spec prefers binding to loopback for a local
  // server, but this image's whole purpose is to be reached from outside its container,
  // where 0.0.0.0 is mandatory — so the safer value is offered rather than imposed.
  const host = process.env.HOST || '0.0.0.0';

  const httpServer = app.listen(port, host, () => {
    // The port actually bound, which is not the one asked for when that was 0.
    const address = httpServer.address();
    const boundPort = address !== null && typeof address === 'object' ? address.port : port;
    console.log(`mcp-uptime-kuma server running on ${listenUrl(host, boundPort, '/mcp')}`);
    console.log(`Health check available at ${listenUrl(host, boundPort, '/health')}`);

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

  // Graceful shutdown: stop accepting requests, let those in flight finish, then drop the
  // connection to Uptime Kuma, which would otherwise keep the process alive.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[MCP] Shutting down gracefully...');
    httpServer.close(() => {
      console.log('[MCP] Server closed');
      try { session.client.disconnect(); } catch { /* best effort on the way out */ }
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

// This file is the command-line program and nothing else: loading it starts a server. To build
// a server in your own code, import the package itself, which resolves to server.js.
await main();
