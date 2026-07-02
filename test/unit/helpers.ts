import { vi } from 'vitest';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Creates a mock socket with an emit function that intercepts socket events.
 * The emitHandlers map lets tests define per-event callback responses.
 */
export function createMockSocket(emitHandlers: Record<string, (...args: unknown[]) => void> = {}) {
  const onHandlers: Record<string, (...args: unknown[]) => void> = {};

  const socket = {
    connected: true,
    emit: vi.fn((...args: unknown[]) => {
      const event = args[0] as string;
      const handler = emitHandlers[event];
      if (handler) {
        handler(...args.slice(1));
      }
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      onHandlers[event] = handler;
    }),
    off: vi.fn(),
    disconnect: vi.fn(),
  };

  return { socket, onHandlers };
}

/**
 * Creates a disconnected mock socket for testing rejection behavior.
 */
export function createDisconnectedSocket() {
  return { connected: false, emit: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() };
}

/**
 * Injects a mock socket into an UptimeKumaClient instance via its private field.
 */
export function injectSocket(client: UptimeKumaClient, socket: unknown) {
  (client as unknown as { socket: unknown }).socket = socket;
}

/**
 * Injects data into the client's private monitorListCache.
 */
export function injectMonitorListCache(client: UptimeKumaClient, cache: Record<string, unknown>) {
  (client as unknown as { monitorListCache: Record<string, unknown> }).monitorListCache = cache;
}

/**
 * Injects data into the client's private heartbeatListCache.
 */
export function injectHeartbeatListCache(client: UptimeKumaClient, cache: Record<string, unknown[]>) {
  (client as unknown as { heartbeatListCache: Record<string, unknown[]> }).heartbeatListCache = cache;
}

/**
 * Injects data into the client's private uptimeCache.
 */
export function injectUptimeCache(client: UptimeKumaClient, cache: Record<string, Record<string, number>>) {
  (client as unknown as { uptimeCache: Record<string, Record<string, number>> }).uptimeCache = cache;
}

/**
 * Injects data into the client's private avgPingCache.
 */
export function injectAvgPingCache(client: UptimeKumaClient, cache: Record<string, number | null>) {
  (client as unknown as { avgPingCache: Record<string, number | null> }).avgPingCache = cache;
}

/**
 * Injects data into the client's private notificationListCache.
 */
export function injectNotificationListCache(client: UptimeKumaClient, cache: Record<string, unknown>) {
  (client as unknown as { notificationListCache: Record<string, unknown> }).notificationListCache = cache;
}

/**
 * Injects data into the client's private tagListCache.
 */
export function injectTagListCache(client: UptimeKumaClient, cache: unknown[]) {
  (client as unknown as { tagListCache: unknown[] }).tagListCache = cache;
}

/**
 * Injects data into the client's private maintenanceListCache.
 */
export function injectMaintenanceListCache(client: UptimeKumaClient, cache: Record<string, unknown>) {
  (client as unknown as { maintenanceListCache: Record<string, unknown> }).maintenanceListCache = cache;
}

/**
 * Injects data into the client's private statusPageListCache.
 */
export function injectStatusPageListCache(client: UptimeKumaClient, cache: Record<string, unknown>) {
  (client as unknown as { statusPageListCache: Record<string, unknown> }).statusPageListCache = cache;
}

/**
 * Injects data into the client's private dockerHostListCache.
 */
export function injectDockerHostListCache(client: UptimeKumaClient, cache: unknown[]) {
  (client as unknown as { dockerHostListCache: unknown[] }).dockerHostListCache = cache;
}
