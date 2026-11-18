import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { fillPushExample, describeDomainRefusal } from '../../src/tools/monitor-helpers.js';
import { toolAnnotations } from '../../src/tools/registration.js';
import { createMockSocket, injectSocket } from './helpers.js';

const PYTHON_EXAMPLE = `push_url = "https://example.com/api/push/key?status=up&msg=OK&ping="
interval = 60
`;

describe('fillPushExample', () => {
  it('puts in the interval, then the URL, so a "60" in the token is left alone', () => {
    const url = 'https://kuma.lan/api/push/ab60cd?status=up&msg=OK&ping=';
    expect(fillPushExample(PYTHON_EXAMPLE, url, 30)).toBe(`push_url = "${url}"\ninterval = 30\n`);
  });
});

describe('describeDomainRefusal', () => {
  it("reads Uptime Kuma's translation keys in English, with their placeholders filled", () => {
    expect(
      describeDomainRefusal('domain_expiry_unsupported_unsupported_tld_no_rdap_endpoint', { publicSuffix: 'lan' })
    ).toBe('Domain expiry monitoring is not available for ".lan" because no RDAP service is listed by IANA');
    expect(describeDomainRefusal('some_new_key')).toBe('some_new_key');
  });
});

describe('the helper calls on the client', () => {
  it('testChrome reads the version out of the translated answer, and waits past 30 s', async () => {
    vi.useFakeTimers();
    try {
      const client = new UptimeKumaClient('http://localhost:3001');
      let answer: ((res: unknown) => void) | undefined;
      const { socket } = createMockSocket({
        testChrome: (_path, cb) => (answer = cb as (res: unknown) => void),
      });
      injectSocket(client, socket);
      const pending = client.testChrome('');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      answer!({ ok: true, msg: { key: 'foundChromiumVersion', values: ['131.0.6778.33'] }, msgi18n: true });
      await expect(pending).resolves.toBe('131.0.6778.33');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkDomain hands back a refusal as an answer rather than rejecting', async () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const refusal = { ok: false, msg: 'domain_expiry_unsupported_is_icann', msgi18n: true, meta: { domain: 'a.lan' } };
    const { socket } = createMockSocket({ checkDomain: (_p, cb) => (cb as (r: unknown) => void)(refusal) });
    injectSocket(client, socket);
    await expect(client.checkDomain({ type: 'port', hostname: 'a.lan' })).resolves.toEqual(refusal);
  });
});

describe('monitor-creation helper tools', () => {
  let monitors: Record<number, Record<string, unknown>>;
  let checkDomain: ReturnType<typeof vi.spyOn>;
  let testChrome: ReturnType<typeof vi.spyOn>;

  const connect = async (readOnly = false) => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
      readOnly,
    });
    const client = new Client({ name: 'helpers-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await connect()).callTool({ name, arguments: args }) as Promise<any>;

  beforeEach(() => {
    monitors = {
      1: { id: 1, type: 'push', interval: 45, pushToken: 'tok60secret' },
      2: { id: 2, type: 'http', url: 'https://www.example.com/health', interval: 60 },
    };
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({
      ok: true,
      data: { primaryBaseURL: 'https://kuma.example.com/', chromeExecutable: '/usr/bin/chromium' },
    } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockImplementation(((id: number) => monitors[id]) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getGameList').mockResolvedValue([
      { keys: ['csgo'], pretty: 'Counter-Strike: Global Offensive', options: { port: 27015 } },
      { keys: ['minecraft'], pretty: 'Minecraft', options: { port: 25565 }, extra: { doc_notes: 'Java edition' } },
      { keys: ['valheim'], pretty: 'Valheim', options: { port: 2456, port_query: 2457 } },
    ] as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getPM2ProcessList').mockResolvedValue([
      { id: '0', name: 'api', status: 'online' },
    ] as never);
    testChrome = vi.spyOn(UptimeKumaClient.prototype, 'testChrome').mockResolvedValue('131.0' as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getPushExample').mockResolvedValue(PYTHON_EXAMPLE as never);
    checkDomain = vi
      .spyOn(UptimeKumaClient.prototype, 'checkDomain')
      .mockResolvedValue({ ok: true, domain: 'example.com', tld: 'com' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listGames finds a game by name and returns the ID its monitor needs', async () => {
    const result = await call('listGames', { search: 'minecraft' });
    expect(result.structuredContent.games[0]).toEqual({
      id: 'minecraft',
      name: 'Minecraft',
      defaultPort: 25565,
      notes: 'Java edition',
    });
    expect(result.structuredContent.total).toBe(3);
  });

  it('listGames without a search lists from the start, up to the limit', async () => {
    const result = await call('listGames', { limit: 2 });
    expect(result.structuredContent.games.map((g: { id: string }) => g.id)).toEqual(['csgo', 'minecraft']);
    expect(result.structuredContent.count).toBe(3);
  });

  it('listPM2Processes returns the processes', async () => {
    const result = await call('listPM2Processes');
    expect(result.structuredContent).toEqual({ processes: [{ id: '0', name: 'api', status: 'online' }], count: 1 });
  });

  it('listPM2Processes says PM2 is not installed rather than only ENOENT', async () => {
    vi.mocked(UptimeKumaClient.prototype.getPM2ProcessList).mockRejectedValue(
      new Error('Unable to query PM2 process list (ENOENT).')
    );
    const result = await call('listPM2Processes');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/PM2 is not installed where Uptime Kuma runs/);
  });

  it('testChrome tests the stored chromeExecutable unless given a path', async () => {
    await call('testChrome');
    expect(testChrome).toHaveBeenLastCalledWith('/usr/bin/chromium');
    const result = await call('testChrome', { executable: '' });
    expect(testChrome).toHaveBeenLastCalledWith('');
    expect(result.structuredContent).toEqual({ ok: true, executable: '', version: '131.0' });
  });

  it("getPushExample fills in the monitor's URL and interval, the token hidden unless asked for", async () => {
    const hidden = await call('getPushExample', { monitorID: 1, language: 'python' });
    expect(hidden.isError).toBeFalsy();
    expect(JSON.stringify(hidden)).not.toContain('tok60secret');
    expect(hidden.structuredContent.code).toBe(
      'push_url = "https://kuma.example.com/api/push/***?status=up&msg=OK&ping="\ninterval = 45\n'
    );

    const shown = await call('getPushExample', { monitorID: 1, language: 'python', includeSecrets: true });
    expect(shown.structuredContent.pushURL).toBe(
      'https://kuma.example.com/api/push/tok60secret?status=up&msg=OK&ping='
    );
    expect(shown.structuredContent.code).toContain('interval = 45');
  });

  it('getPushExample refuses a monitor that is not a push monitor', async () => {
    const result = await call('getPushExample', { monitorID: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/http monitor/);
  });

  it("checkDomainExpirySupport sends a monitor's own address, or a URL or host name as the field it belongs in", async () => {
    await call('checkDomainExpirySupport', { monitorID: 2 });
    expect(checkDomain).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'http', url: 'https://www.example.com/health' })
    );
    await call('checkDomainExpirySupport', { address: 'https://shop.example.org/' });
    expect(checkDomain).toHaveBeenLastCalledWith({ type: 'http', url: 'https://shop.example.org/' });
    const result = await call('checkDomainExpirySupport', { address: 'db.example.net' });
    expect(checkDomain).toHaveBeenLastCalledWith({ type: 'port', hostname: 'db.example.net' });
    expect(result.structuredContent).toEqual({ supported: true, domain: 'example.com', tld: 'com' });
  });

  it('checkDomainExpirySupport answers an unsupported domain with the reason, not an error', async () => {
    checkDomain.mockResolvedValue({
      ok: false,
      msg: 'domain_expiry_unsupported_unsupported_tld_no_rdap_endpoint',
      msgi18n: true,
      meta: { publicSuffix: 'io' },
    } as never);
    const result = await call('checkDomainExpirySupport', { address: 'example.io' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      supported: false,
      reason: 'Domain expiry monitoring is not available for ".io" because no RDAP service is listed by IANA',
    });
  });

  it('checkDomainExpirySupport wants exactly one of monitorID and address', async () => {
    expect((await call('checkDomainExpirySupport')).isError).toBe(true);
    expect((await call('checkDomainExpirySupport', { monitorID: 2, address: 'a.com' })).isError).toBe(true);
  });

  it('none is in read-only mode, and only testChrome is marked as changing something', async () => {
    const names = (await (await connect(true)).listTools()).tools.map((t) => t.name);
    for (const tool of ['listGames', 'listPM2Processes', 'testChrome', 'getPushExample', 'checkDomainExpirySupport']) {
      expect(names).not.toContain(tool);
    }
    expect(toolAnnotations('listGames').readOnlyHint).toBe(true);
    expect(toolAnnotations('getPushExample').readOnlyHint).toBe(true);
    expect(toolAnnotations('checkDomainExpirySupport').readOnlyHint).toBe(true);
    // In the Docker image it can install Chromium.
    expect(toolAnnotations('testChrome')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
