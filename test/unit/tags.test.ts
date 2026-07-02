import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket, injectTagListCache } from './helpers.js';

describe('UptimeKumaClient - Tag Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('getTagList', () => {
    it('returns empty array when no tags cached', () => {
      expect(client.getTagList()).toEqual([]);
    });

    it('returns cached tags', () => {
      const tags = [
        { id: 1, name: 'env', color: '#ff0000' },
        { id: 2, name: 'region', color: '#00ff00' },
      ];
      injectTagListCache(client, tags);
      expect(client.getTagList()).toEqual(tags);
    });
  });

  describe('addTag', () => {
    it('emits addTag and resolves with created tag', async () => {
      const { socket } = createMockSocket({
        addTag: (tagData, callback) => {
          expect(tagData).toEqual({ name: 'priority', color: '#ff0000' });
          (callback as (res: unknown) => void)({ ok: true, tag: { id: 5, name: 'priority', color: '#ff0000' } });
        },
      });
      injectSocket(client, socket);

      const result = await client.addTag('priority', '#ff0000');
      expect(result.ok).toBe(true);
      expect(result.tag?.id).toBe(5);
      expect(result.tag?.name).toBe('priority');
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        addTag: (_tagData, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Tag already exists' });
        },
      });
      injectSocket(client, socket);

      await expect(client.addTag('dup', '#000')).rejects.toThrow('Tag already exists');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.addTag('x', '#000')).rejects.toThrow('Not connected to server');
    });
  });

  describe('deleteTag', () => {
    it('emits deleteTag and resolves on success', async () => {
      const { socket } = createMockSocket({
        deleteTag: (id, callback) => {
          expect(id).toBe(3);
          (callback as (res: unknown) => void)({ ok: true, msg: 'Deleted' });
        },
      });
      injectSocket(client, socket);

      const result = await client.deleteTag(3);
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        deleteTag: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Tag not found' });
        },
      });
      injectSocket(client, socket);

      await expect(client.deleteTag(999)).rejects.toThrow('Tag not found');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.deleteTag(1)).rejects.toThrow('Not connected to server');
    });
  });
});
