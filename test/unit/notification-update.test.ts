import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Uptime Kuma's Notification.save() replaces the row from what it is sent: the name, the
 * default flag, and the whole config (JSON.stringify of the object, provider type included).
 * updateNotification passed only the caller's fields through, so renaming a channel, or
 * toggling isDefault, erased its type and every provider setting.
 */

// A row as Uptime Kuma pushes it in notificationList: config is a JSON string that repeats
// name / type / isDefault alongside the provider settings.
const STORED_CONFIG = {
  name: 'Ops mail',
  type: 'smtp',
  isDefault: true,
  applyExisting: false,
  smtpHost: 'smtp.acme.test',
  smtpPort: 587,
  smtpUsername: 'ops',
  smtpPassword: 'hunter2',
};
const STORED_ROW = {
  id: 7,
  name: 'Ops mail',
  active: true,
  userId: 1,
  isDefault: true,
  config: JSON.stringify(STORED_CONFIG),
};

async function connectServer() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });
  const client = new Client({ name: 'notification-update-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('updateNotification merges onto the stored channel', () => {
  let save: ReturnType<typeof vi.spyOn>;

  const update = async (args: Record<string, unknown>) => {
    const client = await connectServer();
    return client.callTool({ name: 'updateNotification', arguments: { notificationID: 7, ...args } }) as Promise<any>;
  };
  const sent = () => save.mock.calls[0]![0] as Record<string, unknown>;

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getNotificationList').mockReturnValue([{ ...STORED_ROW }] as never);
    save = vi
      .spyOn(UptimeKumaClient.prototype, 'addNotification')
      .mockResolvedValue({ ok: true, id: 7, msg: 'Saved.' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a rename keeps the type, the default flag and every provider setting', async () => {
    const result = await update({ name: 'Ops mail (primary)' });

    expect(result.isError).toBeFalsy();
    expect(save.mock.calls[0]![1]).toBe(7);
    expect(sent()).toEqual({ ...STORED_CONFIG, name: 'Ops mail (primary)' });
  });

  it('toggling isDefault keeps the name and the config', async () => {
    await update({ isDefault: false });

    expect(sent()).toEqual({ ...STORED_CONFIG, isDefault: false });
  });

  it('config changes one setting and keeps the others', async () => {
    await update({ config: { smtpPort: 465 } });

    expect(sent()).toEqual({ ...STORED_CONFIG, smtpPort: 465 });
  });

  it('applyExisting is not carried over from the stored row, and is sent when asked for', async () => {
    await update({ name: 'x' });
    expect(sent().applyExisting).toBe(false);

    save.mockClear();
    await update({ applyExisting: true });
    expect(sent()).toEqual({ ...STORED_CONFIG, applyExisting: true });
  });

  it('changing the type drops the old provider settings rather than mixing two providers', async () => {
    await update({ type: 'ntfy', config: { ntfytopic: 'ops', ntfyserverurl: 'https://ntfy.sh' } });

    expect(sent()).toEqual({
      name: 'Ops mail',
      type: 'ntfy',
      isDefault: true,
      applyExisting: false,
      ntfytopic: 'ops',
      ntfyserverurl: 'https://ntfy.sh',
    });
  });

  it('passing the type the channel already has is not a type change', async () => {
    await update({ type: 'smtp', name: 'renamed' });

    expect(sent()).toEqual({ ...STORED_CONFIG, name: 'renamed' });
  });

  it('still restores a secret sent back as the redaction marker', async () => {
    const result = await update({ config: { smtpPassword: '***', smtpPort: 465 } });

    expect(sent()).toEqual({ ...STORED_CONFIG, smtpPort: 465 });
    expect(result.content[0].text).toContain('Kept the existing value for smtpPassword');
  });

  it('refuses an id that is not a known channel instead of writing a bare row', async () => {
    const result = await update({ notificationID: 99, name: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('listNotifications');
    expect(save).not.toHaveBeenCalled();
  });

  it('reads a stored config that is already an object', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getNotificationList').mockReturnValue([
      { ...STORED_ROW, config: { ...STORED_CONFIG } },
    ] as never);

    await update({ name: 'renamed' });

    expect(sent()).toEqual({ ...STORED_CONFIG, name: 'renamed' });
  });
});
