import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, injectSocket, injectHeartbeatListCache, injectMonitorListCache } from './helpers.js';

/**
 * Heartbeat ordering, staleness and the limit aliases.
 *
 * #57 established the newest-first invariant for the connect-time list. These cover the
 * cases a reverse-on-receipt does not: a live beat that arrives out of order, duplicates
 * across a refresh, and the important-beat feed, which arrives in the OPPOSITE order.
 */

const beat = (id: number, time: string, extra: Record<string, unknown> = {}) => ({
  id,
  monitorID: 1,
  status: 1,
  time,
  msg: `beat-${id}`,
  ...extra,
});

/** A live `heartbeat` event, which carries no id at all. */
const liveBeat = (time: string, extra: Record<string, unknown> = {}) => ({
  monitorID: 1,
  status: 1,
  time,
  msg: 'live',
  ...extra,
});

describe('compareBeatsNewestFirst', () => {
  it('orders by time, newest first', () => {
    const list = [
      beat(1, '2026-07-28 03:56:20.051'),
      beat(3, '2026-07-28 04:13:43.158'),
      beat(2, '2026-07-28 04:12:59.125'),
    ];
    const sorted = [...list].sort(UptimeKumaClient.compareBeatsNewestFirst);
    expect(sorted.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it('sorts by time and NOT by id, so live beats are not sunk', () => {
    // A live beat has no id. An id-based comparator would push it to the bottom, which is
    // exactly the wrong end — it is the newest thing the client knows about.
    const list = [beat(500, '2026-07-28 03:00:00.000'), liveBeat('2026-07-28 05:00:00.000')];
    const sorted = [...list].sort(UptimeKumaClient.compareBeatsNewestFirst);
    expect(sorted[0].msg).toBe('live');
  });

  it('uses id only to break a same-millisecond tie', () => {
    const list = [beat(1, '2026-07-28 04:00:00.000'), beat(2, '2026-07-28 04:00:00.000')];
    const sorted = [...list].sort(UptimeKumaClient.compareBeatsNewestFirst);
    expect(sorted.map((b) => b.id)).toEqual([2, 1]);
  });

  it('sorts an unparseable timestamp last instead of corrupting the head', () => {
    // Index 0 is what every read depends on, so garbage must never land there.
    const list = [beat(1, 'not a date'), beat(2, '2026-07-28 04:00:00.000')];
    const sorted = [...list].sort(UptimeKumaClient.compareBeatsNewestFirst);
    expect(sorted[0].id).toBe(2);
  });
});

describe('heartbeat cache ordering', () => {
  let client: UptimeKumaClient;
  let handlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
    const { socket, onHandlers } = createMockSocket();
    injectSocket(client, socket);
    handlers = onHandlers;
    (client as unknown as { setupHeartbeatListeners: () => void }).setupHeartbeatListeners();
  });

  it('normalises the connect-time list, which arrives oldest-first', () => {
    handlers.heartbeatList(1, [
      beat(1, '2026-07-28 03:56:20.051'),
      beat(2, '2026-07-28 04:12:59.125'),
      beat(3, '2026-07-28 04:13:43.158'),
    ]);

    expect(client.getLatestHeartbeat(1)?.id).toBe(3);
  });

  it('re-asserts the order when a live beat arrives out of sequence', () => {
    // A reconnect, a heartbeatList refresh racing a live beat, or a clock step all produce
    // this. unshift alone would leave an older beat sitting at index 0.
    handlers.heartbeatList(1, [beat(1, '2026-07-28 04:00:00.000'), beat(2, '2026-07-28 05:00:00.000')]);
    handlers.heartbeat(liveBeat('2026-07-28 04:30:00.000'));

    const beats = client.getHeartbeatsForMonitor(1, 10);
    expect(beats[0].id).toBe(2);
    expect(beats.map((b) => b.time)).toEqual([
      '2026-07-28 05:00:00.000',
      '2026-07-28 04:30:00.000',
      '2026-07-28 04:00:00.000',
    ]);
  });

  it('keeps a genuinely newer live beat at the head', () => {
    handlers.heartbeatList(1, [beat(1, '2026-07-28 04:00:00.000')]);
    handlers.heartbeat(liveBeat('2026-07-28 06:00:00.000'));

    expect(client.getLatestHeartbeat(1)?.time).toBe('2026-07-28 06:00:00.000');
  });

  it('de-duplicates when a refresh re-sends beats already held', () => {
    handlers.heartbeatList(1, [beat(1, '2026-07-28 04:00:00.000'), beat(2, '2026-07-28 05:00:00.000')]);
    handlers.heartbeatList(1, [
      beat(1, '2026-07-28 04:00:00.000'),
      beat(2, '2026-07-28 05:00:00.000'),
      beat(3, '2026-07-28 06:00:00.000'),
    ]);

    expect(client.getHeartbeatsForMonitor(1, 100)).toHaveLength(3);
  });

  it('still caps the cache at 100 beats', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      beat(i, `2026-07-28 04:00:${String(i % 60).padStart(2, '0')}.000`)
    );
    handlers.heartbeatList(1, many);
    handlers.heartbeat(liveBeat('2026-07-29 04:00:00.000'));

    expect(client.getHeartbeatsForMonitor(1, 1000).length).toBeLessThanOrEqual(100);
  });
});

