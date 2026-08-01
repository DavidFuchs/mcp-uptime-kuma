import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, injectSocket } from './helpers.js';

/**
 * Session-loss reporting and socket reuse — issue #64.
 *
 * `isAuthenticated` in the server layer was a write-once latch: nothing ever cleared it, so
 * after a dropped socket the MCP believed it was authenticated while Uptime Kuma treated it
 * as anonymous, and every call failed until the process was restarted.
 */
describe('UptimeKumaClient - authenticated session loss', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('reports session loss through onAuthLost with a reason', () => {
    const seen: string[] = [];
    client.onAuthLost = (reason) => seen.push(reason);

    (client as unknown as { notifyAuthLost: (r: string) => void }).notifyAuthLost('socket disconnected (transport close)');

    expect(seen).toEqual(['socket disconnected (transport close)']);
  });

  it('does not require a listener to be set', () => {
    expect(() =>
      (client as unknown as { notifyAuthLost: (r: string) => void }).notifyAuthLost('no listener attached')
    ).not.toThrow();
  });

  it('a throwing listener cannot break socket handling', () => {
    client.onAuthLost = () => { throw new Error('listener blew up'); };

    expect(() =>
      (client as unknown as { notifyAuthLost: (r: string) => void }).notifyAuthLost('boom')
    ).not.toThrow();
  });

  it('ensureConnected reuses a live socket instead of opening another', async () => {
    const { socket } = createMockSocket();
    injectSocket(client, socket);

    await client.ensureConnected();

    // connect() unconditionally assigns a new socket, orphaning the old one — which keeps
    // its listeners and keeps reconnecting. A live socket must be left alone.
    expect((client as unknown as { socket: unknown }).socket).toBe(socket);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('ensureConnected tears down a dead socket before replacing it', async () => {
    const dead = { connected: false, emit: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
    injectSocket(client, dead);

    // Stub connect() so the test does not open a real network connection; we only care that
    // the dead socket was disposed of first rather than leaked.
    const connect = vi.fn(async () => { injectSocket(client, { connected: true }); });
    (client as unknown as { connect: unknown }).connect = connect;

    await client.ensureConnected();

    expect(dead.disconnect).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
