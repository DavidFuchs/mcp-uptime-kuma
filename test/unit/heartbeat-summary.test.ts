import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { summariseHeartbeats } from '../../src/tools/heartbeat-summary.js';
import type { Heartbeat } from '../../src/types/index.js';

/**
 * listHeartbeats summarises more than one beat unless raw rows are asked for: the questions
 * asked of a run of beats answered on the server, for a few hundred characters instead of
 * a hundred rows.
 */

const UP = 1;
const DOWN = 0;
const PENDING = 2;

/** Beats given oldest first, the way a timeline reads, and returned newest first like the cache. */
function timeline(...beats: Array<[status: number, msg?: string, ping?: number | null]>): Heartbeat[] {
  return beats
    .map(([status, msg = '', ping = null], i) => ({
      status,
      time: `2026-11-18 10:${String(i).padStart(2, '0')}:00.000`,
      msg,
      important: false,
      ping,
    }))
    .reverse();
}

describe('summariseHeartbeats', () => {
  it('gives the span, counts by status and ping over the beats that have one', () => {
    const summary = summariseHeartbeats(timeline([UP, 'OK', 100], [UP, 'OK', 300], [PENDING, 'retry', null]));
    expect(summary).toMatchObject({
      from: '2026-11-18 10:00:00.000',
      beats: 3,
      counts: { up: 2, pending: 1 },
      ping: { min: 100, avg: 200, max: 300 },
    });
  });

  it('finds each period of DOWN beats, newest first, with its first message and where it ended', () => {
    const summary = summariseHeartbeats(
      timeline([UP], [DOWN, 'timeout'], [DOWN, 'refused'], [UP], [DOWN, '502'], [UP, 'OK'])
    );
    expect(summary?.downPeriods).toEqual([
      { start: '2026-11-18 10:04:00.000', end: '2026-11-18 10:05:00.000', beats: 1, msg: '502' },
      { start: '2026-11-18 10:01:00.000', end: '2026-11-18 10:03:00.000', beats: 2, msg: 'timeout' },
    ]);
  });

  it('leaves out the end of a period that is still going on', () => {
    const summary = summariseHeartbeats(timeline([UP], [DOWN, 'timeout'], [DOWN, 'timeout']));
    expect(summary?.downPeriods).toEqual([{ start: '2026-11-18 10:01:00.000', beats: 2, msg: 'timeout' }]);
    expect(summary?.latest).toEqual({
      time: '2026-11-18 10:02:00.000',
      status: 'down',
      msg: 'timeout',
      since: '2026-11-18 10:01:00.000',
    });
  });

  it('gives no since when every beat summarised has the latest status', () => {
    const summary = summariseHeartbeats(timeline([UP, 'OK', 10], [UP, 'OK', 10]));
    expect(summary?.latest).toEqual({ time: '2026-11-18 10:01:00.000', status: 'up', msg: 'OK' });
    expect(summary?.downPeriods).toBeUndefined();
  });

  it('leaves out ping when no beat has one, and returns nothing for no beats', () => {
    expect(summariseHeartbeats(timeline([DOWN], [DOWN]))?.ping).toBeUndefined();
    expect(summariseHeartbeats([])).toBeUndefined();
  });
});

describe('listHeartbeats summaries', () => {
  async function connect() {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'heartbeat-summary-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const call = async (args: Record<string, unknown>) =>
    (await (await connect()).callTool({ name: 'listHeartbeats', arguments: args })) as CallToolResult;

  const BEATS = timeline([UP, 'OK', 20], [DOWN, 'timeout', null], [UP, 'OK', 40]);

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getHeartbeatsForMonitor').mockReturnValue(BEATS as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('summarises more than one beat by default', async () => {
    const result = await call({ monitorID: 7, maxHeartbeats: 3 });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.heartbeats).toBeUndefined();
    expect(structured).toMatchObject({
      summaries: { '7': { beats: 3, counts: { up: 2, down: 1 }, ping: { min: 20, avg: 30, max: 40 } } },
      monitorCount: 1,
      totalHeartbeatCount: 3,
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(structured.summaries);
  });

  it('returns the beats themselves with raw', async () => {
    const result = await call({ monitorID: 7, maxHeartbeats: 3, raw: true });
    const structured = result.structuredContent as { heartbeats: Record<string, unknown[]>; summaries?: unknown };
    expect(structured.summaries).toBeUndefined();
    expect(structured.heartbeats['7']).toHaveLength(3);
  });

  it('returns rows for one beat, where a summary would be no smaller', async () => {
    const result = await call({ monitorID: 7 });
    expect((result.structuredContent as { heartbeats: unknown }).heartbeats).toBeDefined();
  });

  it('returns rows for important beats, the event list the caller asked to read', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'fetchImportantHeartbeats').mockResolvedValue(BEATS as never);
    const result = await call({ monitorID: 7, maxHeartbeats: 3, important: true });
    expect((result.structuredContent as { heartbeats: Record<string, unknown[]> }).heartbeats['7']).toHaveLength(3);
  });

  it('scrubs credentials in the messages it quotes, as the rows would be', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getHeartbeatsForMonitor').mockReturnValue(
      timeline([UP], [DOWN, 'connect ECONNREFUSED https://admin:hunter2@db.example.com']) as never
    );
    const result = await call({ monitorID: 7, maxHeartbeats: 2 });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
