import { z } from 'zod';
import type { ApiResponse } from './responses.js';

/**
 * Zod schema for Uptime Kuma settings
 */
export const SettingsSchema = z.object({
  serverTimezone: z.string().describe('Server timezone'),
  checkUpdate: z.boolean().describe('Check for updates'),
  searchEngineIndex: z.boolean().describe('Allow search engine indexing'),
  entryPage: z.string().describe('Entry page (dashboard/statuspage)'),
  dnsCache: z.boolean().describe('DNS cache enabled'),
  keepDataPeriodDays: z.number().describe('Data retention period (days)'),
  tlsExpiryNotifyDays: z.array(z.number()).describe('TLS expiry notification days'),
  trustProxy: z.boolean().describe('Trust proxy headers'),
  nscd: z.boolean().describe('NSCD enabled'),
  disableAuth: z.boolean().describe('Authentication disabled'),
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
