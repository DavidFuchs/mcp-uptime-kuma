import { z } from 'zod';
import type { MonitorBaseWithExtendedData, MonitorWithExtendedData } from './monitor-types.js';

/**
 * Response structure for API callbacks
 */
export interface ApiResponse {
  ok: boolean;
  msg?: string;
  msgi18n?: boolean;
}

/**
 * What Uptime Kuma pushes about itself in its "info" event. The version, database type and
 * runtime are only sent once logged in.
 */
export interface ServerInfo {
  version?: string;
  latestVersion?: string;
  /** "sqlite", "mariadb" or "embedded-mariadb". */
  dbType?: string;
  isContainer?: boolean;
  primaryBaseURL?: string | null;
  serverTimezone?: string;
  serverTimezoneOffset?: string;
  runtime?: { platform?: string; arch?: string };
}

/** A game in GameDig's list, as Uptime Kuma's getGameList returns it. */
export interface GameDigGame {
  keys: string[];
  pretty: string;
  options?: { port?: number; port_query?: number; port_query_offset?: number | number[]; protocol?: string };
  extra?: { old_id?: string; doc_notes?: string };
}

/** A process from `pm2 jlist` on the Uptime Kuma host. */
export interface PM2Process {
  id: string;
  name: string;
  status: string;
}

/**
 * Uptime Kuma's answer to checkDomain. A refusal has ok: false and msg set to a translation key
 * (msgi18n: true), with the values for its placeholders in meta.
 */
export interface CheckDomainResponse extends ApiResponse {
  domain?: string;
  tld?: string;
  meta?: Record<string, unknown>;
}

/**
 * Login response
 */
export interface LoginResponse extends ApiResponse {
  token?: string;
  tokenRequired?: boolean;
}

/**
 * Socket.IO API Response schemas
 */
export const SocketSuccessResponseSchema = z.object({
  ok: z.literal(true),
  msg: z.string().optional(),
  msgi18n: z.boolean().optional(),
  monitorID: z.number().optional(),
});

export const SocketErrorResponseSchema = z.object({
  ok: z.literal(false),
  msg: z.string(),
});

export const SocketResponseSchema = z.union([SocketSuccessResponseSchema, SocketErrorResponseSchema]);

/**
 * Socket.IO response types
 */
export type SocketSuccessResponse = z.infer<typeof SocketSuccessResponseSchema>;
export type SocketErrorResponse = z.infer<typeof SocketErrorResponseSchema>;
export type SocketResponse = z.infer<typeof SocketResponseSchema>;

/**
 * Monitor list structure
 * When includeTypeSpecificFields is true, returns full monitor details with type-specific fields and runtime data
 * When includeTypeSpecificFields is false, returns only common monitor fields plus runtime data
 */
export type MonitorList<T extends boolean = false> = {
  [monitorID: string]: T extends true ? MonitorWithExtendedData : MonitorBaseWithExtendedData;
};

/**
 * Get monitor response
 * When includeTypeSpecificFields is true, returns full monitor details with type-specific fields and runtime data
 * When includeTypeSpecificFields is false, returns only common monitor fields plus runtime data
 */
export interface GetMonitorResponse<T extends boolean = false> extends ApiResponse {
  monitor?: T extends true ? MonitorWithExtendedData : MonitorBaseWithExtendedData;
}
