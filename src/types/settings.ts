import { z } from 'zod';
import type { ApiResponse } from './responses.js';

/**
 * Zod schema for Uptime Kuma settings
 */
export const SettingsSchema = z.object({
  serverTimezone: z.string().optional().describe('Server timezone'),
  checkUpdate: z.boolean().optional().describe('Check for updates'),
  searchEngineIndex: z.boolean().optional().describe('Allow search engine indexing'),
  entryPage: z.string().optional().describe('Entry page (dashboard/statuspage)'),
  dnsCache: z.boolean().optional().describe('DNS cache enabled'),
  keepDataPeriodDays: z.number().optional().describe('Data retention period (days)'),
  tlsExpiryNotifyDays: z.array(z.number()).optional().describe('TLS expiry notification days'),
  trustProxy: z.boolean().optional().describe('Trust proxy headers'),
  nscd: z.boolean().optional().describe('NSCD enabled'),
  disableAuth: z.boolean().optional().describe('Authentication disabled'),
  primaryBaseURL: z.string().optional().describe('Primary base URL'),
});

/**
 * Settings type inferred from the Zod schema
 */
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Get settings response
 */
export interface GetSettingsResponse extends ApiResponse {
  data?: Settings;
}
