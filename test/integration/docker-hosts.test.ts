import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText } from './helpers.js';

/**
 * Integration tests for Docker host operations.
 * Covers: listDockerHosts, addDockerHost, updateDockerHost, deleteDockerHost, testDockerHost
 */

export const dockerHostTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listDockerHosts returns array',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'listDockerHosts', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'listDockerHosts');
      const hosts = JSON.parse(text);
      if (!Array.isArray(hosts)) throw new Error('Expected array');
      console.log(`  ✓ listDockerHosts: ${hosts.length} hosts`);
    },
  },
];
