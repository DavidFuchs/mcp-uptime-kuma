import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, createTestClient, extractText, extractID } from './helpers.js';

/**
 * Integration tests for a freshly started server.
 *
 * Issue coverage:
 * - #98: stateless launchers (e.g. MCP Jungle) spawn the server, call one tool the instant
 *   initialize completes, then exit. The first call must wait for authentication and the
 *   initial monitor list rather than fail with "Not authenticated" or read an empty cache.
 */

export const startupTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'fresh server answers a tool call made immediately after initialize',
    fn: async ({ client, config }) => {
      const name = 'Integration Test - Startup Race';
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: { name, type: 'http', url: 'https://example.com', interval: 120 },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        const { client: fresh } = await createTestClient(config, { settleMs: 0 });
        try {
          const result = await fresh.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult;
          const monitor = JSON.parse(extractText(result, 'getMonitor'));
          if (monitor.name !== name) throw new Error(`Expected monitor "${name}", got "${monitor.name}"`);
          console.log(`  ✓ first call on a fresh server returned monitor ID ${monitorID}`);
        } finally {
          await fresh.close();
        }
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
];
