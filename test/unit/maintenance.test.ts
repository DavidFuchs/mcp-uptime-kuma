import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket, injectMaintenanceListCache } from './helpers.js';

describe('UptimeKumaClient - Maintenance Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('getMaintenanceList', () => {
    it('returns empty array when no maintenance windows cached', () => {
      expect(client.getMaintenanceList()).toEqual([]);
    });

    it('returns cached maintenance windows as an array', () => {
      injectMaintenanceListCache(client, {
        '1': { id: 1, title: 'Weekly Restart', active: true, strategy: 'recurring-weekday' },
        '2': { id: 2, title: 'DB Migration', active: false, strategy: 'single' },
      });

      const result = client.getMaintenanceList();
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ id: 1, title: 'Weekly Restart', active: true, strategy: 'recurring-weekday' });
    });
  });

  describe('createMaintenance', () => {
    it('emits addMaintenance and resolves with maintenanceID', async () => {
      const { socket } = createMockSocket({
        addMaintenance: (data, callback) => {
          expect(data).toEqual({ title: 'Deploy Window', strategy: 'single', active: true });
          (callback as (res: unknown) => void)({ ok: true, maintenanceID: 15 });
        },
      });
      injectSocket(client, socket);

      const result = await client.createMaintenance({ title: 'Deploy Window', strategy: 'single', active: true });
      expect(result.ok).toBe(true);
      expect(result.maintenanceID).toBe(15);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        addMaintenance: (_data, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Invalid schedule' });
        },
      });
      injectSocket(client, socket);

      await expect(
        client.createMaintenance({ title: 'Bad', strategy: 'invalid' })
      ).rejects.toThrow('Invalid schedule');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(
        client.createMaintenance({ title: 'x', strategy: 'single' })
      ).rejects.toThrow('Not connected to server');
    });
  });

  describe('editMaintenance', () => {
    it('emits editMaintenance with the full object', async () => {
      const { socket } = createMockSocket({
        editMaintenance: (data, callback) => {
          expect(data).toEqual({ id: 4, title: 'Renamed', strategy: 'manual', active: true, dateRange: [] });
          (callback as (res: unknown) => void)({ ok: true, msg: 'Saved.', maintenanceID: 4 });
        },
      });
      injectSocket(client, socket);

      const result = await client.editMaintenance({ id: 4, title: 'Renamed', strategy: 'manual', active: true, dateRange: [] });
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        editMaintenance: (_data, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Invalid start date' });
        },
      });
      injectSocket(client, socket);

      await expect(client.editMaintenance({ id: 4 })).rejects.toThrow('Invalid start date');
    });
  });

  describe('fetchMaintenance', () => {
    it('emits getMaintenance and resolves with the stored window', async () => {
      const { socket } = createMockSocket({
        getMaintenance: (id, callback) => {
          expect(id).toBe(4);
          (callback as (res: unknown) => void)({ ok: true, maintenance: { id: 4, title: 'Stored' } });
        },
      });
      injectSocket(client, socket);

      expect(await client.fetchMaintenance(4)).toEqual({ id: 4, title: 'Stored' });
    });

    it('rejects when the server cannot find it', async () => {
      const { socket } = createMockSocket({
        getMaintenance: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: "Cannot read properties of null (reading 'toJSON')" });
        },
      });
      injectSocket(client, socket);

      await expect(client.fetchMaintenance(99)).rejects.toThrow('toJSON');
    });

    it('times out instead of hanging when the acknowledgement never arrives', async () => {
      vi.useFakeTimers();
      try {
        const { socket } = createMockSocket({ getMaintenance: () => {} });
        injectSocket(client, socket);

        const pending = client.fetchMaintenance(4);
        const assertion = expect(pending).rejects.toThrow('Timed out');
        await vi.advanceTimersByTimeAsync(10_001);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.fetchMaintenance(4)).rejects.toThrow('Not connected to server');
    });
  });

  describe('getMonitorMaintenance / setMonitorMaintenance', () => {
    it('reads the monitor IDs a window covers', async () => {
      const { socket } = createMockSocket({
        getMonitorMaintenance: (id, callback) => {
          expect(id).toBe(4);
          (callback as (res: unknown) => void)({ ok: true, monitors: [{ id: 3 }, { id: 9 }] });
        },
      });
      injectSocket(client, socket);

      expect(await client.getMonitorMaintenance(4)).toEqual([3, 9]);
    });

    it('sends monitors as [{id}], the shape addMonitorMaintenance reads', async () => {
      const { socket } = createMockSocket({
        addMonitorMaintenance: (id, monitors, callback) => {
          expect(id).toBe(4);
          expect(monitors).toEqual([{ id: 3 }, { id: 9 }]);
          (callback as (res: unknown) => void)({ ok: true, msg: 'successAdded' });
        },
      });
      injectSocket(client, socket);

      expect((await client.setMonitorMaintenance(4, [3, 9])).ok).toBe(true);
    });

    it('rejects when the server refuses the monitor list', async () => {
      const { socket } = createMockSocket({
        addMonitorMaintenance: (_id, _monitors, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'FOREIGN KEY constraint failed' });
        },
      });
      injectSocket(client, socket);

      await expect(client.setMonitorMaintenance(4, [999])).rejects.toThrow('FOREIGN KEY');
    });
  });

  describe.each([
    ['pauseMaintenance', (c: UptimeKumaClient) => c.pauseMaintenance(4)],
    ['resumeMaintenance', (c: UptimeKumaClient) => c.resumeMaintenance(4)],
    ['deleteMaintenance', (c: UptimeKumaClient) => c.deleteMaintenance(4)],
  ] as const)('%s', (event, call) => {
    it(`emits ${event} with the ID`, async () => {
      const { socket } = createMockSocket({
        [event]: (id, callback) => {
          expect(id).toBe(4);
          (callback as (res: unknown) => void)({ ok: true, msg: 'ok' });
        },
      });
      injectSocket(client, socket);

      expect((await call(client)).ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        [event]: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Permission denied' });
        },
      });
      injectSocket(client, socket);

      await expect(call(client)).rejects.toThrow('Permission denied');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(call(client)).rejects.toThrow('Not connected to server');
    });
  });

  describe('refreshMaintenanceList', () => {
    it('re-requests the list and returns the refreshed cache', async () => {
      const { socket } = createMockSocket({
        getMaintenanceList: (callback) => {
          // Kuma pushes maintenanceList before acknowledging.
          injectMaintenanceListCache(client, { '2': { id: 2, title: 'Fresh' } });
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);
      injectMaintenanceListCache(client, { '1': { id: 1, title: 'Stale' } });

      expect(await client.refreshMaintenanceList()).toEqual([{ id: 2, title: 'Fresh' }]);
    });
  });
});
