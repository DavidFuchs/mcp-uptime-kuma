import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket, injectDockerHostListCache } from './helpers.js';

describe('UptimeKumaClient - Docker Host Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('getDockerHostList', () => {
    it('returns empty array when no docker hosts cached', () => {
      expect(client.getDockerHostList()).toEqual([]);
    });

    it('returns cached docker hosts', () => {
      const hosts = [
        { id: 1, name: 'local', dockerType: 'socket' as const, dockerDaemon: '/var/run/docker.sock' },
        { id: 2, name: 'remote', dockerType: 'tcp' as const, dockerDaemon: 'http://remote:2375' },
      ];
      injectDockerHostListCache(client, hosts);
      expect(client.getDockerHostList()).toEqual(hosts);
    });
  });

  describe('addDockerHost', () => {
    it('emits addDockerHost with null id for new hosts', async () => {
      const { socket } = createMockSocket({
        addDockerHost: (dockerHost, id, callback) => {
          expect(id).toBeNull();
          (callback as (res: unknown) => void)({ ok: true, id: 5, msg: 'Saved' });
        },
      });
      injectSocket(client, socket);

      const result = await client.addDockerHost({ name: 'test', dockerType: 'socket', dockerDaemon: '/var/run/docker.sock' });
      expect(result.ok).toBe(true);
      expect(result.id).toBe(5);
    });

    it('emits addDockerHost with dockerHostID for updates', async () => {
      const { socket } = createMockSocket({
        addDockerHost: (dockerHost, id, callback) => {
          expect(id).toBe(3);
          (callback as (res: unknown) => void)({ ok: true, id: 3, msg: 'Saved' });
        },
      });
      injectSocket(client, socket);

      const result = await client.addDockerHost({ name: 'updated', dockerType: 'tcp', dockerDaemon: 'http://host:2375' }, 3);
      expect(result.ok).toBe(true);
      expect(result.id).toBe(3);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        addDockerHost: (_dockerHost, _id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Permission denied' });
        },
      });
      injectSocket(client, socket);

      await expect(
        client.addDockerHost({ name: 'fail', dockerType: 'socket', dockerDaemon: '/var/run/docker.sock' })
      ).rejects.toThrow('Permission denied');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());

      await expect(
        client.addDockerHost({ name: 'x', dockerType: 'socket', dockerDaemon: '/var/run/docker.sock' })
      ).rejects.toThrow('Not connected to server');
    });
  });

  describe('deleteDockerHost', () => {
    it('emits deleteDockerHost and resolves on success', async () => {
      const { socket } = createMockSocket({
        deleteDockerHost: (id, callback) => {
          expect(id).toBe(7);
          (callback as (res: unknown) => void)({ ok: true, msg: 'Deleted' });
        },
      });
      injectSocket(client, socket);

      const result = await client.deleteDockerHost(7);
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        deleteDockerHost: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Not found' });
        },
      });
      injectSocket(client, socket);

      await expect(client.deleteDockerHost(999)).rejects.toThrow('Not found');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.deleteDockerHost(1)).rejects.toThrow('Not connected to server');
    });
  });

  describe('testDockerHost', () => {
    it('resolves with ok:true on success', async () => {
      const { socket } = createMockSocket({
        testDockerHost: (_dockerHost, callback) => {
          (callback as (res: unknown) => void)({ ok: true, msg: 'Connected! Total containers: 5' });
        },
      });
      injectSocket(client, socket);

      const result = await client.testDockerHost({ name: 'test', dockerType: 'socket', dockerDaemon: '/var/run/docker.sock' });
      expect(result.ok).toBe(true);
      expect(result.msg).toContain('5');
    });

    it('resolves (not rejects) with ok:false on failure', async () => {
      const { socket } = createMockSocket({
        testDockerHost: (_dockerHost, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Connection refused' });
        },
      });
      injectSocket(client, socket);

      const result = await client.testDockerHost({ name: 'test', dockerType: 'tcp', dockerDaemon: 'http://bad:2375' });
      expect(result.ok).toBe(false);
      expect(result.msg).toBe('Connection refused');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(
        client.testDockerHost({ name: 'x', dockerType: 'socket', dockerDaemon: '/x' })
      ).rejects.toThrow('Not connected to server');
    });
  });
});
