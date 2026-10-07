import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Maintenance tools, server side: what is sent to Uptime Kuma, and whether an acknowledged
 * write that did not land is reported as a failure.
 *
 * Uptime Kuma's Maintenance.jsonToBean() reads every field unconditionally, so the payload
 * tests pin the defaults that keep it from throwing or writing NULL.
 */

// See verify-monitor-write.test.ts — createServer() adds signal listeners per instance.
process.setMaxListeners(50);

const STORED_WINDOW = {
  id: 4,
  title: 'Weekly restart',
  description: 'router',
  strategy: 'recurring-weekday',
  active: true,
  intervalDay: 1,
  dateRange: ['2026-07-26T11:32', '2045-07-26T12:32'],
  timeRange: [{ hours: 4, minutes: 30, seconds: 0 }, { hours: 6, minutes: 30, seconds: 0 }],
  weekdays: [3],
  daysOfMonth: [],
  timezone: 'America/New_York',
  timezoneOption: null,
};

async function connectServer() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });

  const client = new Client({ name: 'maintenance-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const textOf = (result: CallToolResult) =>
  (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';

describe('maintenance tools', () => {
  let createMaintenance: ReturnType<typeof vi.spyOn>;
  let editMaintenance: ReturnType<typeof vi.spyOn>;
  let fetchMaintenance: ReturnType<typeof vi.spyOn>;
  let setMonitorMaintenance: ReturnType<typeof vi.spyOn>;
  let getMonitorMaintenance: ReturnType<typeof vi.spyOn>;
  let refreshMaintenanceList: ReturnType<typeof vi.spyOn>;
  let deleteMaintenance: ReturnType<typeof vi.spyOn>;
  let pauseMaintenance: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);

    createMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'createMaintenance')
      .mockResolvedValue({ ok: true, msg: 'successAdded', maintenanceID: 4 } as never);
    editMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'editMaintenance')
      .mockResolvedValue({ ok: true, msg: 'Saved.', maintenanceID: 4 } as never);
    fetchMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'fetchMaintenance')
      .mockResolvedValue({ ...STORED_WINDOW } as never);
    setMonitorMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'setMonitorMaintenance')
      .mockResolvedValue({ ok: true } as never);
    getMonitorMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'getMonitorMaintenance')
      .mockResolvedValue([] as never);
    refreshMaintenanceList = vi.spyOn(UptimeKumaClient.prototype, 'refreshMaintenanceList')
      .mockResolvedValue([{ ...STORED_WINDOW }] as never);
    deleteMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'deleteMaintenance')
      .mockResolvedValue({ ok: true, msg: 'successDeleted' } as never);
    pauseMaintenance = vi.spyOn(UptimeKumaClient.prototype, 'pauseMaintenance')
      .mockResolvedValue({ ok: true, msg: 'successPaused' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createMaintenance', () => {
    it('sends active, dateRange and timezoneOption, which jsonToBean needs and the old tool left out', async () => {
      fetchMaintenance.mockResolvedValue({ id: 4, title: 'Diun', strategy: 'manual', active: true, timezoneOption: 'UTC' } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMaintenance',
        arguments: { title: 'Diun', strategy: 'manual', timezone: 'UTC' },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(createMaintenance).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Diun',
        strategy: 'manual',
        active: true,
        dateRange: [],
        weekdays: [],
        daysOfMonth: [],
        timezoneOption: 'UTC',
      }));
      expect(createMaintenance.mock.calls[0][0]).not.toHaveProperty('timezone');
    });

    it('attaches monitorIDs and reports them', async () => {
      fetchMaintenance.mockResolvedValue({ id: 4, title: 'Diun', strategy: 'manual', active: true } as never);
      getMonitorMaintenance.mockResolvedValue([3, 9] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMaintenance',
        arguments: { title: 'Diun', strategy: 'manual', monitorIDs: [9, 3, 9] },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(setMonitorMaintenance).toHaveBeenCalledWith(4, [3, 9]);
      expect(result.structuredContent).toMatchObject({ maintenanceID: 4, monitorIDs: [3, 9] });
    });

    it('says a window without monitors suppresses nothing', async () => {
      fetchMaintenance.mockResolvedValue({ id: 4, title: 'Diun', strategy: 'manual', active: true } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMaintenance',
        arguments: { title: 'Diun', strategy: 'manual' },
      }) as CallToolResult;

      expect(setMonitorMaintenance).not.toHaveBeenCalled();
      expect(textOf(result)).toMatch(/suppresses nothing/);
    });

    it('fails the call, keeping the ID, when the monitor list does not persist', async () => {
      fetchMaintenance.mockResolvedValue({ id: 4, title: 'Diun', strategy: 'manual', active: true } as never);
      getMonitorMaintenance.mockResolvedValue([3] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMaintenance',
        arguments: { title: 'Diun', strategy: 'manual', monitorIDs: [3, 9] },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/covers \[3\] rather than the requested \[3, 9\]/);
      expect(textOf(result)).toMatch(/EXISTS — do not create it again/);
      expect(result.structuredContent).toMatchObject({ maintenanceID: 4 });
    });

    it.each([
      [{ title: 'x', strategy: 'single' }, /single maintenance window needs dateRange/],
      [{ title: 'x', strategy: 'recurring-weekday', weekdays: [1] }, /needs timeRange/],
      [{ title: 'x', strategy: 'recurring-weekday', timeRange: [{ hours: 1, minutes: 0 }, { hours: 2, minutes: 0 }] }, /needs at least one entry in weekdays/],
      [{ title: 'x', strategy: 'recurring-interval', timeRange: [{ hours: 1, minutes: 0 }, { hours: 2, minutes: 0 }] }, /needs intervalDay/],
    ])('refuses an incomplete schedule before calling Uptime Kuma: %j', async (args, message) => {
      const { client } = await connectServer();

      const result = await client.callTool({ name: 'createMaintenance', arguments: args }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(message);
      expect(createMaintenance).not.toHaveBeenCalled();
    });
  });

  describe('updateMaintenance', () => {
    it('merges the change into the full stored window, keeping the stored timezone choice', async () => {
      fetchMaintenance
        .mockResolvedValueOnce({ ...STORED_WINDOW } as never)
        .mockResolvedValueOnce({ ...STORED_WINDOW, title: 'Renamed' } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMaintenance',
        arguments: { maintenanceID: 4, title: 'Renamed' },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const sent = editMaintenance.mock.calls[0][0] as Record<string, unknown>;
      expect(sent).toMatchObject({
        id: 4,
        title: 'Renamed',
        description: 'router',
        strategy: 'recurring-weekday',
        active: true,
        weekdays: [3],
        dateRange: STORED_WINDOW.dateRange,
        timeRange: STORED_WINDOW.timeRange,
        // null, not the resolved "America/New_York" — the window keeps following the server.
        timezoneOption: null,
      });
      expect(setMonitorMaintenance).not.toHaveBeenCalled();
    });

    it('fails the call when a field is acknowledged but not stored', async () => {
      // "Saved.", but the row still has the old title.
      fetchMaintenance.mockResolvedValue({ ...STORED_WINDOW } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMaintenance',
        arguments: { maintenanceID: 4, title: 'Renamed' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/title: asked for "Renamed", server reports "Weekly restart"/);
    });

    it('replaces only the monitor list when that is all that is passed', async () => {
      getMonitorMaintenance.mockResolvedValue([] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMaintenance',
        arguments: { maintenanceID: 4, monitorIDs: [] },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(editMaintenance).not.toHaveBeenCalled();
      expect(setMonitorMaintenance).toHaveBeenCalledWith(4, []);
    });

    it('reports a missing window as not found instead of a raw server error', async () => {
      refreshMaintenanceList.mockResolvedValue([] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMaintenance',
        arguments: { maintenanceID: 99, title: 'x' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Maintenance window 99 not found/);
      expect(editMaintenance).not.toHaveBeenCalled();
    });

    it('refuses a call with nothing to change', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMaintenance',
        arguments: { maintenanceID: 4 },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Nothing to update/);
    });
  });

  describe('pauseMaintenance / resumeMaintenance', () => {
    it('fails the call when the window is still active after a pause', async () => {
      fetchMaintenance.mockResolvedValue({ ...STORED_WINDOW, active: true } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'pauseMaintenance',
        arguments: { maintenanceID: 4 },
      }) as CallToolResult;

      expect(pauseMaintenance).toHaveBeenCalledWith(4);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/active: asked for false, server reports true/);
    });

    it('confirms a pause that landed', async () => {
      fetchMaintenance.mockResolvedValue({ ...STORED_WINDOW, active: false } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'pauseMaintenance',
        arguments: { maintenanceID: 4 },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ maintenanceID: 4, active: false });
    });
  });

  describe('deleteMaintenance', () => {
    it('reports a missing window as not found — Uptime Kuma itself answers ok: true', async () => {
      refreshMaintenanceList.mockResolvedValue([] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'deleteMaintenance',
        arguments: { maintenanceID: 99 },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not found/);
      expect(deleteMaintenance).not.toHaveBeenCalled();
    });

    it('fails the call when the window is still listed afterwards', async () => {
      refreshMaintenanceList.mockResolvedValue([{ ...STORED_WINDOW }] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'deleteMaintenance',
        arguments: { maintenanceID: 4 },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/still listed/);
    });

    it('confirms a delete that landed', async () => {
      refreshMaintenanceList
        .mockResolvedValueOnce([{ ...STORED_WINDOW }] as never)
        .mockResolvedValueOnce([] as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'deleteMaintenance',
        arguments: { maintenanceID: 4 },
      }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(deleteMaintenance).toHaveBeenCalledWith(4);
    });
  });

  describe('getMaintenanceWindows', () => {
    it('includes the monitors each window covers', async () => {
      vi.spyOn(UptimeKumaClient.prototype, 'getMaintenanceList').mockReturnValue([{ ...STORED_WINDOW }] as never);
      getMonitorMaintenance.mockResolvedValue([3, 9] as never);
      const { client } = await connectServer();

      const result = await client.callTool({ name: 'getMaintenanceWindows', arguments: {} }) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { maintenanceWindows: unknown[] }).maintenanceWindows[0])
        .toMatchObject({ id: 4, monitorIDs: [3, 9] });
    });
  });
});
