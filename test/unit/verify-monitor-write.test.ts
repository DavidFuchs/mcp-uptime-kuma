import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, injectSocket, injectMonitorListCache } from './helpers.js';

/**
 * Post-write read-back verification.
 *
 * The point of these tests is the FAULT INJECTION: a read-back you never see fail is
 * indistinguishable from a comment. Each case makes the server acknowledge a write
 * ({"ok":true,"msg":"Saved."}, exactly as Uptime Kuma does) while the stored row does not
 * contain the value that was asked for, and asserts the tool refuses to report success.
 */

const EXISTING_MONITOR = {
  id: 7,
  name: 'Existing',
  type: 'http',
  url: 'https://example.com',
  interval: 60,
  retryInterval: 60,
  description: 'before',
  timeout: 48,
};

async function connectServer() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });

  const client = new Client({ name: 'verify-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('post-write read-back verification', () => {
  let fetchMonitor: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Authentication is not what these tests are about.
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue(
      { ...EXISTING_MONITOR } as never
    );
    // Uptime Kuma's answer to any edit it accepts — including one that changed nothing.
    vi.spyOn(UptimeKumaClient.prototype, 'updateMonitor').mockResolvedValue({
      ok: true,
      msg: 'Saved.',
      monitorID: 7,
    } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'createMonitor').mockResolvedValue({
      ok: true,
      msg: 'Added Successfully.',
      monitorID: 7,
    } as never);
    fetchMonitor = vi.spyOn(UptimeKumaClient.prototype, 'fetchMonitor');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails the call when a field is acknowledged but not stored', async () => {
    // The write is dropped server-side: the row comes back with the OLD description.
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, description: 'before' } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, description: 'after' },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('description');
    expect(text).toContain('did NOT persist');
    // The misleading part is the acknowledgement, so it must be named.
    expect(text).toContain('Saved.');
  });

  it('passes the call through when the value did land', async () => {
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, description: 'after' } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, description: 'after' },
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMonitor).toHaveBeenCalledWith(7);
  });

  it('does not read back at all when no verified field was touched', async () => {
    const { client } = await connectServer();

    await client.callTool({ name: 'updateMonitor', arguments: { monitorID: 7, name: 'Renamed' } });

    // A rename costs nothing extra; verification is only for the dangerous fields.
    expect(fetchMonitor).not.toHaveBeenCalled();
  });

  it('tolerates the whole-second rounding Uptime Kuma applies to a ping timeout', async () => {
    // Monitor.validate() rounds a ping timeout, so 47.5 -> 48 is correct behaviour and must
    // not be reported as a failed write.
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, type: 'ping', timeout: 48 } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, timeout: 47.5 },
    });

    expect(result.isError).toBeFalsy();
  });

  it('still fails on a timeout that is wrong beyond rounding', async () => {
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, timeout: 0 } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, timeout: 48 },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('timeout');
    // A stored 0 is the dangerous case — say why rather than just reporting a mismatch.
    expect(text).toContain('13 hours');
  });

  it('never puts a push token in the error message', async () => {
    const sent = 'a'.repeat(32);
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, type: 'push', pushToken: 'b'.repeat(32) } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, pushToken: sent },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('pushToken');
    expect(text).toContain('32-character');
    // Both the sent and the stored token are credentials.
    expect(text).not.toContain(sent);
    expect(text).not.toContain('b'.repeat(32));
  });

  it('reports a failure to verify as distinct from a verified failure', async () => {
    fetchMonitor.mockRejectedValue(new Error('Not connected to server') as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, description: 'after' },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('could NOT be verified');
    // "I could not check" must not read as "it definitely failed".
    expect(text).toContain('Do not assume it applied');
  });

  it('verifies creates as well as updates', async () => {
    fetchMonitor.mockResolvedValue({ id: 7, type: 'http', description: 'before' } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'createMonitor',
      arguments: { name: 'New', type: 'http', url: 'https://example.com', interval: 60, description: 'after' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('created');
  });
});

describe('UptimeKumaClient.fetchMonitor', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('reads from the server rather than the cache', async () => {
    // The cache says one thing, the server another. fetchMonitor must return the server's
    // answer — that difference is the entire reason this method exists.
    injectMonitorListCache(client, { '7': { id: 7, description: 'stale cached value' } });
    const { socket } = createMockSocket({
      getMonitor: (_id, callback) => {
        (callback as (res: unknown) => void)({ ok: true, monitor: { id: 7, description: 'server value' } });
      },
    });
    injectSocket(client, socket);

    const monitor = await client.fetchMonitor(7);

    expect(monitor.description).toBe('server value');
    expect(client.getMonitor(7)?.description).toBe('stale cached value');
  });

  it('rejects when the server reports failure', async () => {
    const { socket } = createMockSocket({
      getMonitor: (_id, callback) => {
        (callback as (res: unknown) => void)({ ok: false, msg: 'Monitor not found' });
      },
    });
    injectSocket(client, socket);

    await expect(client.fetchMonitor(999)).rejects.toThrow('Monitor not found');
  });

  it('rejects when not connected', async () => {
    injectSocket(client, { connected: false, emit: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() });
    await expect(client.fetchMonitor(7)).rejects.toThrow('Not connected to server');
  });
});
