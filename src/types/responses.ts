import { z } from 'zod';
import type { MonitorBase } from './monitor-base.js';
import type { MonitorBaseWithExtendedData, MonitorWithExtendedData, MonitorRawData } from './monitor-types.js';

/**
 * Response structure for API callbacks
 */
export interface ApiResponse {
  ok: boolean;
  msg?: string;
  msgi18n?: boolean;
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

export const SocketResponseSchema = z.union([
  SocketSuccessResponseSchema,
  SocketErrorResponseSchema,
]);

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
