import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { redactRemoteBrowserUrl } from '../../src/tools/remote-browsers.js';
import { normalizeExpiry } from '../../src/tools/api-keys.js';
import { createMockSocket, injectSocket, injectMonitorListCache } from './helpers.js';

describe('the pushed lists', () => {
  it('normalizes proxyList rows (snake_case, 0/1 flags) and apiKeyList flags', () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const { socket, onHandlers } = createMockSocket();
    injectSocket(client, socket);
    (client as unknown as { setupProxyAndKeyListListeners(): void }).setupProxyAndKeyListListeners();

    onHandlers.proxyList([
      {
        id: 1,
        user_id: 1,
        protocol: 'http',
        host: 'proxy.lan',
        port: 3128,
        auth: 1,
        username: 'u',
        password: 'p',
        active: 1,
        default: 0,
        created_date: '2026-11-17 10:00:00',
      },
    ]);
    onHandlers.apiKeyList([{ id: 4, name: 'prom', active: 1, expires: null, status: 'active' }]);

    expect(client.getProxyList()).toEqual([
      {
        id: 1,
        protocol: 'http',
        host: 'proxy.lan',
        port: 3128,
        auth: true,
        username: 'u',
        password: 'p',
        default: false,
        createdDate: '2026-11-17 10:00:00',
      },
    ]);
    expect(client.getAPIKeyList()[0].active).toBe(true);
  });
});

// Found by the integration test: Uptime Kuma clears the reference in its database but pushes
// no new monitor list, so the cached monitor kept pointing at the deleted proxy.
describe('deleting a proxy or remote browser', () => {
  it('clears it from the cached monitors that used it, and only from those', async () => {
    const client = new UptimeKumaClient('http://localhost:3001');
    const ok = (callback: unknown) => (callback as (res: unknown) => void)({ ok: true });
    const { socket } = createMockSocket({
      deleteProxy: (_id, callback) => ok(callback),
      deleteRemoteBrowser: (_id, callback) => ok(callback),
    });
    injectSocket(client, socket);
    injectMonitorListCache(client, {
      '1': { id: 1, name: 'a', type: 'http', proxyId: 3 },
      '2': { id: 2, name: 'b', type: 'http', proxyId: 4 },
      '3': { id: 3, name: 'c', type: 'real-browser', remote_browser: 5 },
    });

    await client.deleteProxy(3);
    await client.deleteRemoteBrowser(5);

    expect(client.getMonitor(1, true)).toMatchObject({ proxyId: null });
    expect(client.getMonitor(2, true)).toMatchObject({ proxyId: 4 });
    expect(client.getMonitor(3, true)).toMatchObject({ remote_browser: null });
  });
});

describe('redactRemoteBrowserUrl', () => {
  it.each([
    ['ws://browserless:3000?token=abc123', 'ws://browserless:3000?token=***'],
    ['wss://user:pw@chrome.example.com/playwright', 'wss://***:***@chrome.example.com/playwright'],
    ['ws://host:3000?launch=headless&apiKey=k#frag', 'ws://host:3000?launch=headless&apiKey=***#frag'],
    ['ws://host:3000/devtools', 'ws://host:3000/devtools'],
    ['ws://host:3000?%zz=1&token=t', 'ws://host:3000?%zz=1&token=***'],
  ])('%s -> %s', (url, expected) => {
    expect(redactRemoteBrowserUrl(url)).toBe(expected);
  });
});

describe('normalizeExpiry', () => {
  it.each([
    ['2027-01-31', '2027-01-31 23:59:59'],
    ['2027-01-31 08:30', '2027-01-31 08:30:00'],
    ['2027-01-31T08:30:15', '2027-01-31 08:30:15'],
  ])('%s -> %s', (value, expected) => {
    expect(normalizeExpiry(value)).toBe(expected);
  });

  it('refuses anything else', () => {
    expect(() => normalizeExpiry('next week')).toThrow(/YYYY-MM-DD/);
  });
});

