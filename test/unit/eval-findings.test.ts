import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Issues found by the LLM agent-usability eval (test/llm/).
 *
 * - listNotifications returned `type` only inside `config`, and `config` as a JSON string.
 * - Push and group monitors were stored with timeout 0, where the web form stores 48. Next to
 *   the "avoid 0" timeout description, that led a model to "fix" the push monitor's timeout.
 * - The push URL was always built from the address this server connects with, where Uptime
 *   Kuma's own UI uses the Primary Base URL when one is set.
 */

async function connectServer(url = 'http://localhost:3001') {
  const { server } = await createServer({
    url,
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });
  const client = new Client({ name: 'eval-findings-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// A row as Uptime Kuma sends it in notificationList: no type column, config is a JSON string.
const WEBHOOK_ROW = {
  id: 28,
  name: 'Ops hook',
  active: true,
  userId: 1,
  isDefault: false,
  config: JSON.stringify({
    name: 'Ops hook',
    type: 'webhook',
    webhookURL: 'https://example.com/hook',
    webhookContentType: 'json',
    applyExisting: false,
  }),
};

describe('eval findings', () => {
  let settings: Record<string, unknown>;
  let lastWrite: Record<string, unknown>;

  beforeEach(() => {
    settings = {};
    lastWrite = {};
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockImplementation((async () => ({
      ok: true,
      data: { ...settings },
    })) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getNotificationList').mockReturnValue([{ ...WEBHOOK_ROW }] as never);
    vi.spyOn(UptimeKumaClient.prototype, 'createMonitor').mockImplementation((async (data: Record<string, unknown>) => {
      lastWrite = data;
      return { ok: true, msg: 'Added Successfully.', monitorID: 7 };
    }) as never);
    vi.spyOn(UptimeKumaClient.prototype, 'fetchMonitor').mockImplementation((async () => ({
      id: 7,
      ...lastWrite,
    })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listNotifications', () => {
    for (const includeSecrets of [false, true]) {
      it(`returns type at the top level and config as an object (includeSecrets: ${includeSecrets})`, async () => {
        const client = await connectServer();
        const result = (await client.callTool({ name: 'listNotifications', arguments: { includeSecrets } })) as any;
        const [n] = result.structuredContent.notifications;
        expect(n.type).toBe('webhook');
        expect(typeof n.config).toBe('object');
        expect(n.config.type).toBe('webhook');
        expect(JSON.parse(result.content[0].text)[0].type).toBe('webhook');
      });
    }

    it('still withholds credentials from the config object by default', async () => {
      const client = await connectServer();
      const result = (await client.callTool({ name: 'listNotifications', arguments: {} })) as any;
      const [n] = result.structuredContent.notifications;
      expect(n.config.webhookURL).toBeUndefined();
      expect(n.redactedConfigKeys).toEqual(expect.arrayContaining(['webhookURL', 'webhookContentType']));
      expect(result.content[0].text).not.toContain('example.com/hook');
    });

    it('returns secrets in the config object when asked', async () => {
      const client = await connectServer();
      const result = (await client.callTool({ name: 'listNotifications', arguments: { includeSecrets: true } })) as any;
      expect(result.structuredContent.notifications[0].config.webhookURL).toBe('https://example.com/hook');
    });
  });

  describe('createMonitor timeout default for push and group', () => {
    for (const type of ['push', 'group']) {
      it(`stores the web form's 48 second timeout for a ${type} monitor`, async () => {
        const client = await connectServer();
        const result = (await client.callTool({ name: 'createMonitor', arguments: { name: 'New', type } })) as any;
        expect(result.isError).toBeFalsy();
        expect(lastWrite.timeout).toBe(48);
      });
    }

    it('keeps a timeout the caller passed for a push monitor', async () => {
      const client = await connectServer();
      await client.callTool({ name: 'createMonitor', arguments: { name: 'New', type: 'push', timeout: 20 } });
      expect(lastWrite.timeout).toBe(20);
    });
  });

  describe('push URL', () => {
    it('uses the Primary Base URL when one is set', async () => {
      settings = { primaryBaseURL: 'https://status.example.com/' };
      const client = await connectServer('http://10.0.0.5:3001');
      const result = (await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'New', type: 'push', pushToken: 'token-0123456789' },
      })) as any;
      expect(result.structuredContent.pushURL).toBe(
        'https://status.example.com/api/push/token-0123456789?status=up&msg=OK&ping='
      );
    });

    it('falls back to the connection URL and says so when no Primary Base URL is set', async () => {
      const client = await connectServer('http://10.0.0.5:3001');
      const result = (await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'New', type: 'push', pushToken: 'token-0123456789' },
      })) as any;
      expect(result.structuredContent.pushURL).toBe(
        'http://10.0.0.5:3001/api/push/token-0123456789?status=up&msg=OK&ping='
      );
      expect(result.content[0].text).toMatch(/no Primary Base URL is set/i);
    });
  });

  describe('radius station IDs', () => {
    // Found by the LLM eval: Uptime Kuma sends both station IDs in every request, and its RADIUS
    // library fails to encode one that is unset ("Cannot have nested attributes when using hash
    // syntax"), so the monitor failed every check. The web form requires both.
    const base = {
      name: 'New',
      type: 'radius',
      hostname: 'radius.example.com',
      radiusPassword: 'p',
      typeFields: { radiusUsername: 'u', radiusSecret: 's' },
    };

    it('refuses a radius monitor without the station IDs', async () => {
      const client = await connectServer();
      const result = (await client.callTool({ name: 'createMonitor', arguments: base })) as any;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('radiusCalledStationId');
      expect(JSON.stringify(result.content)).toContain('radiusCallingStationId');
    });

    it('creates one with both', async () => {
      const client = await connectServer();
      const result = (await client.callTool({
        name: 'createMonitor',
        arguments: {
          ...base,
          typeFields: { ...base.typeFields, radiusCalledStationId: 'AA:corp', radiusCallingStationId: 'BB' },
        },
      })) as any;
      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ radiusCalledStationId: 'AA:corp', radiusCallingStationId: 'BB' });
    });
  });
});
