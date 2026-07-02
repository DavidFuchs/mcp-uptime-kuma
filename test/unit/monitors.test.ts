import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import {
  createMockSocket,
  createDisconnectedSocket,
  injectSocket,
  injectMonitorListCache,
  injectHeartbeatListCache,
  injectUptimeCache,
  injectAvgPingCache,
} from './helpers.js';

describe('UptimeKumaClient - Tag Reconciliation (createMonitor/updateMonitor)', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('createMonitor with tags', () => {
    it('creates monitor and then applies tags', async () => {
      const emitCalls: Array<{ event: string; args: unknown[] }> = [];

      const { socket } = createMockSocket({
        add: (payload, callback) => {
          emitCalls.push({ event: 'add', args: [payload] });
          // tags should NOT be in the payload sent to socket
          expect(payload).not.toHaveProperty('tags');
          (callback as (res: unknown) => void)({ ok: true, monitorID: 42 });
        },
        getTags: (callback) => {
          emitCalls.push({ event: 'getTags', args: [] });
          (callback as (res: unknown) => void)({ ok: true, tags: [{ id: 10, name: 'env', color: '#ff0000' }] });
        },
        addMonitorTag: (tagID, monitorID, value, callback) => {
          emitCalls.push({ event: 'addMonitorTag', args: [tagID, monitorID, value] });
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);
      // No existing tags on the monitor (fresh create)
      injectMonitorListCache(client, {});

      const result = await client.createMonitor({
        name: 'Test Monitor',
        type: 'http',
        url: 'https://example.com',
        tags: [{ name: 'env', value: 'prod' }],
      });

      expect(result.ok).toBe(true);
      expect(result.monitorID).toBe(42);
      // Verify tag was applied
      const addTagCall = emitCalls.find(c => c.event === 'addMonitorTag');
      expect(addTagCall).toBeDefined();
      expect(addTagCall!.args).toEqual([10, 42, 'prod']);
    });

    it('does not call reconcileMonitorTags when no tags provided', async () => {
      const { socket } = createMockSocket({
        add: (_payload, callback) => {
          (callback as (res: unknown) => void)({ ok: true, monitorID: 1 });
        },
      });
      injectSocket(client, socket);

      const result = await client.createMonitor({ name: 'No Tags', type: 'http', url: 'https://x.com' });
      expect(result.ok).toBe(true);
      // getTags should never be called
      expect(socket.emit).not.toHaveBeenCalledWith('getTags', expect.anything());
    });

    it('auto-creates tags that do not exist in the catalog', async () => {
      const createdTags: Array<{ name: string; color: string }> = [];

      const { socket } = createMockSocket({
        add: (_payload, callback) => {
          (callback as (res: unknown) => void)({ ok: true, monitorID: 5 });
        },
        getTags: (callback) => {
          // No existing tags
          (callback as (res: unknown) => void)({ ok: true, tags: [] });
        },
        addTag: (tagData, callback) => {
          createdTags.push(tagData as { name: string; color: string });
          (callback as (res: unknown) => void)({ ok: true, tag: { id: 99, name: (tagData as { name: string }).name, color: '#808080' } });
        },
        addMonitorTag: (_tagID, _monitorID, _value, callback) => {
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);
      injectMonitorListCache(client, {});

      await client.createMonitor({
        name: 'New Tag Monitor',
        type: 'http',
        url: 'https://x.com',
        tags: [{ name: 'brand-new-tag', value: 'val1' }],
      });

      expect(createdTags).toHaveLength(1);
      expect(createdTags[0].name).toBe('brand-new-tag');
    });
  });

  describe('updateMonitor with tags', () => {
    it('reconciles tags: adds new ones and removes old ones', async () => {
      const addedMonitorTags: Array<{ tagID: number; monitorID: number; value: string }> = [];
      const deletedMonitorTags: Array<{ tagID: number; monitorID: number; value: string }> = [];

      const { socket } = createMockSocket({
        editMonitor: (payload, callback) => {
          expect(payload).not.toHaveProperty('tags');
          (callback as (res: unknown) => void)({ ok: true, monitorID: 10 });
        },
        getTags: (callback) => {
          (callback as (res: unknown) => void)({
            ok: true,
            tags: [
              { id: 1, name: 'env', color: '#ff0000' },
              { id: 2, name: 'region', color: '#00ff00' },
            ],
          });
        },
        addMonitorTag: (tagID, monitorID, value, callback) => {
          addedMonitorTags.push({ tagID: tagID as number, monitorID: monitorID as number, value: value as string });
          (callback as (res: unknown) => void)({ ok: true });
        },
        deleteMonitorTag: (tagID, monitorID, value, callback) => {
          deletedMonitorTags.push({ tagID: tagID as number, monitorID: monitorID as number, value: value as string });
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);

      // Existing monitor with tag "env=staging"
      injectMonitorListCache(client, {
        '10': {
          id: 10,
          name: 'Test',
          tags: [{ tag_id: 1, name: 'env', value: 'staging' }],
        },
      });

      await client.updateMonitor({
        id: 10,
        name: 'Test',
        // Desired: remove "env=staging", add "region=us-east"
        tags: [{ name: 'region', value: 'us-east' }],
      });

      // Should have added region=us-east
      expect(addedMonitorTags).toContainEqual({ tagID: 2, monitorID: 10, value: 'us-east' });
      // Should have removed env=staging
      expect(deletedMonitorTags).toContainEqual({ tagID: 1, monitorID: 10, value: 'staging' });
    });

    it('does not add or remove tags that already match', async () => {
      const addedMonitorTags: unknown[] = [];
      const deletedMonitorTags: unknown[] = [];

      const { socket } = createMockSocket({
        editMonitor: (_payload, callback) => {
          (callback as (res: unknown) => void)({ ok: true, monitorID: 10 });
        },
        getTags: (callback) => {
          (callback as (res: unknown) => void)({
            ok: true,
            tags: [{ id: 1, name: 'env', color: '#ff0000' }],
          });
        },
        addMonitorTag: (tagID, monitorID, value, callback) => {
          addedMonitorTags.push({ tagID, monitorID, value });
          (callback as (res: unknown) => void)({ ok: true });
        },
        deleteMonitorTag: (tagID, monitorID, value, callback) => {
          deletedMonitorTags.push({ tagID, monitorID, value });
          (callback as (res: unknown) => void)({ ok: true });
        },
      });
      injectSocket(client, socket);

      injectMonitorListCache(client, {
        '10': {
          id: 10,
          name: 'Test',
          tags: [{ tag_id: 1, name: 'env', value: 'prod' }],
        },
      });

      // Desired tags match existing — no changes needed
      await client.updateMonitor({
        id: 10,
        name: 'Test',
        tags: [{ name: 'env', value: 'prod' }],
      });

      expect(addedMonitorTags).toHaveLength(0);
      expect(deletedMonitorTags).toHaveLength(0);
    });

    it('does not reconcile tags if tags field is absent', async () => {
      const { socket } = createMockSocket({
        editMonitor: (_payload, callback) => {
          (callback as (res: unknown) => void)({ ok: true, monitorID: 10 });
        },
      });
      injectSocket(client, socket);

      const result = await client.updateMonitor({ id: 10, name: 'Test' });
      expect(result.ok).toBe(true);
      // getTags should never be called
      expect(socket.emit).not.toHaveBeenCalledWith('getTags', expect.anything());
    });
  });
});

describe('UptimeKumaClient - Monitor CRUD Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('deleteMonitor', () => {
    it('emits deleteMonitor and resolves on success', async () => {
      const { socket } = createMockSocket({
        deleteMonitor: (id, callback) => {
          expect(id).toBe(5);
          (callback as (res: unknown) => void)({ ok: true, msg: 'Deleted' });
        },
      });
      injectSocket(client, socket);

      const result = await client.deleteMonitor(5);
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        deleteMonitor: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Monitor not found' });
        },
      });
      injectSocket(client, socket);

      await expect(client.deleteMonitor(999)).rejects.toThrow('Monitor not found');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.deleteMonitor(1)).rejects.toThrow('Not connected to server');
    });
  });

  describe('pauseMonitor', () => {
    it('emits pauseMonitor and resolves on success', async () => {
      const { socket } = createMockSocket({
        pauseMonitor: (id, callback) => {
          expect(id).toBe(3);
          (callback as (res: unknown) => void)({ ok: true, msg: 'Paused' });
        },
      });
      injectSocket(client, socket);

      const result = await client.pauseMonitor(3);
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        pauseMonitor: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Failed to pause' });
        },
      });
      injectSocket(client, socket);

      await expect(client.pauseMonitor(1)).rejects.toThrow('Failed to pause');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.pauseMonitor(1)).rejects.toThrow('Not connected to server');
    });
  });

  describe('resumeMonitor', () => {
    it('emits resumeMonitor and resolves on success', async () => {
      const { socket } = createMockSocket({
        resumeMonitor: (id, callback) => {
          expect(id).toBe(3);
          (callback as (res: unknown) => void)({ ok: true, msg: 'Resumed' });
        },
      });
      injectSocket(client, socket);

      const result = await client.resumeMonitor(3);
      expect(result.ok).toBe(true);
    });

    it('rejects when server returns not ok', async () => {
      const { socket } = createMockSocket({
        resumeMonitor: (_id, callback) => {
          (callback as (res: unknown) => void)({ ok: false, msg: 'Failed to resume' });
        },
      });
      injectSocket(client, socket);

      await expect(client.resumeMonitor(1)).rejects.toThrow('Failed to resume');
    });

    it('rejects when not connected', async () => {
      injectSocket(client, createDisconnectedSocket());
      await expect(client.resumeMonitor(1)).rejects.toThrow('Not connected to server');
    });
  });

  describe('getMonitor', () => {
    it('returns undefined for a non-existent monitor', () => {
      expect(client.getMonitor(999)).toBeUndefined();
    });

    it('returns monitor with uptime and avgPing data merged', () => {
      injectMonitorListCache(client, {
        '1': { id: 1, name: 'Web', type: 'http', active: true, tags: [] },
      });
      injectUptimeCache(client, { '1': { '24h': 0.99, '720h': 0.98 } });
      injectAvgPingCache(client, { '1': 42 });

      const monitor = client.getMonitor(1);
      expect(monitor).toBeDefined();
      expect(monitor!.name).toBe('Web');
      expect((monitor as any).uptime).toEqual({ '24h': 0.99, '720h': 0.98 });
      expect((monitor as any).avgPing).toBe(42);
    });

    it('returns empty uptime object when no uptime cached', () => {
      injectMonitorListCache(client, {
        '2': { id: 2, name: 'API', type: 'http', active: true, tags: [] },
      });

      const monitor = client.getMonitor(2);
      expect((monitor as any).uptime).toEqual({});
      expect((monitor as any).avgPing).toBeUndefined();
    });
  });

  describe('getMonitorList', () => {
    beforeEach(() => {
      injectMonitorListCache(client, {
        '1': { id: 1, name: 'Web', type: 'http', active: true, maintenance: false, pathName: 'Web', tags: [{ name: 'env', value: 'prod' }] },
        '2': { id: 2, name: 'API', type: 'http', active: true, maintenance: false, pathName: 'API', tags: [{ name: 'env', value: 'staging' }] },
        '3': { id: 3, name: 'DNS Check', type: 'dns', active: false, maintenance: false, pathName: 'DNS Check', tags: [] },
        '4': { id: 4, name: 'Ping Server', type: 'ping', active: true, maintenance: true, pathName: 'Ping Server', tags: [{ name: 'region', value: 'us-east' }] },
      });
    });

    it('returns all monitors when no filters applied', () => {
      const result = client.getMonitorList();
      expect(Object.keys(result)).toHaveLength(4);
    });

    it('filters by type', () => {
      const result = client.getMonitorList({ type: 'http' });
      expect(Object.keys(result)).toHaveLength(2);
    });

    it('filters by multiple types (comma-separated)', () => {
      const result = client.getMonitorList({ type: 'http,dns' });
      expect(Object.keys(result)).toHaveLength(3);
    });

    it('filters by active status', () => {
      const result = client.getMonitorList({ active: false });
      expect(Object.keys(result)).toHaveLength(1);
      expect(Object.values(result)[0].name).toBe('DNS Check');
    });

    it('filters by maintenance status', () => {
      const result = client.getMonitorList({ maintenance: true });
      expect(Object.keys(result)).toHaveLength(1);
      expect(Object.values(result)[0].name).toBe('Ping Server');
    });

    it('filters by tag name', () => {
      const result = client.getMonitorList({ tags: 'env' });
      expect(Object.keys(result)).toHaveLength(2);
    });

    it('filters by tag name=value', () => {
      const result = client.getMonitorList({ tags: 'env=prod' });
      expect(Object.keys(result)).toHaveLength(1);
      expect(Object.values(result)[0].name).toBe('Web');
    });

    it('filters by keywords using fuzzy match', () => {
      const result = client.getMonitorList({ keywords: 'Web' });
      expect(Object.keys(result)).toHaveLength(1);
      expect(Object.values(result)[0].name).toBe('Web');
    });
  });

  describe('getMonitorSummary', () => {
    beforeEach(() => {
      injectMonitorListCache(client, {
        '1': { id: 1, name: 'Web', type: 'http', active: true, maintenance: false, pathName: 'Web', tags: [] },
        '2': { id: 2, name: 'API', type: 'http', active: true, maintenance: false, pathName: 'API', tags: [] },
      });
      injectHeartbeatListCache(client, {
        '1': [{ monitorID: 1, status: 1, msg: 'OK', ping: 50, time: '2024-01-01' }],
        '2': [{ monitorID: 2, status: 0, msg: 'Connection refused', ping: null, time: '2024-01-01' }],
      });
      injectUptimeCache(client, { '1': { '24h': 0.99 } });
      injectAvgPingCache(client, { '1': 50, '2': null });
    });

    it('returns summaries for all monitors', () => {
      const summaries = client.getMonitorSummary();
      expect(summaries).toHaveLength(2);
    });

    it('includes latest heartbeat status in summary', () => {
      const summaries = client.getMonitorSummary();
      const web = summaries.find(s => s.name === 'Web');
      expect(web?.status).toBe(1);
      expect(web?.msg).toBe('OK');
    });

    it('filters by status', () => {
      const down = client.getMonitorSummary({ status: '0' });
      expect(down).toHaveLength(1);
      expect(down[0].name).toBe('API');
    });

    it('includes uptime and avgPing data', () => {
      const summaries = client.getMonitorSummary();
      const web = summaries.find(s => s.name === 'Web');
      expect(web?.uptime).toEqual({ '24h': 0.99 });
      expect(web?.avgPing).toBe(50);
    });
  });
});
