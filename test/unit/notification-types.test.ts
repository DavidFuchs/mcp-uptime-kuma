import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { NOTIFICATION_TYPES, NOTIFICATION_TYPE_FIELDS } from '../../src/notifications/types.js';

/**
 * Uptime Kuma stores a notification's config as given and each provider reads its own property
 * names off it at send time, so a wrong type or field name saves a channel that never sends.
 * listNotificationTypes and getNotificationTypeFields give the names; createNotification refuses
 * the mistakes it can recognise.
 */

async function connect(readOnly = false) {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
    readOnly,
  });
  const client = new Client({ name: 'notification-types-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await connect()).callTool({ name, arguments: args }) as Promise<any>;

describe('notification type tables', () => {
  it('has no duplicate types, and none that differ only by case', () => {
    const names = NOTIFICATION_TYPES.map((t) => t.type);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('documents fields only for types that exist, each with a required field and a description', () => {
    const known = new Set(NOTIFICATION_TYPES.map((t) => t.type));
    for (const [type, fields] of Object.entries(NOTIFICATION_TYPE_FIELDS)) {
      expect(known.has(type), type).toBe(true);
      expect(fields.required.length, type).toBeGreaterThan(0);
      const all = [...fields.required, ...fields.optional];
      expect(new Set(all.map((f) => f.name)).size, type).toBe(all.length);
      for (const field of all) expect(field.description, `${type}.${field.name}`).not.toBe('');
    }
  });
});

describe('listNotificationTypes', () => {
  it('lists every type with its exact spelling and whether its fields are documented', async () => {
    const result = await call('listNotificationTypes');
    const { types, count } = result.structuredContent;

    expect(count).toBe(NOTIFICATION_TYPES.length);
    expect(types).toContainEqual({ type: 'slack', name: 'Slack', fieldsDocumented: true });
    expect(types).toContainEqual({ type: 'PagerDuty', name: 'PagerDuty', fieldsDocumented: true });
    expect(types).toContainEqual({ type: 'twilio', name: 'Twilio', fieldsDocumented: false });
  });
});

describe('getNotificationTypeFields', () => {
  it('returns only the fields of the type asked for', async () => {
    const { structuredContent } = await call('getNotificationTypeFields', { type: 'slack' });

    expect(structuredContent.documented).toBe(true);
    expect(structuredContent.required.map((f: any) => f.name)).toEqual(['slackwebhookURL']);
    const names = [...structuredContent.required, ...structuredContent.optional].map((f: any) => f.name);
    expect(names).toContain('slackchannel');
    expect(names.some((n: string) => n.startsWith('ntfy') || n.startsWith('smtp'))).toBe(false);
    expect(structuredContent.commonFields).toEqual(['name', 'isDefault', 'applyExisting']);
  });

  it('says so when a type exists but its fields are not documented', async () => {
    const { structuredContent, isError } = await call('getNotificationTypeFields', { type: 'twilio' });

    expect(isError).toBeFalsy();
    expect(structuredContent.documented).toBe(false);
    expect(structuredContent.required).toEqual([]);
    expect(structuredContent.notes.join(' ')).toContain('listNotifications');
  });

  it('refuses an unknown type, and offers the right spelling for a wrong case', async () => {
    const unknown = await call('getNotificationTypeFields', { type: 'carrier-pigeon' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('listNotificationTypes');

    const miscased = await call('getNotificationTypeFields', { type: 'pagerduty' });
    expect(miscased.isError).toBe(true);
    expect(miscased.content[0].text).toContain("did you mean 'PagerDuty'");
  });

  it('is not offered in read-only mode, like the write tools it serves', async () => {
    const names = (await (await connect(true)).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('listNotificationTypes');
    expect(names).not.toContain('getNotificationTypeFields');
    expect(names).toContain('listNotifications');
  });
});

describe('createNotification checks what it can recognise', () => {
  let save: ReturnType<typeof vi.spyOn>;
  const create = (args: Record<string, unknown>) => call('createNotification', { name: 'n', ...args });

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    save = vi
      .spyOn(UptimeKumaClient.prototype, 'addNotification')
      .mockResolvedValue({ ok: true, id: 3, msg: 'Saved.' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a channel that has the required fields of its type', async () => {
    const result = await create({ type: 'slack', config: { slackwebhookURL: 'https://hooks.slack.test/x' } });

    expect(result.isError).toBeFalsy();
    expect(save.mock.calls[0]![0]).toMatchObject({ type: 'slack', slackwebhookURL: 'https://hooks.slack.test/x' });
  });

  it('refuses a channel missing a required field, and names it', async () => {
    const result = await create({ type: 'ntfy', config: { ntfyserverurl: 'https://ntfy.sh' } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ntfytopic');
    expect(result.content[0].text).toContain('getNotificationTypeFields');
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a field name in the wrong case and gives the right one', async () => {
    const result = await create({ type: 'slack', config: { slackWebhookUrl: 'https://hooks.slack.test/x' } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'slackwebhookURL' for 'slackWebhookUrl'");
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a type in the wrong case and gives the right one', async () => {
    const result = await create({ type: 'Slack', config: { slackwebhookURL: 'https://hooks.slack.test/x' } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Did you mean 'slack'");
    expect(save).not.toHaveBeenCalled();
  });

  it('lets through a type it has no field table for, and a type it has never heard of', async () => {
    expect((await create({ type: 'twilio', config: { anything: 1 } })).isError).toBeFalsy();
    expect((await create({ type: 'brand-new-provider', config: { anything: 1 } })).isError).toBeFalsy();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('lets fields it does not know through for a documented type', async () => {
    const result = await create({
      type: 'webhook',
      config: { webhookURL: 'https://example.test/hook', somethingNewer: true },
    });

    expect(result.isError).toBeFalsy();
    expect(save.mock.calls[0]![0]).toMatchObject({ somethingNewer: true });
  });
});

describe('updateNotification applies the same checks to what a call changes', () => {
  let save: ReturnType<typeof vi.spyOn>;
  const stored = (config: Record<string, unknown>) =>
    vi
      .spyOn(UptimeKumaClient.prototype, 'getNotificationList')
      .mockReturnValue([
        { id: 7, name: 'n', isDefault: false, config: JSON.stringify({ name: 'n', ...config }) },
      ] as never);
  const update = (args: Record<string, unknown>) => call('updateNotification', { notificationID: 7, ...args });

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    save = vi
      .spyOn(UptimeKumaClient.prototype, 'addNotification')
      .mockResolvedValue({ ok: true, id: 7, msg: 'Saved.' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a change of type that lacks the new type’s required fields', async () => {
    stored({ type: 'smtp', smtpHost: 'h', smtpFrom: 'a@b.test' });

    const result = await update({ type: 'ntfy', config: { ntfytopic: 'ops' } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ntfyserverurl');
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a misspelled field passed in this call', async () => {
    stored({ type: 'slack', slackwebhookURL: 'https://hooks.slack.test/x' });

    const result = await update({ config: { slackChannel: '#ops' } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'slackchannel' for 'slackChannel'");
  });

  it('still renames a channel stored without its required fields', async () => {
    stored({ type: 'slack', webhookURL: 'https://hooks.slack.test/x' });

    const result = await update({ name: 'renamed' });

    expect(result.isError).toBeFalsy();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