describe('getLatestHeartbeat and lastBeatTime', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('returns undefined when nothing is cached', () => {
    expect(client.getLatestHeartbeat(1)).toBeUndefined();
  });

  it('exposes lastBeatTime on the summary so staleness is checkable', () => {
    // The real hazard ordering alone does not solve: a push monitor that STOPPED beating
    // reports its last known status forever and looks identical to a healthy one.
    injectMonitorListCache(client, {
      '1': { id: 1, name: 'Backup', type: 'push', active: true, pathName: 'Backup', maintenance: false },
    });
    injectHeartbeatListCache(client, {
      '1': [beat(9, '2026-07-20 01:00:00.000', { status: 1, msg: 'sync-ok' })],
    });

    const [summary] = client.getMonitorSummary();
    expect(summary.status).toBe(1);
    expect(summary.msg).toBe('sync-ok');
    expect(summary.lastBeatTime).toBe('2026-07-20 01:00:00.000');
  });

  it('reports the status of the NEWEST beat, not the oldest retained one', () => {
    injectMonitorListCache(client, {
      '1': { id: 1, name: 'Recyclarr', type: 'push', active: true, pathName: 'Recyclarr', maintenance: false },
    });
    // Deliberately in the order Uptime Kuma sends them: oldest first, and the oldest is a
    // failure. Reading the head of the raw list would report a stale DOWN.
    injectHeartbeatListCache(client, {
      '1': UptimeKumaClient.normaliseBeats([
        beat(1, '2026-07-28 03:56:20.051', { status: 2, msg: 'sync-failed-rc1' }),
        beat(2, '2026-07-28 04:13:43.158', { status: 1, msg: 'sync-ok-2-of-2' }),
      ]),
    });

    const [summary] = client.getMonitorSummary();
    expect(summary.status).toBe(1);
    expect(summary.msg).toBe('sync-ok-2-of-2');
  });
});

describe('fetchImportantHeartbeats', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('fetches live from the server rather than the cache', async () => {
    injectHeartbeatListCache(client, { '1': [beat(1, '2026-07-28 04:00:00.000')] });
    const { socket } = createMockSocket({
      monitorImportantHeartbeatListPaged: (_id, _offset, _count, callback) => {
        (callback as (res: unknown) => void)({
          ok: true,
          data: [beat(50, '2026-07-28 09:00:00.000', { important: 1 })],
        });
      },
    });
    injectSocket(client, socket);

    const beats = await client.fetchImportantHeartbeats(1, 10);
    expect(beats).toHaveLength(1);
    expect(beats[0].id).toBe(50);
  });

  it('normalises the feed, which arrives in the opposite order to heartbeatList', async () => {
    // monitorImportantHeartbeatListPaged is ORDER BY time DESC — already newest-first —
    // so it goes through the same comparator rather than being trusted either way.
    const { socket } = createMockSocket({
      monitorImportantHeartbeatListPaged: (_id, _offset, _count, callback) => {
        (callback as (res: unknown) => void)({
          ok: true,
          data: [
            beat(10, '2026-07-28 02:00:00.000'),
            beat(30, '2026-07-28 08:00:00.000'),
            beat(20, '2026-07-28 05:00:00.000'),
          ],
        });
      },
    });
    injectSocket(client, socket);

    const beats = await client.fetchImportantHeartbeats(1, 10);
    expect(beats.map((b) => b.id)).toEqual([30, 20, 10]);
  });

  it('rejects when not connected', async () => {
    injectSocket(client, { connected: false, emit: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() });
    await expect(client.fetchImportantHeartbeats(1)).rejects.toThrow('Not connected to server');
  });
});

