import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, injectSocket } from './helpers.js';

/**
 * A disconnect between an emit and its acknowledgement leaves a socket.io callback that is
 * never invoked. Every call that waits on one must give up eventually, or the tool call that
 * made it never returns.
 */
describe('UptimeKumaClient - acknowledgements that never come', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new UptimeKumaClient('http://localhost:3001');
    // No emit handlers: the socket accepts every emit and acknowledges none of them.
    injectSocket(client, createMockSocket().socket);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const calls: Array<[string, (c: UptimeKumaClient) => Promise<unknown>]> = [
    ['login', (c) => c.login('admin', 'password')],
    ['login by JWT', (c) => c.login(undefined, undefined, undefined, 'a.b.c')],
    ['getSettings', (c) => c.getSettings()],
    ['pauseMonitor', (c) => c.pauseMonitor(1)],
    ['resumeMonitor', (c) => c.resumeMonitor(1)],
    ['createMonitor', (c) => c.createMonitor({ name: 'x', type: 'http' })],
    ['updateMonitor', (c) => c.updateMonitor({ id: 1, name: 'x' })],
    ['deleteMonitor', (c) => c.deleteMonitor(1)],
    ['fetchImportantHeartbeats', (c) => c.fetchImportantHeartbeats(1)],
    ['addNotification', (c) => c.addNotification({ name: 'x', type: 'slack' })],
    ['deleteNotification', (c) => c.deleteNotification(1)],
    ['addDockerHost', (c) => c.addDockerHost({ name: 'x' })],
    ['deleteDockerHost', (c) => c.deleteDockerHost(1)],
    ['addTag', (c) => c.addTag('x', '#000')],
    ['deleteTag', (c) => c.deleteTag(1)],
    ['createMaintenance', (c) => c.createMaintenance({ title: 'x' })],
    ['editMaintenance', (c) => c.editMaintenance({ id: 1, title: 'x' })],
    ['setMonitorMaintenance', (c) => c.setMonitorMaintenance(1, [2])],
    ['pauseMaintenance', (c) => c.pauseMaintenance(1)],
    ['resumeMaintenance', (c) => c.resumeMaintenance(1)],
    ['deleteMaintenance', (c) => c.deleteMaintenance(1)],
    ['getStatusPageConfig', (c) => c.getStatusPageConfig('s')],
    ['createStatusPage', (c) => c.createStatusPage('t', 's')],
    ['updateStatusPage', (c) => c.updateStatusPage('s', {})],
    ['deleteStatusPage', (c) => c.deleteStatusPage('s')],
  ];

  it.each(calls)('%s rejects instead of waiting forever', async (_name, call) => {
    const outcome = call(client).then(
      () => 'resolved',
      (error: Error) => error.message
    );

    await vi.advanceTimersByTimeAsync(60_000);

    // Promise.race against an already-settled marker: a promise still pending loses.
    const settled = await Promise.race([outcome, Promise.resolve('still pending')]);
    expect(settled).toMatch(/no response from Uptime Kuma/i);
  });

  it('testDockerHost reports the missing answer as a failed test', async () => {
    const outcome = client.testDockerHost({ name: 'x' });
    await vi.advanceTimersByTimeAsync(60_000);

    const settled = await Promise.race([outcome, Promise.resolve('still pending')]);
    expect(settled).toMatchObject({ ok: false, msg: expect.stringMatching(/no response from Uptime Kuma/i) });
  });

  it('listTags falls back to the cache when the catalog never arrives', async () => {
    const outcome = client.getTagList();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await Promise.race([outcome, Promise.resolve('still pending')])).toEqual([]);
  });

  it('says a write may have been applied, since only the answer is known to be missing', async () => {
    const outcome = client.deleteMonitor(7).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toMatch(/may or may not have been applied/);
  });

  it('ignores an acknowledgement that arrives after the wait was given up', async () => {
    let lateAck: ((response: unknown) => void) | undefined;
    const { socket } = createMockSocket({
      deleteMonitor: (_id, callback) => { lateAck = callback as (response: unknown) => void; },
    });
    injectSocket(client, socket);

    const outcome = client.deleteMonitor(7).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toMatch(/no response/i);

    expect(() => lateAck?.({ ok: true })).not.toThrow();
  });

  it('leaves no timer running once the server has answered', async () => {
    const { socket } = createMockSocket({
      deleteMonitor: (_id, callback) => (callback as (response: unknown) => void)({ ok: true }),
    });
    injectSocket(client, socket);

    await client.deleteMonitor(7);

    expect(vi.getTimerCount()).toBe(0);
  });
});
