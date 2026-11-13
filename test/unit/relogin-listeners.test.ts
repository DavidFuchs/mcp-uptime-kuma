import { describe, it, expect } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { injectSocket } from './helpers.js';

/**
 * A socket that keeps every listener it is given, as socket.io does, and acknowledges logins.
 * The shared mock in helpers.ts keeps only the last listener per event, which hides the very
 * thing under test here.
 */
function createListeningSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const socket = {
    connected: true,
    emit: (event: string, ...args: unknown[]) => {
      const ack = args[args.length - 1];
      if ((event === 'login' || event === 'loginByToken') && typeof ack === 'function') {
        ack({ ok: true });
      }
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    off: (event: string) => {
      listeners.delete(event);
    },
    disconnect: () => {},
  };

  const deliver = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  };

  return { socket, listeners, deliver };
}

const DATA_EVENTS = [
  'monitorList',
  'updateMonitorIntoList',
  'deleteMonitorFromList',
  'heartbeatList',
  'heartbeat',
  'uptime',
  'avgPing',
  'notificationList',
  'tagList',
  'maintenanceList',
  'statusPageList',
  'dockerHostList',
];

/**
 * After a dropped connection socket.io reconnects the SAME socket, and the next tool call
 * logs in on it again. Each login must leave one listener per event, not one more.
 */
describe('UptimeKumaClient - logging in again on the same socket', () => {
  it.each(DATA_EVENTS)('keeps a single %s listener', async (event) => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const { socket, listeners } = createListeningSocket();
    injectSocket(client, socket);

    await client.login('admin', 'password');
    await client.login('admin', 'password');
    await client.login('admin', 'password');

    expect(listeners.get(event)).toHaveLength(1);
  });

  it('still receives data after logging in again', async () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const { socket, deliver } = createListeningSocket();
    injectSocket(client, socket);

    await client.login('admin', 'password');
    await client.login('admin', 'password');
    deliver('monitorList', { '1': { id: 1, name: 'Web', type: 'http', pathName: 'Web' } });
    deliver('heartbeat', { monitorID: 1, status: 1, msg: 'OK', ping: 5, time: '2026-01-01 00:00:00.000' });

    expect(client.getMonitor(1)?.name).toBe('Web');
    expect(client.getHeartbeatsForMonitor(1, 10)).toHaveLength(1);
  });

  it('disconnect removes every data listener it added', async () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const { socket, listeners } = createListeningSocket();
    injectSocket(client, socket);

    await client.login('admin', 'password');
    client.disconnect();

    for (const event of DATA_EVENTS) expect(listeners.get(event)).toBeUndefined();
  });
});
