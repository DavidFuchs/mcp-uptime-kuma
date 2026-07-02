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
});
