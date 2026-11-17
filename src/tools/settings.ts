import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ToolContext } from './context.js';
import { SettingsSchema } from '../types/index.js';
import { redactSecrets, SECRET_MARKER } from '../redact.js';
import { numeric } from './schema.js';

/** The settings that hold credentials. */
const SECRET_SETTINGS = ['steamAPIKey', 'globalpingApiToken'] as const;

/**
 * What the web UI fills in for a setting that has never been saved (Settings.vue loadSettings),
 * and so what Uptime Kuma receives for it on every save from the UI. updateSettings sends the
 * same, so a save here has the side effects a save there would, and no others.
 */
export const SETTINGS_UI_DEFAULTS: Readonly<Record<string, unknown>> = {
  checkUpdate: true,
  searchEngineIndex: false,
  entryPage: 'dashboard',
  nscd: true,
  prometheusApiEnabled: false,
  keepDataPeriodDays: 180,
  tlsExpiryNotifyDays: [7, 14, 21],
  domainExpiryNotifyDays: [7, 14, 21],
  trustProxy: false,
  apiEnabled: false,
};

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const expiryDays = z
  .array(numeric(z.number().int().positive()))
  .min(1)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

/** The tools that read and change Uptime Kuma's settings. */
export function registerSettingsTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  // Register getSettings tool
  server.registerTool(
    'getSettings',
    {
      title: 'Get Settings',
      description:
        'Returns the Uptime Kuma server settings, such as timezone, primary base URL and data retention. Only settings that have been saved are returned, so a missing key (for example primaryBaseURL) has never been set. Credentials read "***" unless includeSecrets is set. To change a setting use updateSettings.',
      inputSchema: {
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        settings: SettingsSchema.describe('Current Uptime Kuma server settings'),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const response = await client.getSettings();

        if (!response.data) {
          throw new Error('No settings data returned');
        }

        // SettingsSchema declares a safe subset, but the text content below stringifies
        // whatever Uptime Kuma actually sent — which includes steamAPIKey. Redacting the
        // object covers both channels; redacting only structuredContent would not.
        const settings = wantsSecrets(includeSecrets) ? response.data : redactSecrets(response.data);

        return {
          content: [{ type: 'text', text: JSON.stringify(settings) }],
          structuredContent: { settings },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get settings: ${errorMessage}`);
      }
    }
  );

  // Every setting the web UI's settings pages save through setSettings.
  server.registerTool(
    'updateSettings',
    {
      title: 'Update Settings',
      description:
        'Changes Uptime Kuma server settings. Pass only what should change; every other setting keeps its stored value. Returns the settings as saved. Turning login off (disableAuth: true) needs currentPassword and leaves the dashboard open to anyone who can reach it. Read the current values with getSettings.',
      inputSchema: {
        serverTimezone: z
          .string()
          .refine(isValidTimezone, { message: 'not an IANA timezone name (e.g. "Europe/Berlin", "UTC")' })
          .optional()
          .describe(
            'IANA timezone the server shows times and schedules maintenance in, e.g. "America/Edmonton" or "UTC"'
          ),
        primaryBaseURL: z
          .union([z.literal(''), z.string().regex(/^https?:\/\/.+/, 'must start with http:// or https://')])
          .optional()
          .describe(
            'The public address of this Uptime Kuma, used for links in notifications, e.g. "https://status.example.com". "" clears it.'
          ),
        entryPage: z
          .string()
          .optional()
          .describe(
            'What "/" opens: "dashboard", or a status page as "statusPage-<slug>". Find slugs with listStatusPages.'
          ),
        keepDataPeriodDays: numeric(z.number().int().nonnegative())
          .optional()
          .describe('Days of heartbeat history to keep; older beats are deleted'),
        tlsExpiryNotifyDays: expiryDays
          .optional()
          .describe(
            'Days before a TLS certificate expires to send a warning, e.g. [7, 14, 21]. Replaces the whole list.'
          ),
        domainExpiryNotifyDays: expiryDays
          .optional()
          .describe('Days before a domain registration expires to send a warning. Replaces the whole list.'),
        searchEngineIndex: z.boolean().optional().describe('Let search engines index status pages'),
        checkUpdate: z.boolean().optional().describe('Show when a new Uptime Kuma version is available'),
        trustProxy: z
          .boolean()
          .optional()
          .describe('Trust X-Forwarded-* headers. Set only when Uptime Kuma sits behind a reverse proxy.'),
        nscd: z.boolean().optional().describe('Cache DNS lookups with NSCD (Docker images only)'),
        chromeExecutable: z
          .string()
          .optional()
          .describe(
            'Path of the Chrome or Chromium binary real-browser monitors run, e.g. "/usr/bin/chromium". "" auto-detects. Changing it restarts the browser.'
          ),
        apiEnabled: z.boolean().optional().describe('The "API" switch in Settings > General'),
        prometheusApiEnabled: z
          .boolean()
          .optional()
          .describe('Collect Prometheus metrics. Changing it starts or stops the collection.'),
        steamAPIKey: z
          .string()
          .optional()
          .describe(
            'Steam Web API key, used by Steam game server monitors. A credential: "***" (what read tools return) keeps the stored key, "" clears it.'
          ),
        globalpingApiToken: z
          .string()
          .optional()
          .describe(
            'Globalping API token, used by globalping monitors. A credential: "***" (what read tools return) keeps the stored token, "" clears it.'
          ),
        disableAuth: z
          .boolean()
          .optional()
          .describe(
            'true turns login off: anyone who can reach Uptime Kuma gets full control. Needs currentPassword. false turns login back on and logs out every other session.'
          ),
        currentPassword: z
          .string()
          .optional()
          .describe(
            'The admin password. Required only to turn login off (disableAuth: true) while it is on; never stored or returned.'
          ),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        ok: z.boolean(),
        changed: z.array(z.string()).describe('The settings this call changed'),
        settings: SettingsSchema.describe('Uptime Kuma server settings after the change'),
        msg: z.string().optional(),
      },
    },
    async ({ includeSecrets, currentPassword, ...changes }) => {
      await authenticateClient();

      try {
        const updates = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
        if (Object.keys(updates).length === 0) {
          throw new Error('nothing to change — pass at least one setting');
        }

        // "***" is what the read tools show for a credential; sending it back keeps the stored
        // one. Uptime Kuma leaves a key it is not sent untouched, and the client never reads
        // steamAPIKey back, so dropping it from the update is all that is needed.
        const keptSecrets = SECRET_SETTINGS.filter((key) => updates[key] === SECRET_MARKER);
        for (const key of keptSecrets) delete updates[key];

        if (typeof updates.entryPage === 'string' && updates.entryPage !== 'dashboard') {
          const slug = updates.entryPage.startsWith('statusPage-')
            ? updates.entryPage.slice('statusPage-'.length)
            : undefined;
          if (!slug) {
            throw new Error(`entryPage must be "dashboard" or "statusPage-<slug>", not "${updates.entryPage}"`);
          }
          if (!client.getStatusPageList().some((p) => p.slug === slug)) {
            throw new Error(`No status page with slug "${slug}" — call listStatusPages to see the slugs`);
          }
        }

        const current = await client.getSettings();
        if (!current.data) {
          throw new Error('No settings data returned');
        }
        const stored = current.data as Record<string, unknown>;

        // Uptime Kuma's handler reads an absent key as a change (see client.setSettings), so the
        // whole stored object goes back, with the UI's defaults for anything never saved. Every
        // secret is dropped from it unless this call sets it, so a stored credential is never
        // written back from a copy.
        const merged: Record<string, unknown> = { ...SETTINGS_UI_DEFAULTS, ...stored };
        for (const key of SECRET_SETTINGS) delete merged[key];
        Object.assign(merged, updates);
        const changed = Object.keys(updates).filter(
          (key) =>
            // steamAPIKey is never read back, so setting it always counts as a change.
            !(key in stored) || JSON.stringify(stored[key]) !== JSON.stringify(updates[key])
        );

        if (updates.disableAuth === true && stored.disableAuth !== true && !currentPassword) {
          throw new Error(
            'turning login off needs the admin password in currentPassword. Confirm with the user first: with login off, anyone who can reach Uptime Kuma has full control.'
          );
        }

        if (changed.length === 0) {
          const settings = wantsSecrets(includeSecrets) ? stored : redactSecrets(stored);
          return {
            content: [
              { type: 'text', text: `No change: the settings already have those values. ${JSON.stringify(settings)}` },
            ],
            structuredContent: { ok: true, changed, settings },
          };
        }

        const response = await client.setSettings(merged, currentPassword);

        const saved = (await client.getSettings()).data ?? merged;
        const settings = wantsSecrets(includeSecrets) ? saved : redactSecrets(saved);
        return {
          content: [{ type: 'text', text: `Settings updated (${changed.join(', ')}): ${JSON.stringify(settings)}` }],
          structuredContent: { ok: response.ok, changed, settings, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update settings: ${errorMessage}`);
      }
    }
  );
}
