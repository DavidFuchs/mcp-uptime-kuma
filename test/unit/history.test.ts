import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { summarizeUptime } from '../../src/tools/history.js';
import { createMockSocket, injectSocket } from './helpers.js';

describe('summarizeUptime', () => {
  it('counts up against down, leaves maintenance out, and weights ping by UP checks', () => {
    const s = summarizeUptime(
      [
        { timestamp: 1_700_000_000, up: 3, down: 0, avgPing: 100, minPing: 80, maxPing: 120 },
        { timestamp: 1_700_000_060, up: 1, down: 1, avgPing: 200, minPing: 200, maxPing: 200 },
        { timestamp: 1_700_000_120, up: 0, down: 0, maintenance: 4 },
      ],
      24
    );

    expect(s.checks).toEqual({ up: 4, down: 1, maintenance: 4 });
    expect(s.uptimePercent).toBe(80);
    expect(s.ping).toEqual({ avg: 125, min: 80, max: 200 });
    expect(s.granularity).toBe('minute');
    expect(s.downtimeBucketCount).toBe(1);
    expect(s.downtimeBuckets).toEqual([{ start: new Date(1_700_000_060_000).toISOString(), down: 1, up: 1 }]);
  });

  it('reports no uptime rather than 0% when there were no checks', () => {
    expect(summarizeUptime([], 168)).toMatchObject({ uptimePercent: null, granularity: 'hour', ping: { avg: null } });
  });

  it('lists the newest failed buckets first, and at most 50', () => {
    const buckets = Array.from({ length: 60 }, (_, i) => ({ timestamp: i * 86400, up: 1, down: 1 }));
    const s = summarizeUptime(buckets, 2000);

    expect(s.granularity).toBe('day');
    expect(s.downtimeBucketCount).toBe(60);
    expect(s.downtimeBuckets).toHaveLength(50);
    expect(s.downtimeBuckets[0].start).toBe(new Date(59 * 86400_000).toISOString());
  });
});

describe('UptimeKumaClient history calls', () => {
  it('emits getMonitorChartData with the monitor and hours, and clearStatistics with no arguments', async () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const seen: unknown[][] = [];
    const { socket } = createMockSocket({
      getMonitorChartData: (id, hours, callback) => {
        seen.push(['chart', id, hours]);
        (callback as (res: unknown) => void)({ ok: true, data: [{ timestamp: 1, up: 1, down: 0 }] });
      },
      clearStatistics: (callback) => {
        seen.push(['clearStatistics']);
        (callback as (res: unknown) => void)({ ok: true });
      },
    });
    injectSocket(client, socket);

    expect(await client.getMonitorChartData(3, 168)).toEqual([{ timestamp: 1, up: 1, down: 0 }]);
    await client.clearStatistics();
    expect(seen).toEqual([['chart', 3, 168], ['clearStatistics']]);
  });
});

describe('history, clearing and test-notification tools', () => {
  let chart: ReturnType<typeof vi.spyOn>;
  let clearHeartbeats: ReturnType<typeof vi.spyOn>;
  let clearStatistics: ReturnType<typeof vi.spyOn>;
  let testNotification: ReturnType<typeof vi.spyOn>;

  const connect = async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'history-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    (await connect()).callTool({ name, arguments: args }) as Promise<any>;

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockImplementation(((id: number) =>
      id === 3 ? { id: 3, name: 'API' } : undefined) as never);
    chart = vi
      .spyOn(UptimeKumaClient.prototype, 'getMonitorChartData')
      .mockResolvedValue([{ timestamp: 1_700_000_000, up: 9, down: 1, avgPing: 50 }] as never);
    clearHeartbeats = vi.spyOn(UptimeKumaClient.prototype, 'clearHeartbeats').mockResolvedValue({ ok: true } as never);
    clearStatistics = vi.spyOn(UptimeKumaClient.prototype, 'clearStatistics').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getNotificationList').mockReturnValue([
      {
        id: 2,
        name: 'Ops Slack',
        config: JSON.stringify({ name: 'Ops Slack', type: 'slack', slackwebhookURL: 'https://hooks.slack.com/x' }),
      },
    ] as never);
    testNotification = vi
      .spyOn(UptimeKumaClient.prototype, 'testNotification')
      .mockResolvedValue({ ok: true, msg: 'Sent Successfully.' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getMonitorUptime defaults to 24 hours', async () => {
    const result = await call('getMonitorUptime', { monitorID: 3 });

    expect(result.isError).toBeFalsy();
    expect(chart).toHaveBeenCalledWith(3, 24);
    expect(result.structuredContent).toMatchObject({ monitorID: 3, hours: 24, uptimePercent: 90 });
  });

  it('getMonitorUptime rounds a period beyond 30 days up to whole days', async () => {
    const result = await call('getMonitorUptime', { monitorID: 3, hours: 1000 });

    expect(chart).toHaveBeenCalledWith(3, 1008);
    expect(result.structuredContent).toMatchObject({ hours: 1008, granularity: 'day' });
  });

  it.each([
    ['getMonitorUptime', { monitorID: 99 }],
    ['clearMonitorEvents', { monitorID: 99 }],
    ['clearMonitorHeartbeats', { monitorID: 99 }],
  ])('%s refuses a monitor that does not exist', async (name, args) => {
    const result = await call(name, args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Monitor 99 not found.*listMonitors/);
  });

  it('clearMonitorHeartbeats clears the monitor it is given', async () => {
    const result = await call('clearMonitorHeartbeats', { monitorID: 3 });

    expect(result.isError).toBeFalsy();
    expect(clearHeartbeats).toHaveBeenCalledWith(3);
  });

  it('clearAllStatistics refuses without confirm: true', async () => {
    for (const args of [{}, { confirm: false }]) {
      const result = await call('clearAllStatistics', args);
      expect(result.isError).toBe(true);
    }
    expect(clearStatistics).not.toHaveBeenCalled();

    expect((await call('clearAllStatistics', { confirm: true })).isError).toBeFalsy();
    expect(clearStatistics).toHaveBeenCalledTimes(1);
  });

  it("testNotification sends the stored channel's whole config, as Uptime Kuma's Test button does", async () => {
    const result = await call('testNotification', { notificationID: 2 });

    expect(result.isError).toBeFalsy();
    expect(testNotification).toHaveBeenCalledWith({
      name: 'Ops Slack',
      type: 'slack',
      slackwebhookURL: 'https://hooks.slack.com/x',
    });
    expect(result.structuredContent).toEqual({ ok: true, msg: 'Sent Successfully.' });
  });

  it('testNotification refuses a channel that does not exist', async () => {
    const result = await call('testNotification', { notificationID: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Notification 99 not found.*listNotifications/);
    expect(testNotification).not.toHaveBeenCalled();
  });

  it('marks the clear tools destructive, and testNotification as reaching outside Uptime Kuma', async () => {
    const { tools } = await (await connect()).listTools();
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;

    for (const name of ['clearMonitorEvents', 'clearMonitorHeartbeats', 'clearAllStatistics']) {
      expect(hints(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(hints('testNotification')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(hints('getMonitorUptime')).toMatchObject({ readOnlyHint: true });
  });
});
