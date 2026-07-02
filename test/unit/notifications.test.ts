import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket, injectNotificationListCache } from './helpers.js';

describe('UptimeKumaClient - Notification Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('getNotificationList', () => {
    it('returns empty array when no notifications cached', () => {
      expect(client.getNotificationList()).toEqual([]);
    });

    it('returns cached notifications as an array', () => {
      injectNotificationListCache(client, {
        '1': { id: 1, name: 'Slack', type: 'slack', active: true },
        '2': { id: 2, name: 'Email', type: 'smtp', active: false },
      });

      const result = client.getNotificationList();
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ id: 1, name: 'Slack', type: 'slack', active: true });
      expect(result).toContainEqual({ id: 2, name: 'Email', type: 'smtp', active: false });
    });
  });

  describe('addNotification', () => {
    it('emits addNotification with null id for new notifications', async () => {
      const { socket } = createMockSocket({
        addNotification: (notification, id, callback) => {
          expect(id).toBeNull();
          expect(notification).toEqual({ name: 'Discord', type: 'discord', webhookURL: 'http://hook' });
          (callback as (res: unknown) => void)({ ok: true, id: 10 });
        },
      });
      injectSocket(client, socket);

      const result = await client.addNotification({ name: 'Discord', type: 'discord', webhookURL: 'http://hook' });
      expect(result.ok).toBe(true);
      expect(result.id).toBe(10);
    });

    it('emits addNotification with id for updates', async () => {
      const { socket } = createMockSocket({
        addNotification: (notification, id, callback) => {
          expect(id).toBe(5);
          (callback as (res: unknown) => void)({ ok: true, id: 5 });
        },
      });
      injectSocket(client, socket);

      const result = await client.addNotification({ name: 'Updated', type: 'slack' }, 5);
      expect(result.ok).toBe(true);
      expect(result.id).toBe(5);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        addNotification: (_notification, _id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Invalid config' });
        },
      });
      injectSocket(client, socket);

      await expect(
        client.addNotification({ name: 'Bad', type: 'unknown' })
      ).rejects.toThrow('Invalid config');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(
        client.addNotification({ name: 'x', type: 'slack' })
      ).rejects.toThrow('Not connected to server');
    });
  });

  describe('deleteNotification', () => {
    it('emits deleteNotification and resolves on success', async () => {
      const { socket } = createMockSocket({
        deleteNotification: (id, callback) => {
          expect(id).toBe(7);
          (callback as (res: unknown) => void)({ ok: true, msg: 'Deleted' });
        },
      });
      injectSocket(client, socket);

      const result = await client.deleteNotification(7);
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        deleteNotification: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Not found' });
        },
      });
      injectSocket(client, socket);

      await expect(client.deleteNotification(999)).rejects.toThrow('Not found');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.deleteNotification(1)).rejects.toThrow('Not connected to server');
    });
  });
});
