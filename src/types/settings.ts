import { z } from 'zod';
import type { ApiResponse } from './responses.js';

/**
 * Zod schema for Uptime Kuma settings
 */
// Passthrough: Uptime Kuma returns every general setting ever saved, and a release can add
// new ones. A strict schema here made getSettings fail on any instance with an undeclared key.
export const SettingsSchema = z
  .object({
    serverTimezone: z.string().optional().describe('Server timezone'),
    checkUpdate: z.boolean().optional().describe('Check for updates'),
    searchEngineIndex: z.boolean().optional().describe('Allow search engine indexing'),
    entryPage: z.string().optional().describe('Entry page (dashboard/statuspage)'),
    dnsCache: z.boolean().optional().describe('DNS cache enabled'),
    keepDataPeriodDays: z.number().optional().describe('Data retention period (days)'),
    domainExpiryNotifyDays: z.array(z.number()).optional().describe('Domain expiry notification days'),
    tlsExpiryNotifyDays: z.array(z.number()).optional().describe('TLS expiry notification days'),
    trustProxy: z.boolean().optional().describe('Trust proxy headers'),
    nscd: z.boolean().optional().describe('NSCD enabled'),
    disableAuth: z.boolean().optional().describe('Authentication disabled'),
    primaryBaseURL: z.string().optional().describe('Primary base URL'),
    chromeExecutable: z
      .string()
      .optional()
      .describe('Chrome/Chromium path for real-browser monitors; empty = auto-detect'),
    apiEnabled: z.boolean().optional().describe('API access enabled (the "API" switch in Settings > General)'),
    prometheusApiEnabled: z.boolean().optional().describe('Prometheus metrics collection enabled'),
    steamAPIKey: z.string().optional().describe('Steam Web API key for Steam game server monitors'),
    globalpingApiToken: z.string().optional().describe('Globalping API token for globalping monitors'),
  })
  .passthrough();

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
