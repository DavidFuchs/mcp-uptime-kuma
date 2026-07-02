import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket, injectStatusPageListCache } from './helpers.js';

describe('UptimeKumaClient - Settings Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('getSettings', () => {
    it('emits getSettings and resolves with filtered data (no steamAPIKey)', async () => {
      const { socket } = createMockSocket({
        getSettings: (callback) => {
          (callback as (res: unknown) => void)({
            ok: true,
            data: {
              checkUpdate: true,
              primaryBaseURL: 'http://localhost:3001',
              steamAPIKey: 'SECRET_KEY_SHOULD_BE_REMOVED',
            },
          });
        },
      });
      injectSocket(client, socket);

      const result = await client.getSettings();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect((result.data as any).primaryBaseURL).toBe('http://localhost:3001');
      expect((result.data as any).steamAPIKey).toBeUndefined();
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        getSettings: (callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Permission denied' });
        },
      });
      injectSocket(client, socket);

      await expect(client.getSettings()).rejects.toThrow('Permission denied');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.getSettings()).rejects.toThrow('Not connected to server');
    });
  });

  describe('getStatusPageList', () => {
    it('returns empty array when no status pages cached', () => {
      expect(client.getStatusPageList()).toEqual([]);
    });

    it('returns cached status pages as an array', () => {
      injectStatusPageListCache(client, {
        'main': { id: 1, slug: 'main', title: 'Main Status' },
        'internal': { id: 2, slug: 'internal', title: 'Internal Status' },
      });

      const result = client.getStatusPageList();
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ id: 1, slug: 'main', title: 'Main Status' });
      expect(result).toContainEqual({ id: 2, slug: 'internal', title: 'Internal Status' });
    });
  });
});
