import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Found by the LLM eval (status-page-groups): Uptime Kuma's saveStatusPage replaces every field
 * from the config it is given and every group from the list it is given. So updateStatusPage
 * passed straight through either failed ("Slug must be string", "Invalid analytics type",
 * "Invalid array") or blanked what the caller left out — and an omitted publicGroupList deleted
 * every group on the page. Agents needed up to 7 attempts to update a page.
 */

// What Uptime Kuma's authenticated getStatusPage returns (StatusPage.toJSON()).
const STORED = {
  id: 3,
  slug: 'acme',
  title: 'Acme Status',
  description: 'All of Acme',
  icon: '/upload/logo3.png?t=1',
  theme: 'dark',
  autoRefreshInterval: 300,
  published: true,
  showTags: true,
  domainNameList: ['status.acme.test'],
  customCSS: 'body{}',
  footerText: 'Acme Inc',
  showPoweredBy: false,
  analyticsId: null,
  analyticsScriptUrl: null,
  analyticsType: null,
  showCertificateExpiry: false,
  showOnlyLastHeartbeat: false,
  rssTitle: null,
};

// What the public /api/status-page/{slug} returns for its groups.
const GROUPS = [
  { id: 11, name: 'Core', weight: 1, monitorList: [{ id: 5, name: 'Web', sendUrl: 0 }, { id: 6, name: 'API', url: 'https://api.acme.test' }] },
  { id: 12, name: 'Edge', weight: 2, monitorList: [] },
];

async function connectServer() {
  const { server } = await createServer({ url: 'http://localhost:3001', username: undefined, password: undefined, token: undefined, jwtToken: undefined });
  const client = new Client({ name: 'status-page-update-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('updateStatusPage merges onto the stored page', () => {
  let save: ReturnType<typeof vi.spyOn>;
  let sent: { slug?: string; config?: any; groups?: any[]; img?: string };

  const update = async (args: Record<string, unknown>) => {
    const client = await connectServer();
    return client.callTool({ name: 'updateStatusPage', arguments: { slug: 'acme', ...args } }) as Promise<any>;
  };

  beforeEach(() => {
    sent = {};
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getStatusPageConfig').mockResolvedValue({ ...STORED } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getStatusPage').mockResolvedValue({ ok: true, config: { ...STORED }, publicGroupList: structuredClone(GROUPS), incidents: [] } as never);
    save = vi.spyOn(UptimeKumaClient.prototype, 'updateStatusPage').mockImplementation((async (slug: string, config: any, groups: any[], img: string) => {
      sent = { slug, config, groups, img };
      return { ok: true };
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a config with only a description keeps every other stored field', async () => {
    const result = await update({ config: { description: 'Live service health' } });
    expect(result.isError).toBeFalsy();
    expect(sent.config).toMatchObject({
      slug: 'acme',
      title: 'Acme Status',
      description: 'Live service health',
      theme: 'dark',
      published: true,
      showTags: true,
      domainNameList: ['status.acme.test'],
      customCSS: 'body{}',
      footerText: 'Acme Inc',
      showPoweredBy: false,
      analyticsType: null,
    });
  });

  it('keeps the stored icon, passed as the logo field Uptime Kuma reads', async () => {
    await update({ config: { description: 'x' } });
    expect(sent.config.logo).toBe('/upload/logo3.png?t=1');
  });

  it('an icon in config becomes the logo', async () => {
    await update({ config: { icon: '/icon.svg' } });
    expect(sent.config.logo).toBe('/icon.svg');
  });

  it('always sends the slug inside config, so Uptime Kuma accepts it', async () => {
    await update({ config: { title: 'New title' } });
    expect(sent.config.slug).toBe('acme');
  });

  for (const value of [undefined, '', null]) {
    it(`sends analyticsType ${JSON.stringify(value)} as null`, async () => {
      vi.spyOn(UptimeKumaClient.prototype, 'getStatusPageConfig').mockResolvedValue({ ...STORED, analyticsType: undefined } as never);
      await update({ config: value === undefined ? { title: 'T' } : { analyticsType: value } });
      expect(sent.config.analyticsType).toBeNull();
    });
  }

  it('sends domainNameList as an array even when the stored page has none', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getStatusPageConfig').mockResolvedValue({ ...STORED, domainNameList: undefined } as never);
    await update({ config: { title: 'T' } });
    expect(sent.config.domainNameList).toEqual([]);
  });

  it('keeps the current groups and their monitors when publicGroupList is omitted', async () => {
    await update({ config: { description: 'x' } });
    expect(sent.groups).toEqual([
      { id: 11, name: 'Core', monitorList: [{ id: 5, sendUrl: 0 }, { id: 6, url: 'https://api.acme.test' }] },
      { id: 12, name: 'Edge', monitorList: [] },
    ]);
  });

  it('replaces the groups when publicGroupList is given, defaulting monitorList to []', async () => {
    await update({ config: {}, publicGroupList: [{ name: 'Core', monitorList: [{ id: 5 }] }, { name: 'Empty' }] });
    expect(sent.groups).toEqual([{ name: 'Core', monitorList: [{ id: 5 }] }, { name: 'Empty', monitorList: [] }]);
  });

  it('config may be omitted when only the groups change', async () => {
    const result = await update({ publicGroupList: [{ name: 'Core', monitorList: [{ id: 6 }] }] });
    expect(result.isError).toBeFalsy();
    expect(sent.config).toMatchObject({ slug: 'acme', title: 'Acme Status' });
  });

  it('refuses rather than wiping the groups when they cannot be read back', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getStatusPage').mockRejectedValue(new Error('HTTP 500') as never);
    const result = await update({ config: { description: 'x' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('publicGroupList');
    expect(save).not.toHaveBeenCalled();
  });

  it('says clearly when the page does not exist', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getStatusPageConfig').mockRejectedValue(new Error('No slug?') as never);
    const result = await update({ config: { description: 'x' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/acme/);
    expect(save).not.toHaveBeenCalled();
  });
});
