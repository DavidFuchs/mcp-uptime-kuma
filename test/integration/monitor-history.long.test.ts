import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractText, extractID } from './helpers.js';

/**
 * Long-running monitor tests: these wait for Uptime Kuma to actually run checks.
 * Run with `npm run test:integration:long`, which runs the short suites first.
 *
 * The targets are Uptime Kuma's own port, which is reachable from inside its container
 * without any outside network.
 */

const KUMA_PORT_IN_CONTAINER = 3001;
const POLL_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const monitorHistoryTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: '#110: heartbeat history survives a type change, and checks continue under the new type',
    fn: async ({ client }) => {
      const monitorID = extractID(await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - Issue 110 history',
          type: 'http',
          url: `http://localhost:${KUMA_PORT_IN_CONTAINER}`,
          interval: 20,
        },
      }) as CallToolResult, 'createMonitor', 'monitorID');

      const beats = async (): Promise<Array<{ time: string; status: number }>> => JSON.parse(extractText(
        await client.callTool({ name: 'getHeartbeats', arguments: { monitorID, maxHeartbeats: 100 } }) as CallToolResult,
        'getHeartbeats'
      ));

      const waitForBeats = async (enough: (b: Array<{ time: string; status: number }>) => boolean, what: string) => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const current = await beats();
          if (enough(current)) return current;
          await sleep(POLL_MS);
        }
        throw new Error(`timed out after 60s waiting for ${what}`);
      };

      try {
        const before = await waitForBeats((b) => b.length >= 1, 'the first heartbeat as http');
        const timesBefore = before.map((b) => b.time);

        extractText(await client.callTool({
          name: 'updateMonitor',
          arguments: { monitorID, type: 'port', hostname: 'localhost', port: KUMA_PORT_IN_CONTAINER },
        }) as CallToolResult, 'updateMonitor');

        const after = await waitForBeats(
          (b) => b.some((beat) => !timesBefore.includes(beat.time)),
          'a heartbeat under the new type'
        );
        const timesAfter = after.map((b) => b.time);
        const lost = timesBefore.filter((t) => !timesAfter.includes(t));
        if (lost.length > 0) {
          throw new Error(`${lost.length} of ${timesBefore.length} heartbeat(s) from before the type change are gone`);
        }
        const newest = after.filter((b) => !timesBefore.includes(b.time));
        if (!newest.some((b) => b.status === 1)) {
          throw new Error(`no UP heartbeat as a port monitor; statuses: ${newest.map((b) => b.status).join(', ')}`);
        }

        console.log(`  ✓ #110: ${timesBefore.length} http heartbeat(s) kept; ${newest.length} new one(s) as a port monitor`);
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
];
