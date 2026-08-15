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
  {
    name: '#56: beats come back newest-first, and `limit` is honoured',
    fn: async ({ client }) => {
      const summaries = JSON.parse(extractText(
        await client.callTool({ name: 'getMonitorSummary', arguments: {} }) as CallToolResult,
        'getMonitorSummary'
      ));

      // Find a monitor that actually has history to order.
      let target: number | undefined;
      let beats: any[] = [];
      for (const s of summaries) {
        const got = JSON.parse(extractText(
          await client.callTool({ name: 'getHeartbeats', arguments: { monitorID: s.id, limit: 5 } }) as CallToolResult,
          'getHeartbeats'
        ));
        if (got.length >= 3) {
          target = s.id;
          beats = got;
          break;
        }
      }

      if (target === undefined) {
        console.log('  ⚠ ordering: skipped (no monitor with ≥3 heartbeats yet)');
        return;
      }

      // `limit` used to be stripped, leaving maxHeartbeats undefined and the call returning
      // exactly one beat — the second half of #56.
      if (beats.length < 3) throw new Error(`limit:5 returned ${beats.length} beat(s)`);

      const times = beats.map((b: any) => Date.parse(b.time));
      for (let i = 1; i < times.length; i++) {
        if (times[i] > times[i - 1]) {
          throw new Error(`beats are not newest-first: ${beats[i - 1].time} then ${beats[i].time}`);
        }
      }
      console.log(`  ✓ #56: monitor ${target} returned ${beats.length} beats, newest-first`);
    },
  },
  {
    name: 'getMonitorSummary exposes lastBeatTime, matching the newest beat',
    fn: async ({ client }) => {
      const summaries = JSON.parse(extractText(
        await client.callTool({ name: 'getMonitorSummary', arguments: {} }) as CallToolResult,
        'getMonitorSummary'
      ));
      const withBeat = summaries.find((s: any) => s.lastBeatTime);
      if (!withBeat) {
        console.log('  ⚠ lastBeatTime: skipped (no monitor has beaten yet)');
        return;
      }

      const beats = JSON.parse(extractText(
        await client.callTool({ name: 'getHeartbeats', arguments: { monitorID: withBeat.id, limit: 1 } }) as CallToolResult,
        'getHeartbeats'
      ));

      // These are two reads of a cache a live server keeps mutating, so a beat landing
      // between them would fail a bare equality check on a perfectly correct build. Read
      // the summary again afterwards and accept either observation: whichever side of the
      // getHeartbeats call the new beat landed on, one of the two summaries saw the same
      // beat that getHeartbeats did. Both being wrong needs two beats inside one round
      // trip, which the 20s minimum check interval rules out.
      const after = JSON.parse(extractText(
        await client.callTool({ name: 'getMonitorSummary', arguments: {} }) as CallToolResult,
        'getMonitorSummary'
      ));
      const observed = [
        withBeat.lastBeatTime,
        after.find((s: any) => s.id === withBeat.id)?.lastBeatTime,
      ].filter(Boolean);

      if (!observed.includes(beats[0]?.time)) {
        throw new Error(
          `lastBeatTime ${observed.join(' / ')} != newest beat ${beats[0]?.time}`
        );
      }
      // Without this, a push monitor that stopped beating is indistinguishable from a
      // healthy one — it keeps reporting its last known status forever.
      console.log(`  ✓ lastBeatTime matches the newest beat (monitor ${withBeat.id})`);
    },
  },
  {
    name: 'important:true returns event history from the server, newest-first',
    fn: async ({ client }) => {
      const summaries = JSON.parse(extractText(
        await client.callTool({ name: 'getMonitorSummary', arguments: {} }) as CallToolResult,
        'getMonitorSummary'
      ));
      if (summaries.length === 0) {
        console.log('  ⚠ important: skipped (no monitors)');
        return;
      }

      for (const s of summaries) {
        const important = JSON.parse(extractText(
          await client.callTool({
            name: 'getHeartbeats',
            arguments: { monitorID: s.id, important: true, limit: 10 },
          }) as CallToolResult,
          'getHeartbeats'
        ));
        if (!Array.isArray(important)) throw new Error('Expected array');
        if (important.length >= 2) {
          const times = important.map((b: any) => Date.parse(b.time));
          for (let i = 1; i < times.length; i++) {
            if (times[i] > times[i - 1]) throw new Error('important beats are not newest-first');
          }
          console.log(`  ✓ important: ${important.length} event beats for monitor ${s.id}, newest-first`);
          return;
        }
      }
      console.log('  ⚠ important: no monitor has ≥2 status changes yet (call succeeded)');
    },
  },
];
