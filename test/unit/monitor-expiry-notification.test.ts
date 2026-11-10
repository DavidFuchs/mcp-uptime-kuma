import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Issue #110: expiryNotification and domainExpiryNotification are plain booleans that Uptime
 * Kuma's add and editMonitor handlers both accept, but neither write tool declared them.
 */

process.setMaxListeners(50);

const EXISTING_MONITOR = {
  id: 7,
  name: 'Existing',
  type: 'http',
  url: 'https://example.com',
  interval: 60,
  retryInterval: 60,
  timeout: 48,
  expiryNotification: false,
  domainExpiryNotification: false,
};

async function connectServer() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });

  const client = new Client({ name: 'expiry-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('certificate and domain expiry notification toggles (#110)', () => {
  let fetchMonitor: ReturnType<typeof vi.spyOn>;
  let lastWrite: Record<string, unknown>;

  beforeEach(() => {
    lastWrite = {};
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({ ...EXISTING_MONITOR } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'createMonitor').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      lastWrite = data;
      return { ok: true, msg: 'Added Successfully.', monitorID: 7 };
    }) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'updateMonitor').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      lastWrite = data;
      return { ok: true, msg: 'Saved.', monitorID: 7 };
    }) as never);
    // By default the server stores exactly what it was sent.
    fetchMonitor = vi
      .spyOn(UptimeKumaClient.prototype, 'fetchMonitor')
      .mockImplementation((async () => ({ ...lastWrite })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updateMonitor sends both toggles to Uptime Kuma', async () => {
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, expiryNotification: true, domainExpiryNotification: true },
    });

    expect(result.isError).toBeFalsy();
    expect(lastWrite).toMatchObject({ id: 7, expiryNotification: true, domainExpiryNotification: true });
  });

  it('createMonitor sends both toggles to Uptime Kuma', async () => {
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'createMonitor',
      arguments: {
        name: 'New',
        type: 'http',
        url: 'https://example.com',
        expiryNotification: true,
        domainExpiryNotification: false,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(lastWrite).toMatchObject({ expiryNotification: true, domainExpiryNotification: false });
  });

  it('createMonitor leaves the toggles out when the caller did not pass them', async () => {
    // Older Uptime Kuma 2.0 has no domain_expiry_notification column to import into.
    const { client } = await connectServer();

    await client.callTool({
      name: 'createMonitor',
      arguments: { name: 'New', type: 'http', url: 'https://example.com' },
    });

    expect(lastWrite).not.toHaveProperty('expiryNotification');
    expect(lastWrite).not.toHaveProperty('domainExpiryNotification');
  });

  it('fails the call when a toggle is acknowledged but not stored', async () => {
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, domainExpiryNotification: false } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, domainExpiryNotification: true },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('domainExpiryNotification');
    expect(text).toContain('did NOT persist');
  });

  it('accepts the 0/1 a database row holds as the stored form of a toggle', async () => {
    fetchMonitor.mockResolvedValue({ ...EXISTING_MONITOR, expiryNotification: 1 } as never);
    const { client } = await connectServer();

    const result = await client.callTool({
      name: 'updateMonitor',
      arguments: { monitorID: 7, expiryNotification: true },
    });

    expect(result.isError).toBeFalsy();
  });
});
