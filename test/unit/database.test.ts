import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { formatBytes } from '../../src/tools/database.js';
import { createMockSocket, injectSocket } from './helpers.js';

describe('formatBytes', () => {
  it('reads as people read sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});

describe('the info push', () => {
  it('merges the login push over the one sent on connect', () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const { socket, onHandlers } = createMockSocket();
    injectSocket(client, socket);
    (client as unknown as { setupProxyAndKeyListListeners(): void }).setupProxyAndKeyListListeners();

    onHandlers.info({ serverTimezone: 'UTC', primaryBaseURL: null });
    onHandlers.info({ serverTimezone: 'UTC', version: '2.5.11', dbType: 'sqlite' });
    expect(client.getServerInfo()).toEqual({
      serverTimezone: 'UTC',
      primaryBaseURL: null,
      version: '2.5.11',
      dbType: 'sqlite',
    });
  });
});

describe('shrinkDatabase on the client', () => {
  it('waits longer than other calls, since VACUUM rewrites the whole file first', async () => {
    vi.useFakeTimers();
    try {
      const client = new UptimeKumaClient('http://localhost:3001');
      let answer: ((res: unknown) => void) | undefined;
      const { socket } = createMockSocket({ shrinkDatabase: (cb) => (answer = cb as (res: unknown) => void) });
      injectSocket(client, socket);

      const pending = client.shrinkDatabase();
      // Past the 30 s every other call gets, still waiting.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      answer!({ ok: true });
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('database tools', () => {
  let dbType: string | undefined;
  let sizes: number[];
  let shrink: ReturnType<typeof vi.spyOn>;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'database-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client.callTool({ name, arguments: args }) as Promise<any>;
  };

  beforeEach(() => {
    dbType = 'sqlite';
    sizes = [10 * 1024 ** 2, 4 * 1024 ** 2];
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({
      ok: true,
      data: { keepDataPeriodDays: 180 },
    } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getServerInfo').mockImplementation((() => ({ dbType })) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getDatabaseSize').mockImplementation((async () =>
      dbType === 'mariadb' ? 0 : sizes.length > 1 ? sizes.shift()! : sizes[0]) as never);
    shrink = vi.spyOn(UptimeKumaClient.prototype, 'shrinkDatabase').mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getDatabaseInfo reports an SQLite file with its size and the retention period', async () => {
    const result = await call('getDatabaseInfo');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      dbType: 'sqlite',
      sizeBytes: 10 * 1024 ** 2,
      size: '10.0 MB',
      canShrink: true,
      keepDataPeriodDays: 180,
    });
  });

  it('getDatabaseInfo says MariaDB has no size, rather than reporting 0 bytes', async () => {
    dbType = 'mariadb';
    const result = await call('getDatabaseInfo');
    expect(result.structuredContent).toMatchObject({ dbType: 'mariadb', sizeBytes: null, canShrink: false });
  });

  it('getDatabaseInfo still answers when the settings cannot be read', async () => {
    // The first call is the login check, which has to succeed.
    vi.mocked(UptimeKumaClient.prototype.getSettings)
      .mockResolvedValueOnce({ ok: true, data: {} } as never)
      .mockRejectedValue(new Error('boom'));
    const result = await call('getDatabaseInfo');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.keepDataPeriodDays).toBeNull();
  });

  it('getDatabaseInfo infers SQLite from a non-zero size before Uptime Kuma names its database', async () => {
    dbType = undefined;
    const result = await call('getDatabaseInfo');
    expect(result.structuredContent).toMatchObject({ dbType: 'sqlite', canShrink: true });
  });

  it('shrinkDatabase reports the size before and after', async () => {
    const result = await call('shrinkDatabase');
    expect(result.isError).toBeFalsy();
    expect(shrink).toHaveBeenCalledOnce();
    expect(result.structuredContent).toEqual({
      ok: true,
      sizeBefore: 10 * 1024 ** 2,
      sizeAfter: 4 * 1024 ** 2,
      freed: '6.0 MB',
    });
  });

  it('shrinkDatabase refuses on MariaDB instead of claiming to have shrunk it', async () => {
    dbType = 'mariadb';
    const result = await call('shrinkDatabase');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only shrink SQLite.*mariadb/);
    expect(shrink).not.toHaveBeenCalled();
  });

  it('getDatabaseInfo stays in read-only mode and shrinkDatabase does not', async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
      readOnly: true,
    });
    const client = new Client({ name: 'database-ro', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('getDatabaseInfo');
    expect(names).not.toContain('shrinkDatabase');
  });
});
