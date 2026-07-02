import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket } from './helpers.js';

describe('UptimeKumaClient - Status Page Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('createStatusPage', () => {
    it('emits addStatusPage with title and slug', async () => {
      const { socket } = createMockSocket({
        addStatusPage: (title, slug, callback) => {
          expect(title).toBe('My Status');
          expect(slug).toBe('my-status');
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);

      const result = await client.createStatusPage('My Status', 'my-status');
      expect(result.ok).toBe(true);
    });

    it('rejects on failure response', async () => {
      const { socket } = createMockSocket({
        addStatusPage: (_title, _slug, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Slug already exists' });
        },
      });
      injectSocket(client, socket);

      await expect(client.createStatusPage('Dup', 'dup')).rejects.toThrow('Slug already exists');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.createStatusPage('x', 'x')).rejects.toThrow('Not connected to server');
    });
  });

  describe('updateStatusPage', () => {
    it('emits saveStatusPage with slug, config, imgDataUrl, and publicGroupList', async () => {
      const { socket } = createMockSocket({
        saveStatusPage: (slug, config, imgDataUrl, publicGroupList, callback) => {
          expect(slug).toBe('test-page');
          expect(config).toEqual({ title: 'Updated' });
          expect(imgDataUrl).toBe('');
          expect(publicGroupList).toEqual([{ name: 'Services', weight: 1, monitorList: [{ id: 1 }] }]);
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);

      const result = await client.updateStatusPage(
        'test-page',
        { title: 'Updated' },
        [{ name: 'Services', weight: 1, monitorList: [{ id: 1 }] }]
      );
      expect(result.ok).toBe(true);
    });

    it('uses defaults for optional parameters', async () => {
      const { socket } = createMockSocket({
        saveStatusPage: (_slug, _config, imgDataUrl, publicGroupList, callback) => {
          expect(imgDataUrl).toBe('');
          expect(publicGroupList).toEqual([]);
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);

      const result = await client.updateStatusPage('slug', { title: 'T' });
      expect(result.ok).toBe(true);
    });

    it('rejects on failure response', async () => {
      const { socket } = createMockSocket({
        saveStatusPage: (_slug, _config, _img, _groups, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Not found' });
        },
      });
      injectSocket(client, socket);

      await expect(client.updateStatusPage('bad', {})).rejects.toThrow('Not found');
    });
  });

  describe('deleteStatusPage', () => {
    it('emits deleteStatusPage with slug and resolves on success', async () => {
      const { socket } = createMockSocket({
        deleteStatusPage: (slug, callback) => {
          expect(slug).toBe('old-page');
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);

      const result = await client.deleteStatusPage('old-page');
      expect(result.ok).toBe(true);
    });

    it('rejects on failure', async () => {
      const { socket } = createMockSocket({
        deleteStatusPage: (_slug, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Cannot delete' });
        },
      });
      injectSocket(client, socket);

      await expect(client.deleteStatusPage('x')).rejects.toThrow('Cannot delete');
    });
  });

  describe('getStatusPage', () => {
    it('fetches from public API and returns structured data', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          config: { id: 1, slug: 'test', title: 'Test Page' },
          publicGroupList: [{ name: 'Group 1', monitorList: [{ id: 1 }] }],
          incidents: [],
        }),
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await client.getStatusPage('test');
      expect(result.ok).toBe(true);
      expect(result.config?.slug).toBe('test');
      expect(result.publicGroupList).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3001/api/status-page/test');

      fetchSpy.mockRestore();
    });

    it('returns ok:false for 404', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      const result = await client.getStatusPage('nonexistent');
      expect(result.ok).toBe(false);
      expect(result.msg).toContain('not found');

      fetchSpy.mockRestore();
    });

    it('throws for non-404 HTTP errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as Response);

      await expect(client.getStatusPage('broken')).rejects.toThrow('Failed to get status page broken');

      fetchSpy.mockRestore();
    });

    it('encodes slug in URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          config: { slug: 'my-page' },
          publicGroupList: [],
        }),
      } as unknown as Response);

      await client.getStatusPage('my page');
      expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3001/api/status-page/my%20page');

      fetchSpy.mockRestore();
    });
  });
});
