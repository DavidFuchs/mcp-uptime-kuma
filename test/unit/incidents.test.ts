import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, injectSocket } from './helpers.js';

const incident = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Incident ${id}`,
  content: `Body ${id}`,
  style: 'warning',
  pin: true,
  active: true,
  createdDate: '2026-11-16 10:00:00',
  lastUpdatedDate: null,
  status_page_id: 1,
  ...extra,
});

describe('UptimeKumaClient incident calls', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('postIncident emits the slug and the incident, and resolves with the saved one', async () => {
    const { socket } = createMockSocket({
      postIncident: (slug, body, callback) => {
        expect(slug).toBe('main');
        expect(body).toEqual({ title: 'API down', content: 'Looking into it', style: 'danger' });
        (callback as (res: unknown) => void)({ ok: true, incident: incident(5) });
      },
    });
    injectSocket(client, socket);

    const result = await client.postIncident('main', {
      title: 'API down',
      content: 'Looking into it',
      style: 'danger',
    });
    expect(result.incident?.id).toBe(5);
  });

  it('getIncidentHistory sends null for the first page', async () => {
    const { socket } = createMockSocket({
      getIncidentHistory: (slug, cursor, callback) => {
        expect([slug, cursor]).toEqual(['main', null]);
        (callback as (res: unknown) => void)({ ok: true, incidents: [], total: 0, nextCursor: null, hasMore: false });
      },
    });
    injectSocket(client, socket);

    await expect(client.getIncidentHistory('main')).resolves.toMatchObject({ ok: true, total: 0 });
  });

  it('editIncident, resolveIncident and deleteIncident pass the slug and ID', async () => {
    const seen: unknown[][] = [];
    const answer = (callback: unknown) => (callback as (res: unknown) => void)({ ok: true, incident: incident(5) });
    const { socket } = createMockSocket({
      editIncident: (slug, id, body, callback) => {
        seen.push(['edit', slug, id, body]);
        answer(callback);
      },
      resolveIncident: (slug, id, callback) => {
        seen.push(['resolve', slug, id]);
        answer(callback);
      },
      deleteIncident: (slug, id, callback) => {
        seen.push(['delete', slug, id]);
        answer(callback);
      },
    });
    injectSocket(client, socket);

    await client.editIncident('main', 5, { title: 't', content: 'c', style: 'info', pin: false });
    await client.resolveIncident('main', 5);
    await client.deleteIncident('main', 5);
    expect(seen).toEqual([
      ['edit', 'main', 5, { title: 't', content: 'c', style: 'info', pin: false }],
      ['resolve', 'main', 5],
      ['delete', 'main', 5],
    ]);
  });

  it("rejects with Uptime Kuma's message", async () => {
    const { socket } = createMockSocket({
      resolveIncident: (_slug, _id, callback) => {
        (callback as (res: unknown) => void)({ ok: false, msg: 'Incident not found or access denied' });
      },
    });
    injectSocket(client, socket);

    await expect(client.resolveIncident('main', 99)).rejects.toThrow('Incident not found or access denied');
  });
});

describe('incident tools', () => {
  let history: ReturnType<typeof vi.spyOn>;
  let post: ReturnType<typeof vi.spyOn>;
  let edit: ReturnType<typeof vi.spyOn>;

  const call = async (name: string, args: Record<string, unknown>) => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'incidents-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client.callTool({ name, arguments: args }) as Promise<any>;
  };

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    // Two pages: 10 newest, then incident 1 alone.
    history = vi.spyOn(UptimeKumaClient.prototype, 'getIncidentHistory').mockImplementation((async (
      _slug: string,
      cursor?: string | null
    ) =>
      cursor
        ? {
            ok: true,
            incidents: [incident(1, { style: 'info', pin: false })],
            total: 11,
            nextCursor: null,
            hasMore: false,
          }
        : {
            ok: true,
            incidents: Array.from({ length: 10 }, (_, i) => incident(11 - i)),
            total: 11,
            nextCursor: '2026-11-15 00:00:00',
            hasMore: true,
          }) as never);
    post = vi.spyOn(UptimeKumaClient.prototype, 'postIncident').mockImplementation((async (
      _slug: string,
      body: Record<string, unknown>
    ) => ({
      ok: true,
      incident: { ...incident(12), ...body },
    })) as never);
    edit = vi.spyOn(UptimeKumaClient.prototype, 'editIncident').mockImplementation((async (
      _slug: string,
      id: number,
      body: Record<string, unknown>
    ) => ({
      ok: true,
      msg: 'Saved.',
      incident: { ...incident(id), ...body },
    })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listIncidents returns one page and the cursor for the next', async () => {
    const result = await call('listIncidents', { slug: 'main' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 11, hasMore: true, nextCursor: '2026-11-15 00:00:00' });
    expect(result.structuredContent.incidents).toHaveLength(10);
  });

  it('createIncident defaults the style to primary, as the web UI does', async () => {
    const result = await call('createIncident', { slug: 'main', title: 'API degraded', content: 'Investigating' });

    expect(result.isError).toBeFalsy();
    expect(post).toHaveBeenCalledWith('main', { title: 'API degraded', content: 'Investigating', style: 'primary' });
  });

  it.each([
    [{ slug: 'main', title: '  ', content: 'x' }],
    [{ slug: 'main', title: 'x', content: '' }],
    [{ slug: 'main', title: 'x', content: 'y', style: 'red' }],
  ])('createIncident refuses %o', async (args) => {
    const result = await call('createIncident', args);

    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it('updateIncident keeps the fields it is not given, found on a later history page', async () => {
    const result = await call('updateIncident', { slug: 'main', incidentID: 1, title: 'Fixed title' });

    expect(result.isError).toBeFalsy();
    expect(history).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledWith('main', 1, {
      title: 'Fixed title',
      content: 'Body 1',
      style: 'info',
      pin: false,
    });
  });

  it('updateIncident pinned: false takes the banner down without resolving it', async () => {
    await call('updateIncident', { slug: 'main', incidentID: 11, pinned: false });

    expect(edit).toHaveBeenCalledWith('main', 11, expect.objectContaining({ pin: false, title: 'Incident 11' }));
  });

  it('updateIncident refuses a call that changes nothing', async () => {
    const result = await call('updateIncident', { slug: 'main', incidentID: 11 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to change/);
    expect(history).not.toHaveBeenCalled();
  });

  it('updateIncident reports an incident that is not on the page', async () => {
    const result = await call('updateIncident', { slug: 'main', incidentID: 99, title: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Incident 99 not found.*listIncidents/);
    expect(edit).not.toHaveBeenCalled();
  });

  it('turns Uptime Kuma\'s "slug is not found" into a pointer to listStatusPages', async () => {
    history.mockRejectedValue(new Error('slug is not found'));
    const result = await call('listIncidents', { slug: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No status page with slug "nope".*listStatusPages/);
  });
});
