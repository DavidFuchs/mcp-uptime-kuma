import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { parseFields, pickFields, wantsField } from '../../src/tools/fields.js';

/**
 * The `fields` argument: a caller that needs a few fields of a wide record gets only those,
 * plus id, and pays for nothing else in its context.
 */
describe('parseFields and pickFields', () => {
  it('returns no selection when fields is missing or names nothing', () => {
    expect(parseFields(undefined)).toBeUndefined();
    expect(parseFields(' , ')).toBeUndefined();
  });

  it('always adds id, and ignores spaces and empty names', () => {
    expect([...parseFields(' name, ,url ')!]).toEqual(['id', 'name', 'url']);
  });

  it('matches field names case-insensitively', () => {
    const selection = parseFields('RetryInterval,ACCEPTED_STATUSCODES');
    expect(pickFields({ id: 1, retryInterval: 60, accepted_statuscodes: ['200-299'], name: 'x' }, selection)).toEqual({
      id: 1,
      retryInterval: 60,
      accepted_statuscodes: ['200-299'],
    });
    expect(wantsField(selection, 'retryinterval')).toBe(true);
  });

  it('returns the record itself when there is no selection', () => {
    const record = { id: 1, name: 'x' };
    expect(pickFields(record, undefined)).toBe(record);
    expect(wantsField(undefined, 'anything')).toBe(true);
  });
});

describe('read tools with fields', () => {
  const MONITOR = {
    id: 7,
    name: 'shop',
    type: 'http',
    url: 'https://shop.example.com',
    interval: 60,
    retryInterval: 60,
    active: true,
    maxretries: 0,
  };

  async function connect() {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'result-fields-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('getMonitor returns only the named fields and id, reading type-specific ones on its own', async () => {
    const getMonitor = vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({ ...MONITOR } as never);
    const client = await connect();
    const result = await call(client, 'getMonitor', { monitorID: 7, fields: 'name,url' });

    expect(result.isError).toBeFalsy();
    expect(getMonitor).toHaveBeenCalledWith(7, true);
    expect(result.structuredContent).toEqual({ monitor: { id: 7, name: 'shop', url: 'https://shop.example.com' } });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      id: 7,
      name: 'shop',
      url: 'https://shop.example.com',
    });
  });

  it('getMonitor without fields still returns every field', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({ ...MONITOR } as never);
    const client = await connect();
    const result = await call(client, 'getMonitor', { monitorID: 7 });
    expect(result.structuredContent).toEqual({ monitor: MONITOR });
  });

  it('listMonitors returns only the named fields of each monitor, with the count', async () => {
    const getMonitorList = vi
      .spyOn(UptimeKumaClient.prototype, 'getMonitorList')
      .mockReturnValue({ '7': { ...MONITOR }, '8': { ...MONITOR, id: 8, name: 'blog', url: undefined } } as never);
    const client = await connect();
    const result = await call(client, 'listMonitors', { fields: 'name,url' });

    expect(result.isError).toBeFalsy();
    expect(getMonitorList).toHaveBeenCalledWith(expect.objectContaining({ includeTypeSpecificFields: true }));
    expect(result.structuredContent).toEqual({
      monitors: [
        { id: 7, name: 'shop', url: 'https://shop.example.com' },
        { id: 8, name: 'blog' },
      ],
      count: 2,
      total: 2,
    });
  });

  it('listMonitors redacts credentials before picking fields', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitorList').mockReturnValue({
      '7': { ...MONITOR, basic_auth_pass: 'hunter2' },
    } as never);
    const client = await connect();
    const result = await call(client, 'listMonitors', { fields: 'basic_auth_pass' });
    expect(result.structuredContent).toEqual({ monitors: [{ id: 7, basic_auth_pass: '***' }], count: 1, total: 1 });
  });

  it('listMaintenanceWindows skips the per-window lookups it was not asked for', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMaintenanceList').mockReturnValue([
      { id: 4, title: 'Weekly restart', strategy: 'manual', active: true },
    ] as never);
    const getMonitorMaintenance = vi
      .spyOn(UptimeKumaClient.prototype, 'getMonitorMaintenance')
      .mockResolvedValue([7] as never);
    const getMaintenanceStatusPages = vi
      .spyOn(UptimeKumaClient.prototype, 'getMaintenanceStatusPages')
      .mockResolvedValue([] as never);
    const client = await connect();

    const titles = await call(client, 'listMaintenanceWindows', { fields: 'title' });
    expect(titles.structuredContent).toEqual({
      maintenanceWindows: [{ id: 4, title: 'Weekly restart' }],
      count: 1,
      total: 1,
    });
    expect(getMonitorMaintenance).not.toHaveBeenCalled();
    expect(getMaintenanceStatusPages).not.toHaveBeenCalled();

    const monitors = await call(client, 'listMaintenanceWindows', { fields: 'monitorIDs' });
    expect(monitors.structuredContent).toEqual({
      maintenanceWindows: [{ id: 4, monitorIDs: [7] }],
      count: 1,
      total: 1,
    });
    expect(getMaintenanceStatusPages).not.toHaveBeenCalled();
  });
});