describe('proxy, remote browser and API key tools', () => {
  let proxies: Array<Record<string, unknown>>;
  let saveProxy: ReturnType<typeof vi.spyOn>;
  let saveRemoteBrowser: ReturnType<typeof vi.spyOn>;
  let testRemoteBrowser: ReturnType<typeof vi.spyOn>;
  let addAPIKey: ReturnType<typeof vi.spyOn>;
  let setAPIKeyActive: ReturnType<typeof vi.spyOn>;

  const connect = async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'proxies-test', version: '1.0.0' }, { capabilities: {} });
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
    proxies = [
      {
        id: 1,
        protocol: 'http',
        host: 'proxy.lan',
        port: 3128,
        auth: true,
        username: 'u',
        password: 'stored-pw',
        default: false,
        createdDate: null,
      },
    ];
    vi.spyOn(UptimeKumaClient.prototype, 'getProxyList').mockImplementation((() => proxies) as never);
    saveProxy = vi.spyOn(UptimeKumaClient.prototype, 'saveProxy').mockImplementation((async (
      proxy: Record<string, unknown>,
      id: number | null
    ) => {
      const { applyExisting: _applyExisting, ...rest } = proxy;
      const saved: Record<string, unknown> = { ...rest, id: id ?? 2 };
      proxies = [...proxies.filter((p) => p.id !== saved.id), saved];
      return { ok: true, id: saved.id };
    }) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getRemoteBrowserList').mockReturnValue([
      { id: 5, name: 'browserless', url: 'ws://browserless:3000?token=secret' },
    ] as never);
    saveRemoteBrowser = vi
      .spyOn(UptimeKumaClient.prototype, 'saveRemoteBrowser')
      .mockResolvedValue({ ok: true, id: 5 } as never);
    testRemoteBrowser = vi
      .spyOn(UptimeKumaClient.prototype, 'testRemoteBrowser')
      .mockResolvedValue({ ok: true, msg: 'Connected Successfully.' } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getAPIKeyList').mockReturnValue([
      { id: 4, name: 'prom', active: true, expires: null, status: 'active' },
    ] as never);
    addAPIKey = vi
      .spyOn(UptimeKumaClient.prototype, 'addAPIKey')
      .mockResolvedValue({ ok: true, keyID: 7, key: 'uk7_abcdef' } as never);
    setAPIKeyActive = vi.spyOn(UptimeKumaClient.prototype, 'setAPIKeyActive').mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listProxies hides passwords unless includeSecrets is set', async () => {
    const hidden = await call('listProxies', {});
    expect(JSON.stringify(hidden)).not.toContain('stored-pw');

    const shown = await call('listProxies', { includeSecrets: true });
    expect(shown.structuredContent.proxies[0].password).toBe('stored-pw');
  });

  it('createProxy turns auth on when a username is given', async () => {
    const result = await call('createProxy', {
      protocol: 'socks5',
      host: 'sock.lan',
      port: 1080,
      username: 'a',
      password: 'b',
    });

    expect(result.isError).toBeFalsy();
    expect(saveProxy).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'socks5', auth: true, username: 'a', password: 'b', default: false }),
      null
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain('"b"');
  });

  it('createProxy refuses an unknown protocol', async () => {
    const result = await call('createProxy', { protocol: 'ftp', host: 'x', port: 21 });

    expect(result.isError).toBe(true);
    expect(saveProxy).not.toHaveBeenCalled();
  });

  it('updateProxy keeps the stored fields and a "***" password', async () => {
    await call('updateProxy', { proxyID: 1, port: 8080, password: '***' });

    expect(saveProxy).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'proxy.lan', port: 8080, auth: true, username: 'u', password: 'stored-pw' }),
      1
    );
  });

  it('updateProxy with username "" stops sending a login', async () => {
    await call('updateProxy', { proxyID: 1, username: '' });

    expect(saveProxy).toHaveBeenCalledWith(expect.objectContaining({ auth: false, username: '', password: '' }), 1);
  });

  it('updateProxy reports a missing proxy', async () => {
    const result = await call('updateProxy', { proxyID: 9, port: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Proxy 9 not found.*listProxies/);
  });

  it('listRemoteBrowsers hides the token in the URL', async () => {
    const result = await call('listRemoteBrowsers', {});

    expect(result.structuredContent.remoteBrowsers[0].url).toBe('ws://browserless:3000?token=***');
  });

  it('testRemoteBrowser checks a saved one by its stored URL, and needs exactly one of url and ID', async () => {
    await call('testRemoteBrowser', { remoteBrowserID: 5 });
    expect(testRemoteBrowser).toHaveBeenCalledWith('ws://browserless:3000?token=secret');

    expect((await call('testRemoteBrowser', {})).isError).toBe(true);
    expect((await call('testRemoteBrowser', { url: 'ws://a', remoteBrowserID: 5 })).isError).toBe(true);
    expect((await call('testRemoteBrowser', { url: 'http://not-websocket' })).isError).toBe(true);
  });

  it('updateRemoteBrowser keeps the stored URL, and refuses a redacted one', async () => {
    await call('updateRemoteBrowser', { remoteBrowserID: 5, name: 'chrome' });
    expect(saveRemoteBrowser).toHaveBeenCalledWith({ name: 'chrome', url: 'ws://browserless:3000?token=secret' }, 5);

    const refused = await call('updateRemoteBrowser', { remoteBrowserID: 5, url: 'ws://browserless:3000?token=***' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/redaction marker/);
    expect(saveRemoteBrowser).toHaveBeenCalledTimes(1);
  });

  it('createAPIKey returns the key once, and sends a normalized expiry', async () => {
    const result = await call('createAPIKey', { name: 'grafana', expires: '2027-01-31' });

    expect(addAPIKey).toHaveBeenCalledWith({ name: 'grafana', active: true, expires: '2027-01-31 23:59:59' });
    expect(result.structuredContent).toMatchObject({ keyID: 7, key: 'uk7_abcdef' });
    expect(result.content[0].text).toContain('uk7_abcdef');
  });

  it('createAPIKey without expires never expires', async () => {
    await call('createAPIKey', { name: 'prom' });

    expect(addAPIKey).toHaveBeenCalledWith({ name: 'prom', active: true, expires: null });
  });

  it('setAPIKeyActive and deleteAPIKey report a key that does not exist', async () => {
    for (const [name, args] of [
      ['setAPIKeyActive', { keyID: 99, active: false }],
      ['deleteAPIKey', { keyID: 99 }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/API key 99 not found.*listAPIKeys/);
    }
    expect(setAPIKeyActive).not.toHaveBeenCalled();

    await call('setAPIKeyActive', { keyID: 4, active: false });
    expect(setAPIKeyActive).toHaveBeenCalledWith(4, false);
  });

  it('annotates testRemoteBrowser as changing nothing, and keeps it out of read-only mode', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.find((t) => t.name === 'testRemoteBrowser')?.annotations).toMatchObject({ readOnlyHint: true });

    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
      readOnly: true,
    });
    const roClient = new Client({ name: 'ro', version: '1.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), roClient.connect(ct)]);
    const names = (await roClient.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['listProxies', 'listRemoteBrowsers', 'listAPIKeys']));
    expect(names).not.toContain('testRemoteBrowser');
    expect(names).not.toContain('createAPIKey');
  });
});
