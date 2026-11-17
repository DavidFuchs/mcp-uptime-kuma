import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket } from './helpers.js';

describe('UptimeKumaClient.setSettings', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('emits setSettings with the data and no current password', async () => {
    const { socket } = createMockSocket({
      setSettings: (data, currentPassword, callback) => {
        expect(data).toEqual({ serverTimezone: 'UTC' });
        expect(currentPassword).toBeNull();
        (callback as (res: unknown) => void)({ ok: true, msg: 'Saved.', msgi18n: true });
      },
    });
    injectSocket(client, socket);

    const result = await client.setSettings({ serverTimezone: 'UTC' });
    expect(result.ok).toBe(true);
  });

  it('rejects when the server returns not ok', async () => {
    const { socket } = createMockSocket({
      setSettings: (_data, _pw, callback) => {
        (callback as (res: unknown) => void)({ ok: false, msg: 'Incorrect current password' });
      },
    });
    injectSocket(client, socket);

    await expect(client.setSettings({})).rejects.toThrow('Incorrect current password');
  });

  it('rejects when not connected', async () => {
    injectSocket(client, createDisconnectedSocket());
    await expect(client.setSettings({})).rejects.toThrow('Not connected to server');
  });
});

/**
 * Uptime Kuma's setSettings handler reads an absent nscd, entryPage, chromeExecutable or
 * disableAuth as a change, so the tool sends the whole stored object with the caller's changes
 * merged in, and the UI's defaults for anything never saved.
 */
describe('updateSettings tool', () => {
  let stored: Record<string, unknown>;
  let save: ReturnType<typeof vi.spyOn>;

  const connect = async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'settings-update-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };
  const update = async (args: Record<string, unknown>) =>
    (await connect()).callTool({ name: 'updateSettings', arguments: args }) as Promise<any>;

  beforeEach(() => {
    stored = {
      serverTimezone: 'UTC',
      entryPage: 'statusPage-main',
      nscd: false,
      disableAuth: true,
      apiEnabled: false,
      prometheusApiEnabled: false,
      chromeExecutable: '/usr/bin/chromium',
      keepDataPeriodDays: 90,
      tlsExpiryNotifyDays: [7, 14, 21],
    };
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockImplementation((async () => ({
      ok: true,
      data: { ...stored },
    })) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getStatusPageList').mockReturnValue([
      { id: 1, slug: 'main', title: 'Main' },
    ] as never);
    save = vi.spyOn(UptimeKumaClient.prototype, 'setSettings').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      stored = { ...data };
      return { ok: true, msg: 'Saved.' };
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('changes one setting and sends every stored one back unchanged', async () => {
    const result = await update({ keepDataPeriodDays: 30 });

    expect(result.isError).toBeFalsy();
    const sent = save.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      keepDataPeriodDays: 30,
      serverTimezone: 'UTC',
      entryPage: 'statusPage-main',
      nscd: false,
      disableAuth: true,
      chromeExecutable: '/usr/bin/chromium',
    });
    expect(result.structuredContent.changed).toEqual(['keepDataPeriodDays']);
    expect(result.structuredContent.settings.keepDataPeriodDays).toBe(30);
  });

  it('fills settings never saved with the web UI defaults', async () => {
    stored = { serverTimezone: 'UTC' };
    await update({ checkUpdate: false });

    expect(save.mock.calls[0][0]).toMatchObject({
      checkUpdate: false,
      entryPage: 'dashboard',
      nscd: true,
      prometheusApiEnabled: false,
      apiEnabled: false,
    });
  });

  it('does not save when nothing would change', async () => {
    const result = await update({ serverTimezone: 'UTC' });

    expect(result.isError).toBeFalsy();
    expect(save).not.toHaveBeenCalled();
    expect(result.structuredContent.changed).toEqual([]);
  });

  it('refuses a call with no settings', async () => {
    const result = await update({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to change/);
    expect(save).not.toHaveBeenCalled();
  });

  it('sorts and de-duplicates expiry warning days', async () => {
    await update({ tlsExpiryNotifyDays: [21, 7, 7, 1] });

    expect(save.mock.calls[0][0]).toMatchObject({ tlsExpiryNotifyDays: [1, 7, 21] });
  });

  it.each([
    [{ serverTimezone: 'Mars/Olympus' }, /timezone/i],
    [{ primaryBaseURL: 'status.example.com' }, /http/],
    [{ keepDataPeriodDays: -1 }, /keepDataPeriodDays|>=|greater/i],
    [{ tlsExpiryNotifyDays: [] }, /tlsExpiryNotifyDays|least/i],
    [{ entryPage: 'statusPage-nope' }, /listStatusPages/],
    [{ entryPage: 'settings' }, /dashboard/],
  ])('refuses %o', async (args, message) => {
    const result = await update(args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(message);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['chromeExecutable', '/usr/bin/google-chrome'],
    ['apiEnabled', true],
    ['prometheusApiEnabled', true],
    ['steamAPIKey', 'NEWKEY'],
    ['globalpingApiToken', 'NEWTOKEN'],
  ])('sets %s', async (key, value) => {
    const result = await update({ [key]: value });

    expect(result.isError).toBeFalsy();
    expect(save.mock.calls[0][0]).toMatchObject({ [key]: value });
    expect(result.structuredContent.changed).toEqual([key]);
  });

  it('keeps a stored credential when "***" is sent back, and never writes it from the copy', async () => {
    stored.globalpingApiToken = 'STORED';
    const kept = await update({ globalpingApiToken: '***' });

    expect(kept.isError).toBeFalsy();
    expect(save).not.toHaveBeenCalled();

    await update({ checkUpdate: false });
    expect(save.mock.calls[0][0]).not.toHaveProperty('globalpingApiToken');
  });

  it('does not report a returned credential in the text unless includeSecrets is set', async () => {
    const result = await update({ steamAPIKey: 'NEWKEY' });

    expect(result.content[0].text).not.toContain('NEWKEY');
  });

  describe('disableAuth', () => {
    beforeEach(() => {
      stored.disableAuth = false;
    });

    it('refuses to turn login off without currentPassword', async () => {
      const result = await update({ disableAuth: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/currentPassword/);
      expect(save).not.toHaveBeenCalled();
    });

    it('turns login off with currentPassword and passes it to Uptime Kuma', async () => {
      const result = await update({ disableAuth: true, currentPassword: 'hunter2' });

      expect(result.isError).toBeFalsy();
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ disableAuth: true }), 'hunter2');
      expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('turns login back on without a password', async () => {
      stored.disableAuth = true;
      const result = await update({ disableAuth: false });

      expect(result.isError).toBeFalsy();
      expect(save.mock.calls[0][0]).toMatchObject({ disableAuth: false });
    });
  });

  it('returns settings keys it does not declare', async () => {
    stored.someFutureSetting = 'x';
    const result = await update({ checkUpdate: false });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.settings.someFutureSetting).toBe('x');
  });

  it('accepts an empty primaryBaseURL to clear it', async () => {
    stored.primaryBaseURL = 'https://old.example.com';
    const result = await update({ primaryBaseURL: '' });

    expect(result.isError).toBeFalsy();
    expect(save.mock.calls[0][0]).toMatchObject({ primaryBaseURL: '' });
  });

  it('redacts credentials in the returned settings', async () => {
    stored.globalpingApiToken = 'SECRET';
    const result = await update({ checkUpdate: false });

    expect(result.content[0].text).not.toContain('SECRET');
    expect(JSON.stringify(result.structuredContent)).not.toContain('SECRET');
  });
});
