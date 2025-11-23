#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createServer } from './server.js';
import type { UptimeKumaConfig } from './types.js';

/**
 * Main entry point for @davidfuchs/mcp-uptime-kuma
 * Supports both stdio (default) and streamable-http transports via CLI flags
 */

// Validate required environment variables
function validateEnvironment(readWriteEnabled: boolean): UptimeKumaConfig {
  const url = process.env.UPTIME_KUMA_URL;
  const username = process.env.UPTIME_KUMA_USERNAME;
  const password = process.env.UPTIME_KUMA_PASSWORD;
  const token = process.env.UPTIME_KUMA_2FA_TOKEN;

  if (!url) {
    console.error('Error: UPTIME_KUMA_URL environment variable is required');
    process.exit(1);
  }

  return { url, username, password, token, readWriteEnabled };
}

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let transport: 'stdio' | 'streamable-http' = 'stdio';
  let readWriteEnabled = false;
  
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
    } else if (args[i] === '--read-write') {
      readWriteEnabled = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`Usage: mcp-uptime-kuma [options]

Options:
  -t, --transport <type>  Transport type: 'stdio' (default) or 'streamable-http'
  --read-write            Enable read-write operations (default: read-only)
  -h, --help              Show this help message

Examples:
  mcp-uptime-kuma                          # Run with stdio transport (read-only)
  mcp-uptime-kuma --read-write             # Run with stdio transport (read-write enabled)
  mcp-uptime-kuma -t stdio                 # Run with stdio transport (read-only)
  mcp-uptime-kuma -t streamable-http       # Run with streamable HTTP transport (read-only, port 3000)
  mcp-uptime-kuma -t streamable-http --read-write  # Run HTTP with read-write enabled
  PORT=8080 mcp-uptime-kuma -t streamable-http  # Run HTTP on custom port
`);
      process.exit(0);
    }
  }
  
  return { transport, readWriteEnabled };
}

// Run with the stdio transport
async function runStdio(config: UptimeKumaConfig) {
  try {
    const server = await createServer(config);
    const transport = new StdioServerTransport();
    
    await server.connect(transport);
    
    console.error('mcp-uptime-kuma server running on stdio transport');
  } catch (error) {
    console.error('Fatal error in stdio transport:', error);
    process.exit(1);
  }
}

// Run with the streamable HTTP transport
async function runHttp(config: UptimeKumaConfig) {
  const app = express();
  app.use(express.json());

  // Create the MCP server once (reused across requests)
  const server = await createServer(config);

  // Handle MCP requests
  app.post('/mcp', async (req, res) => {
    try {
      // Create a new transport for each request to prevent request ID collisions
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
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

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: 'mcp-uptime-kuma' });
  });

  const port = parseInt(process.env.PORT || '3000');
  
  app.listen(port, () => {
    console.log(`mcp-uptime-kuma server running on http://localhost:${port}/mcp`);
    console.log(`Health check available at http://localhost:${port}/health`);
  }).on('error', (error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}

// Main entry point
async function main() {
  const { transport, readWriteEnabled } = parseArgs();
  const config = validateEnvironment(readWriteEnabled);
  
  if (transport === 'stdio') {
    await runStdio(config);
  } else {
    await runHttp(config);
  }
}

main();

// Also export the server creation function for programmatic use
export { createServer } from './server.js';
