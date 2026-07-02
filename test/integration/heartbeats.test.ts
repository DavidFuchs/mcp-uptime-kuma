import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText } from './helpers.js';

/**
 * Integration tests for heartbeat operations.
 * Covers: getHeartbeats, listHeartbeats
 */

export const heartbeatTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listHeartbeats returns data for monitors',
    fn: async ({ client }) => {
      const result = await client.callTool({
        name: 'listHeartbeats',
        arguments: { maxHeartbeats: 3 },
      }) as CallToolResult;
      const text = extractText(result, 'listHeartbeats');
      const data = JSON.parse(text);
      // Should be an object keyed by monitor ID
      if (typeof data !== 'object' || data === null) throw new Error('Expected object');
      const monitorCount = Object.keys(data).length;
      console.log(`  ✓ listHeartbeats: data for ${monitorCount} monitors`);
    },
  },
  {
    name: 'getHeartbeats returns heartbeats for a specific monitor',
    fn: async ({ client }) => {
      // Find a monitor to query
      const listResult = await client.callTool({ name: 'listMonitors', arguments: {} }) as CallToolResult;
      const monitors = JSON.parse(extractText(listResult, 'listMonitors'));

      if (monitors.length === 0) {
        console.log('  ⚠ getHeartbeats: skipped (no monitors)');
        return;
      }

      const monitorID = monitors[0].id;
      const result = await client.callTool({
        name: 'getHeartbeats',
        arguments: { monitorID, maxHeartbeats: 5 },
      }) as CallToolResult;
      const text = extractText(result, 'getHeartbeats');
      const heartbeats = JSON.parse(text);
      if (!Array.isArray(heartbeats)) throw new Error('Expected array');
      console.log(`  ✓ getHeartbeats: ${heartbeats.length} heartbeats for monitor ${monitorID}`);
    },
  },
];
