import { describe, it, expect, beforeEach } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

describe('UptimeKumaClient - Disconnected state', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('all write methods reject when socket is null', async () => {
    // Socket is null by default (not connected)
    await expect(client.addDockerHost({ name: 'x', dockerType: 'socket', dockerDaemon: '/x' })).rejects.toThrow('Not connected');
    await expect(client.deleteDockerHost(1)).rejects.toThrow('Not connected');
    await expect(client.testDockerHost({ name: 'x' })).rejects.toThrow('Not connected');
    await expect(client.createStatusPage('t', 's')).rejects.toThrow('Not connected');
    await expect(client.updateStatusPage('s', {})).rejects.toThrow('Not connected');
    await expect(client.deleteStatusPage('s')).rejects.toThrow('Not connected');
    await expect(client.createMonitor({ name: 'x', type: 'http' })).rejects.toThrow('Not connected');
    await expect(client.updateMonitor({ id: 1, name: 'x' })).rejects.toThrow('Not connected');
    await expect(client.deleteMonitor(1)).rejects.toThrow('Not connected');
    await expect(client.pauseMonitor(1)).rejects.toThrow('Not connected');
    await expect(client.resumeMonitor(1)).rejects.toThrow('Not connected');
    await expect(client.addNotification({ name: 'x', type: 'slack' })).rejects.toThrow('Not connected');
    await expect(client.deleteNotification(1)).rejects.toThrow('Not connected');
    await expect(client.addTag('x', '#000')).rejects.toThrow('Not connected');
    await expect(client.deleteTag(1)).rejects.toThrow('Not connected');
    await expect(client.createMaintenance({ title: 'x' })).rejects.toThrow('Not connected');
    await expect(client.getSettings()).rejects.toThrow('Not connected');
    await expect(client.login('user', 'pass')).rejects.toThrow('Not connected');
  });
});