describe('maxHeartbeats aliases (limit / count)', () => {
  let getHeartbeatsForMonitor: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    getHeartbeatsForMonitor = vi
      .spyOn(UptimeKumaClient.prototype, 'getHeartbeatsForMonitor')
      .mockReturnValue([] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connect() {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'hb-test', version: '1.0.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  it('honours `limit`, which used to be stripped and silently return one beat', async () => {
    const client = await connect();
    await client.callTool({ name: 'getHeartbeats', arguments: { monitorID: 105, limit: 3 } });
    expect(getHeartbeatsForMonitor).toHaveBeenCalledWith(105, 3);
  });

  it('honours `count` as well', async () => {
    const client = await connect();
    await client.callTool({ name: 'getHeartbeats', arguments: { monitorID: 105, count: 7 } });
    expect(getHeartbeatsForMonitor).toHaveBeenCalledWith(105, 7);
  });

  it('still defaults to one beat when nothing is given', async () => {
    const client = await connect();
    await client.callTool({ name: 'getHeartbeats', arguments: { monitorID: 105 } });
    expect(getHeartbeatsForMonitor).toHaveBeenCalledWith(105, 1);
  });

  it('errors on an alias that disagrees with maxHeartbeats rather than picking one', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'getHeartbeats',
      arguments: { monitorID: 105, maxHeartbeats: 3, limit: 9 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Conflicting values');
  });

  it('accepts an alias that agrees with maxHeartbeats', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'getHeartbeats',
      arguments: { monitorID: 105, maxHeartbeats: 3, limit: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(getHeartbeatsForMonitor).toHaveBeenCalledWith(105, 3);
  });

  it('routes important:true to the live server fetch, not the cache', async () => {
    const fetchImportant = vi
      .spyOn(UptimeKumaClient.prototype, 'fetchImportantHeartbeats')
      .mockResolvedValue([] as never);
    const client = await connect();

    await client.callTool({ name: 'getHeartbeats', arguments: { monitorID: 105, important: true, limit: 5 } });

    expect(fetchImportant).toHaveBeenCalledWith(105, 5);
    expect(getHeartbeatsForMonitor).not.toHaveBeenCalled();
  });
});

/**
 * The important/event feed is a SECOND way to read heartbeat data, and it bypasses the
 * cache entirely. #74/#78 redacted the cached path; if that were the only path guarded,
 * `important: true` would be an unguarded way to read the same credential back out (#59).
 */
describe('important heartbeats go through the same redaction as the cached path', () => {
  const secretBeat = {
    id: 90,
    monitorID: 105,
    status: 0,
    time: '2026-08-02 10:00:00',
    important: 1,
    msg: 'connect ECONNREFUSED http://admin:s3cret@internal.local:8080',
    // A passthrough column Uptime Kuma sends but the schema does not declare.
    response: '{"access_token":"abc123"}',
  };

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'fetchImportantHeartbeats').mockResolvedValue([secretBeat] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connect() {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'hb-redact-test', version: '1.0.0' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  it('scrubs a credential the event message quotes', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'getHeartbeats',
      arguments: { monitorID: 105, important: true },
    });

    const beats = (result.structuredContent as { heartbeats: { msg: string }[] }).heartbeats;
    expect(beats[0].msg).toBe('connect ECONNREFUSED http://***:***@internal.local:8080');
    // The text block is stringified separately and no output schema touches it.
    expect(JSON.stringify(result.content)).not.toContain('s3cret');
  });

  it('drops the passthrough response column from the event feed too', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'getHeartbeats',
      arguments: { monitorID: 105, important: true },
    });

    expect(JSON.stringify(result.content)).not.toContain('access_token');
  });

  it('still returns the real value when includeSecrets is set', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'getHeartbeats',
      arguments: { monitorID: 105, important: true, includeSecrets: true },
    });

    const beats = (result.structuredContent as { heartbeats: { msg: string }[] }).heartbeats;
    expect(beats[0].msg).toContain('admin:s3cret@internal.local');
  });
});
