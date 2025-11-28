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

  if (!url) {
    console.error('Error: UPTIME_KUMA_URL environment variable is required');
    process.exit(1);
  }

  return { url, username, password, token, jwtToken };
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
`);
      process.exit(0);
    }
  }
  
  return { transport };
}

// Run with the stdio transport
async function runStdio(config: UptimeKumaConfig) {
  try {
    const { server, authenticateClient } = await createServer(config);
    const transport = new StdioServerTransport();
    
    await server.connect(transport);
    
    // Now authenticate after transport is connected so we can log properly
    await authenticateClient();
  } catch (error) {
    process.stderr.write(`Fatal error in stdio transport: ${error}\n`);
    process.exit(1);
  }
}

// Run with the streamable HTTP transport (stateless mode - no session management)
async function runHttp(config: UptimeKumaConfig) {
  const app = express();
  app.use(express.json());

  // CORS configuration for MCP client compatibility
  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGIN || '*',
      exposedHeaders: ['mcp-session-id'],
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version'],
    })
  );

  // Rate limiting: 100 requests per 15 minutes per IP
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests from this IP, please try again later.',
    })
  );

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
  
  const httpServer = app.listen(port, () => {
    console.log(`mcp-uptime-kuma server running on http://localhost:${port}/mcp`);
    console.log(`Health check available at http://localhost:${port}/health`);
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
