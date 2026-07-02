import { describe, it, expect, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { injectHeartbeatListCache } from './helpers.js';

describe('UptimeKumaClient - Heartbeat Operations', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  describe('getHeartbeatList', () => {
    it('returns empty object when no heartbeats cached', () => {
      expect(client.getHeartbeatList()).toEqual({});
    });

    it('returns only the most recent heartbeat per monitor by default', () => {
      injectHeartbeatListCache(client, {
        '1': [
          { monitorID: 1, status: 1, msg: 'OK', time: '2024-01-02' },
          { monitorID: 1, status: 0, msg: 'Down', time: '2024-01-01' },
        ],
        '2': [
          { monitorID: 2, status: 1, msg: 'OK', time: '2024-01-02' },
        ],
      });

      const result = client.getHeartbeatList();
      expect(result['1']).toHaveLength(1);
      expect((result['1'][0] as any).msg).toBe('OK');
      expect(result['2']).toHaveLength(1);
    });

    it('returns up to maxHeartbeats per monitor', () => {
      injectHeartbeatListCache(client, {
        '1': [
          { monitorID: 1, status: 1, msg: 'OK', time: '2024-01-03' },
          { monitorID: 1, status: 0, msg: 'Down', time: '2024-01-02' },
          { monitorID: 1, status: 1, msg: 'OK', time: '2024-01-01' },
        ],
      });

      const result = client.getHeartbeatList(2);
      expect(result['1']).toHaveLength(2);
    });

    it('returns all heartbeats when maxHeartbeats exceeds available', () => {
      injectHeartbeatListCache(client, {
        '1': [
          { monitorID: 1, status: 1, msg: 'OK', time: '2024-01-01' },
        ],
      });

      const result = client.getHeartbeatList(10);
      expect(result['1']).toHaveLength(1);
    });
  });

  describe('getHeartbeatsForMonitor', () => {
    it('returns empty array for non-existent monitor', () => {
      expect(client.getHeartbeatsForMonitor(999)).toEqual([]);
    });

    it('returns the most recent heartbeat by default', () => {
      injectHeartbeatListCache(client, {
        '5': [
          { monitorID: 5, status: 1, msg: 'OK', time: '2024-01-02' },
          { monitorID: 5, status: 0, msg: 'Timeout', time: '2024-01-01' },
        ],
      });

      const result = client.getHeartbeatsForMonitor(5);
      expect(result).toHaveLength(1);
      expect((result[0] as any).msg).toBe('OK');
    });

    it('returns up to maxHeartbeats', () => {
      injectHeartbeatListCache(client, {
        '5': [
          { monitorID: 5, status: 1, msg: 'OK', time: '2024-01-03' },
          { monitorID: 5, status: 0, msg: 'Timeout', time: '2024-01-02' },
          { monitorID: 5, status: 1, msg: 'OK', time: '2024-01-01' },
        ],
      });

      const result = client.getHeartbeatsForMonitor(5, 2);
      expect(result).toHaveLength(2);
    });
  });
});
