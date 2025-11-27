#!/usr/bin/env node

// Load .env file only if not in test mode (when MCP_TEST_MODE is set)
// This allows tests to pass environment variables directly without .env file interference
if (!process.env.MCP_TEST_MODE) {
  await import('dotenv/config');
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import NodeCache from 'node-cache';
import { createServer } from './server.js';
import type { UptimeKumaConfig } from './types.js';

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

// Run with the streamable HTTP transport
async function runHttp(config: UptimeKumaConfig) {
  const app = express();
  app.use(express.json());

  // CORS configuration for MCP client compatibility
  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGIN || '*', // Configure via environment variable
      exposedHeaders: ['mcp-session-id'],
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version'],
      // MUST include 'mcp-protocol-version' otherwise preflight check will error out
    })
  );

  // Rate limiting configuration
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: 'Too many requests from this IP, please try again later.',
  });

  // Apply rate limiter to all routes
  app.use(limiter);

  // Create the MCP server once (reused across requests)
  const { server, authenticateClient } = await createServer(config);
  
  // Store transports by session ID
  const transportCache = new NodeCache({
    stdTTL: 3600, // 1-hour expiry
    checkperiod: 0,
    useClones: false, // MUST include this to store references instead of cloning objects
    // otherwise the StreamableHTTPServerTransport object will be broken!
  });

  // Track authentication status at server level (not per-session)
  let isServerAuthenticated = false;

  // Handle POST requests for client-to-server communication
  app.post('/mcp', async (req, res) => {
    try {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      let transport: StreamableHTTPServerTransport | undefined;
      
      // Check if the session ID exists in the transport cache; if so reuse the transport
      if (sessionId) {
        transport = transportCache.get(sessionId);
      }

      if (!transport && isInitializeRequest(req.body)) {
        // Create a new transport only for new initialization request
        let capturedSessionId: string | undefined;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            capturedSessionId = sessionId;
            // Store the transport by session ID
            transportCache.set(sessionId, transport!);
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (capturedSessionId) {
            transportCache.del(capturedSessionId);
          }
        };
        
        // Connect the transport to the MCP server
        await server.connect(transport);
      } else if (!transport) {
        // Invalid request - no valid session ID and not an initialization request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request (authentication happens later in GET handler when SSE stream is ready)
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
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

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport | undefined;
    
    // Check if the session ID exists in the transport cache; if so reuse the transport
    if (sessionId) {
      transport = transportCache.get(sessionId);
    }

    if (!sessionId || !transport) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    // Handle the request
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport | undefined;
    
    // Check if the session ID exists in the transport cache; if so reuse the transport
    if (sessionId) {
      transport = transportCache.get(sessionId);
    }

    if (!sessionId || !transport) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    // Authenticate once for the entire server after the first SSE stream is established
    // This ensures the client can receive authentication log messages
    if (!isServerAuthenticated) {
      isServerAuthenticated = true; // Set immediately to prevent race conditions
      try {
        await authenticateClient();
      } catch (error) {
        console.error('Authentication error:', error);
        // Continue anyway - the error will be logged via sendLoggingMessage
      }
    }
    
    // Handle the request
    await transport.handleRequest(req, res);
  });

  // Handle DELETE requests for session termination
  app.delete('/mcp', handleSessionRequest);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: 'mcp-uptime-kuma' });
  });

  const port = parseInt(process.env.PORT || '3000');
  
  app.listen(port, () => {
    console.log(`mcp-uptime-kuma server running on http://localhost:${port}/mcp`);
    console.log(`Health check available at http://localhost:${port}/health`);
  }).on('error', (error) => {
    process.stderr.write(`Server error: ${error}\n`);
    process.exit(1);
  });
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
