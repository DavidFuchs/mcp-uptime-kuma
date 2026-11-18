import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractText } from './helpers.js';

/**
 * Integration tests for heartbeat operations.
 * Covers: listHeartbeats, for all monitors and for one
 */

export const heartbeatTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listHeartbeats returns data for monitors',
    fn: async ({ client }) => {
      const result = (await client.callTool({
        name: 'listHeartbeats',
        arguments: { maxHeartbeats: 3 },
      })) as CallToolResult;
      const text = extractText(result, 'listHeartbeats');
      const data = JSON.parse(text);
      // Should be an object keyed by monitor ID
      if (typeof data !== 'object' || data === null) throw new Error('Expected object');
      const monitorCount = Object.keys(data).length;
      console.log(`  ✓ listHeartbeats: data for ${monitorCount} monitors`);
    },
  },
  {
    name: 'listHeartbeats with monitorID returns that monitor only',
    fn: async ({ client }) => {
      // Find a monitor to query
      const listResult = (await client.callTool({ name: 'listMonitors', arguments: {} })) as CallToolResult;
      const monitors = JSON.parse(extractText(listResult, 'listMonitors'));

      if (monitors.length === 0) {
        console.log('  ⚠ listHeartbeats { monitorID }: skipped (no monitors)');
        return;
      }

      const monitorID = monitors[0].id;
      const result = (await client.callTool({
        name: 'listHeartbeats',
        arguments: { monitorID, maxHeartbeats: 5, raw: true },
      })) as CallToolResult;
      const data = JSON.parse(extractText(result, 'listHeartbeats'));
      if (Object.keys(data).join() !== String(monitorID)) {
        throw new Error(`Expected only monitor ${monitorID}, got ${Object.keys(data).join(', ')}`);
      }
      const heartbeats = data[String(monitorID)];
      if (!Array.isArray(heartbeats)) throw new Error('Expected array');
      console.log(`  ✓ listHeartbeats { monitorID }: ${heartbeats.length} heartbeats for monitor ${monitorID}`);
    },
  },
  {
    name: '#56: beats come back newest-first, and maxHeartbeats is honoured',
    fn: async ({ client }) => {
      const summaries = JSON.parse(
        extractText(
          (await client.callTool({ name: 'getMonitorSummary', arguments: {} })) as CallToolResult,
          'getMonitorSummary'
        )
      );

      // Find a monitor that actually has history to order.
      let target: number | undefined;
      let beats: any[] = [];
      for (const s of summaries) {
        const got = JSON.parse(
          extractText(
            (await client.callTool({
              name: 'listHeartbeats',
              arguments: { monitorID: s.id, maxHeartbeats: 5, raw: true },
            })) as CallToolResult,
            'listHeartbeats'
          )
        )[String(s.id)];
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

      // The second half of #56: a call asking for several beats returned exactly one.
      if (beats.length < 3) throw new Error(`maxHeartbeats:5 returned ${beats.length} beat(s)`);

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
    name: 'listHeartbeats summarises more than one beat, matching the rows',
    fn: async ({ client }) => {
      type Beat = { time: string; status: number };
      type Summary = { from: string; beats: number; counts: Record<string, number>; latest: { time: string } };
      const call = async (args: Record<string, unknown>) =>
        (
          (await client.callTool({
            name: 'listHeartbeats',
            arguments: { maxHeartbeats: 20, ...args },
          })) as CallToolResult & {
            structuredContent: { heartbeats?: Record<string, Beat[]>; summaries?: Record<string, Summary> };
          }
        ).structuredContent;

      const rows = (await call({ raw: true })).heartbeats ?? {};
      const id = Object.keys(rows).find((k) => rows[k].length >= 2);
      if (id === undefined) {
        console.log('  ⚠ heartbeat summary: skipped (no monitor with ≥2 heartbeats yet)');
        return;
      }

      // Read both from one call each; a beat may arrive in between, so compare the summary
      // with rows fetched right after it.
      const summary = (await call({ monitorID: Number(id) })).summaries?.[id];
      const after = (await call({ monitorID: Number(id), raw: true })).heartbeats?.[id] ?? [];
      if (!summary) throw new Error(`no summary for monitor ${id}`);
      const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
      if (total !== summary.beats) throw new Error(`counts add up to ${total}, not ${summary.beats}`);
      if (summary.beats < 2 || summary.beats > 20) throw new Error(`summarised ${summary.beats} beats`);
      if (Date.parse(summary.from) > Date.parse(summary.latest.time)) throw new Error('from is after latest.time');
      if (Date.parse(summary.latest.time) > Date.parse(after[0].time)) {
        throw new Error(`summary ends at ${summary.latest.time}, after the newest beat ${after[0].time}`);
      }
      console.log(`  ✓ heartbeat summary: monitor ${id}, ${summary.beats} beats, ${JSON.stringify(summary.counts)}`);
    },
  },
  {
    name: 'getMonitorSummary exposes lastBeatTime, matching the newest beat',
    fn: async ({ client }) => {
      const summaries = JSON.parse(
        extractText(
          (await client.callTool({ name: 'getMonitorSummary', arguments: {} })) as CallToolResult,
          'getMonitorSummary'
        )
      );
      const withBeat = summaries.find((s: any) => s.lastBeatTime);
      if (!withBeat) {
        console.log('  ⚠ lastBeatTime: skipped (no monitor has beaten yet)');
        return;
      }

      const beats = JSON.parse(
        extractText(
          (await client.callTool({
            name: 'listHeartbeats',
            arguments: { monitorID: withBeat.id, maxHeartbeats: 1 },
          })) as CallToolResult,
          'listHeartbeats'
        )
      )[String(withBeat.id)];

      // These are two reads of a cache a live server keeps mutating, so a beat landing
      // between them would fail a bare equality check on a perfectly correct build. Read
      // the summary again afterwards and accept either observation: whichever side of the
      // listHeartbeats call the new beat landed on, one of the two summaries saw the same
      // beat that listHeartbeats did. Both being wrong needs two beats inside one round
      // trip, which the 20s minimum check interval rules out.
      const after = JSON.parse(
        extractText(
          (await client.callTool({ name: 'getMonitorSummary', arguments: {} })) as CallToolResult,
          'getMonitorSummary'
        )
      );
      const observed = [withBeat.lastBeatTime, after.find((s: any) => s.id === withBeat.id)?.lastBeatTime].filter(
        Boolean
      );

      if (!observed.includes(beats[0]?.time)) {
        throw new Error(`lastBeatTime ${observed.join(' / ')} != newest beat ${beats[0]?.time}`);
      }
      // Without this, a push monitor that stopped beating is indistinguishable from a
      // healthy one — it keeps reporting its last known status forever.
      console.log(`  ✓ lastBeatTime matches the newest beat (monitor ${withBeat.id})`);
    },
  },
  {
    name: 'important:true returns event history from the server, newest-first',
    fn: async ({ client }) => {
      const summaries = JSON.parse(
        extractText(
          (await client.callTool({ name: 'getMonitorSummary', arguments: {} })) as CallToolResult,
          'getMonitorSummary'
        )
      );
      if (summaries.length === 0) {
        console.log('  ⚠ important: skipped (no monitors)');
        return;
      }

      for (const s of summaries) {
        const important = JSON.parse(
          extractText(
            (await client.callTool({
              name: 'listHeartbeats',
              arguments: { monitorID: s.id, important: true, maxHeartbeats: 10 },
            })) as CallToolResult,
            'listHeartbeats'
          )
        )[String(s.id)];
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
  {
    name: 'getMonitorUptime counts real checks; clearMonitorEvents and clearMonitorHeartbeats run',
    fn: async ({ client }) => {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = (await client.callTool({ name, arguments: args })) as CallToolResult & {
          structuredContent: Record<string, any>;
        };
        if (result.isError) throw new Error(`${name} failed: ${extractText(result, name)}`);
        return result.structuredContent;
      };

      // Uptime Kuma itself, from inside its container: UP on the first check, made at once.
      const created = await call('createMonitor', {
        name: 'zz-uptime-history-delete-me',
        type: 'http',
        url: 'http://127.0.0.1:3001',
        interval: 20,
      });
      const monitorID = created.monitorID as number;
      if (!monitorID) throw new Error('createMonitor returned no monitorID');
      try {
        let uptime: Record<string, any> = {};
        for (let i = 0; i < 30; i++) {
          uptime = await call('getMonitorUptime', { monitorID, hours: 1 });
          if (uptime.checks.up > 0) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!(uptime.checks.up > 0)) throw new Error(`no UP check counted: ${JSON.stringify(uptime)}`);
        if (uptime.uptimePercent !== 100) throw new Error(`expected 100% up, got ${uptime.uptimePercent}`);
        if (uptime.granularity !== 'minute') throw new Error(`expected minute buckets, got ${uptime.granularity}`);

        const week = await call('getMonitorUptime', { monitorID, hours: 168 });
        if (week.granularity !== 'hour' || !(week.checks.up > 0)) {
          throw new Error(`a week did not count the check per hour: ${JSON.stringify(week)}`);
        }

        await call('clearMonitorEvents', { monitorID });
        await call('clearMonitorHeartbeats', { monitorID });
        console.log(
          `  ✓ getMonitorUptime: ${uptime.checks.up} UP check(s), 100%; clear tools ran on monitor ${monitorID}`
        );
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
];
