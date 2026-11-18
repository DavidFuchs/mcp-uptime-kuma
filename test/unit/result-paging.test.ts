import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { DEFAULT_PAGE_LIMIT, pageById, pageNote } from '../../src/tools/paging.js';

/**
 * Paging: listMonitors and listMaintenanceWindows return 50 records by default, with the total
 * and a cursor for the next page, so a large instance does not fill the model's context.
 */
const records = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe('pageById', () => {
  it('returns the first page in ID order, with the total and a cursor', () => {
    const shuffled = [{ id: 3 }, { id: 1 }, { id: 2 }];
    expect(pageById(shuffled, 2, undefined)).toEqual({ page: [{ id: 1 }, { id: 2 }], total: 3, nextCursor: '2' });
  });

  it('continues after the cursor and leaves the cursor out on the last page', () => {
    expect(pageById(records(3), 2, '2')).toEqual({ page: [{ id: 3 }], total: 3 });
  });

  it('has no cursor when the page holds exactly what is left', () => {
    expect(pageById(records(2), 2, undefined).nextCursor).toBeUndefined();
  });

  it('defaults to 50', () => {
    const { page, nextCursor } = pageById(records(DEFAULT_PAGE_LIMIT + 1), undefined, undefined);
    expect(page).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(nextCursor).toBe(String(DEFAULT_PAGE_LIMIT));
  });

  it('neither skips nor repeats a record when one before the cursor is deleted between calls', () => {
    const first = pageById(records(4), 2, undefined);
    const afterDelete = records(4).filter((r) => r.id !== 1);
    expect(pageById(afterDelete, 2, first.nextCursor).page).toEqual([{ id: 3 }, { id: 4 }]);
  });

  it('rejects a cursor that is not an ID', () => {
    expect(() => pageById(records(3), 2, 'abc')).toThrow(/Invalid cursor "abc"/);
    expect(() => pageById(records(3), 2, ' ')).toThrow(/Invalid cursor/);
  });

  it('says how to get the next page, and nothing on the last one', () => {
    expect(pageNote('monitors', pageById(records(3), 2, undefined))).toBe(
      'Showing 2 of 3 monitors. For the next page, call again with cursor "2".'
    );
    expect(pageNote('monitors', pageById(records(3), 5, undefined))).toBeUndefined();
  });
});

describe('paged list tools', () => {
  async function connect() {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'result-paging-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const texts = (result: CallToolResult) => (result.content as Array<{ text: string }>).map((c) => c.text);

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  const monitor = (id: number) => ({ id, name: `m${id}`, type: 'http', interval: 60, retryInterval: 60 });

  it('listMonitors returns one page with the total, and tells a text-only client how to go on', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitorList').mockReturnValue(
      Object.fromEntries([1, 2, 3].map((id) => [String(id), monitor(id)])) as never
    );
    const client = await connect();

    const first = await call(client, 'listMonitors', { limit: 2, fields: 'name' });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual({
      monitors: [
        { id: 1, name: 'm1' },
        { id: 2, name: 'm2' },
      ],
      count: 2,
      total: 3,
      nextCursor: '2',
    });
    expect(texts(first)[1]).toBe('Showing 2 of 3 monitors. For the next page, call again with cursor "2".');

    const second = await call(client, 'listMonitors', { limit: 2, cursor: '2', fields: 'name' });
    expect(second.structuredContent).toEqual({ monitors: [{ id: 3, name: 'm3' }], count: 1, total: 3 });
    expect(texts(second)).toHaveLength(1);
  });

  it('listMonitors reports a bad cursor as an error', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitorList').mockReturnValue({ '1': monitor(1) } as never);
    const client = await connect();
    const result = await call(client, 'listMonitors', { cursor: 'next' });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toMatch(/Invalid cursor "next"/);
  });

  describe('listMaintenanceWindows', () => {
    const WINDOWS = [
      { id: 1, title: 'old', strategy: 'single', active: true, status: 'ended' },
      { id: 2, title: 'next week', strategy: 'single', active: true, status: 'scheduled' },
      { id: 3, title: 'now', strategy: 'manual', active: true, status: 'under-maintenance' },
    ];
    let getMonitorMaintenance: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.spyOn(UptimeKumaClient.prototype, 'getMaintenanceList').mockReturnValue(
        WINDOWS.map((w) => ({ ...w })) as never
      );
      getMonitorMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'getMonitorMaintenance').mockResolvedValue([]);
      vi.spyOn(UptimeKumaClient.prototype, 'getMaintenanceStatusPages').mockResolvedValue([]);
    });

    it('filters by status, in any case, before paging', async () => {
      const client = await connect();
      const result = await call(client, 'listMaintenanceWindows', {
        status: 'Scheduled, UNDER-MAINTENANCE',
        fields: 'title,status',
        limit: 1,
      });
      expect(result.structuredContent).toEqual({
        maintenanceWindows: [{ id: 2, title: 'next week', status: 'scheduled' }],
        count: 1,
        total: 2,
        nextCursor: '2',
      });
    });

    it('filters by keywords in the title, all of them, in any case', async () => {
      const client = await connect();
      const result = await call(client, 'listMaintenanceWindows', { keywords: 'WEEK next', fields: 'title' });
      expect(result.structuredContent).toEqual({
        maintenanceWindows: [{ id: 2, title: 'next week' }],
        count: 1,
        total: 1,
      });
    });

    it('looks up monitors only for the windows on the page', async () => {
      const client = await connect();
      await call(client, 'listMaintenanceWindows', { limit: 1 });
      expect(getMonitorMaintenance).toHaveBeenCalledTimes(1);
      expect(getMonitorMaintenance).toHaveBeenCalledWith(1);
    });

    it('rejects a status Uptime Kuma does not have, naming the valid ones', async () => {
      const client = await connect();
      const result = await call(client, 'listMaintenanceWindows', { status: 'active' });
      expect(result.isError).toBe(true);
      expect(texts(result).join(' ')).toMatch(
        /Unrecognised status "active"\. Use inactive, scheduled, under-maintenance, ended, unknown/
      );
    });
  });
});
