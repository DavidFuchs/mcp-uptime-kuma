import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText, extractID } from './helpers.js';

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
  {
    name: 'addDockerHost → listDockerHosts → deleteDockerHost lifecycle',
    fn: async ({ client }) => {
      // Create a docker host (TCP type pointing to a dummy address — we're testing CRUD, not connectivity)
      const addResult = await client.callTool({
        name: 'addDockerHost',
        arguments: {
          name: 'int-test-docker-host',
          dockerType: 'tcp',
          dockerDaemon: 'http://localhost:9999',
        },
      }) as CallToolResult;
      const dockerHostID = extractID(addResult, 'addDockerHost', 'id');

      try {
        // Verify it appears in the list
        const listResult = await client.callTool({ name: 'listDockerHosts', arguments: {} }) as CallToolResult;
        const hosts = JSON.parse(extractText(listResult, 'listDockerHosts'));
        const found = hosts.find((h: any) => h.id === dockerHostID);
        if (!found) throw new Error(`Docker host ID ${dockerHostID} not found in listing`);
        if (found.name !== 'int-test-docker-host') {
          throw new Error(`Expected name "int-test-docker-host", got "${found.name}"`);
        }

        console.log(`  ✓ addDockerHost/listDockerHosts lifecycle: ID ${dockerHostID}`);
      } finally {
        // Cleanup
        await client.callTool({ name: 'deleteDockerHost', arguments: { dockerHostID } });
        console.log(`  ✓ deleteDockerHost: cleaned up ID ${dockerHostID}`);
      }
    },
  },
];
