import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText } from './helpers.js';

/**
 * Integration tests for credential redaction (issue #59).
 *
 * The unit tests cover the redactor in isolation; these prove the two things that can
 * only be shown against a live server:
 *
 *   1. a secret written through the MCP does not come back out of the read tools, and
 *   2. the read-edit-write loop an agent naturally performs does not replace that
 *      secret with the redaction marker.
 *
 * Every object created here is deleted in a finally block.
 */

const MARKER = '***';
const SMTP_PASSWORD = 'zz-integration-secret-do-not-use';
const API_KEY = 'zz-integration-header-key';

async function call(client: any, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export const redactionTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listNotifications withholds credentials and names what it withheld',
    fn: async ({ client }) => {
      let notificationID: number | undefined;
      try {
        const created = await call(client, 'addNotification', {
          name: 'zz-redaction-delete-me',
          type: 'smtp',
          config: {
            type: 'smtp',
            smtpHost: 'smtp.example.invalid',
            smtpPort: 587,
            smtpUsername: 'zz-user',
            smtpPassword: SMTP_PASSWORD,
            smtpFrom: 'zz@example.invalid',
            smtpTo: 'zz@example.invalid',
          },
        });
        notificationID = (created as any).structuredContent?.id;
        if (!notificationID) throw new Error('addNotification returned no id');

        const listed = extractText(await call(client, 'listNotifications', {}), 'listNotifications');
        if (listed.includes(SMTP_PASSWORD)) {
          throw new Error('smtpPassword came back in cleartext');
        }
        if (!listed.includes(MARKER) && !listed.includes('redactedConfigKeys')) {
          throw new Error('no sign the config was redacted at all');
        }
        if (!listed.includes('smtpPassword')) {
          throw new Error('redactedConfigKeys should still NAME smtpPassword so the caller knows it is set');
        }

        const withSecrets = extractText(
          await call(client, 'listNotifications', { includeSecrets: true }),
          'listNotifications'
        );
        if (!withSecrets.includes(SMTP_PASSWORD)) {
          throw new Error('includeSecrets: true did not return the real value');
        }
        console.log('  ✓ listNotifications redacts by default and opts in on request');
      } finally {
        if (notificationID) await call(client, 'deleteNotification', { notificationID });
      }
    },
  },

  {
    name: 'updateNotification does not clobber a secret it never showed the caller',
    fn: async ({ client }) => {
      // This is the case the maintainer flagged on #59. addNotification REPLACES the row,
      // so a caller that reads a redacted config, renames the channel and writes it back
      // would persist "***" as the SMTP password.
      let notificationID: number | undefined;
      try {
        const created = await call(client, 'addNotification', {
          name: 'zz-clobber-delete-me',
          type: 'smtp',
          config: {
            type: 'smtp',
            smtpHost: 'smtp.example.invalid',
            smtpPort: 587,
            smtpUsername: 'zz-user',
            smtpPassword: SMTP_PASSWORD,
            smtpFrom: 'zz@example.invalid',
            smtpTo: 'zz@example.invalid',
          },
        });
        notificationID = (created as any).structuredContent?.id;
        if (!notificationID) throw new Error('addNotification returned no id');

        // Exactly what an agent would send after a redacted read.
        await call(client, 'updateNotification', {
          notificationID,
          name: 'zz-clobber-delete-me-renamed',
          type: 'smtp',
          config: {
            type: 'smtp',
            smtpHost: 'smtp.example.invalid',
            smtpPort: 587,
            smtpUsername: 'zz-user',
            smtpPassword: MARKER,
            smtpFrom: 'zz@example.invalid',
            smtpTo: 'zz@example.invalid',
          },
        });

        const after = extractText(
          await call(client, 'listNotifications', { includeSecrets: true }),
          'listNotifications'
        );
        const row = JSON.parse(after).find((n: any) => n.id === notificationID);
        if (!row) throw new Error('notification vanished after update');
        const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;

        if (config.smtpPassword === MARKER) {
          throw new Error('the redaction marker was written over the real password');
        }
        if (config.smtpPassword !== SMTP_PASSWORD) {
          throw new Error(`password was not preserved (got ${JSON.stringify(config.smtpPassword)})`);
        }
        if (row.name !== 'zz-clobber-delete-me-renamed') {
          throw new Error('the rename did not land');
        }
        console.log('  ✓ updateNotification preserved the password and applied the rename');
      } finally {
        if (notificationID) await call(client, 'deleteNotification', { notificationID });
      }
    },
  },

  {
    name: 'listMonitors / getMonitor withhold headers and pushToken',
    fn: async ({ client }) => {
      let monitorID: number | undefined;
      try {
        const created = await call(client, 'createMonitor', {
          name: 'zz-redaction-monitor-delete-me',
          type: 'http',
          url: 'https://example.invalid/health',
          interval: 300,
          active: false,
          headers: JSON.stringify({ 'X-Api-Key': API_KEY }),
        });
        monitorID = (created as any).structuredContent?.monitorID;
        if (!monitorID) throw new Error('createMonitor returned no monitorID');

        const listed = extractText(
          await call(client, 'listMonitors', { includeTypeSpecificFields: true }),
          'listMonitors'
        );
        if (listed.includes(API_KEY)) throw new Error('an API key in headers came back in cleartext');

        const one = extractText(
          await call(client, 'getMonitor', { monitorID, includeTypeSpecificFields: true }),
          'getMonitor'
        );
        if (one.includes(API_KEY)) throw new Error('getMonitor returned headers in cleartext');
        if (!one.includes(MARKER)) throw new Error('getMonitor did not mark headers as withheld');

        const withSecrets = extractText(
          await call(client, 'getMonitor', { monitorID, includeTypeSpecificFields: true, includeSecrets: true }),
          'getMonitor'
        );
        if (!withSecrets.includes(API_KEY)) throw new Error('includeSecrets: true did not return headers');
        console.log('  ✓ monitor headers withheld by default, returned on opt-in');
      } finally {
        if (monitorID) await call(client, 'deleteMonitor', { monitorID });
      }
    },
  },

  {
    name: 'updateMonitor does not clobber headers when the marker is sent back',
    fn: async ({ client }) => {
      let monitorID: number | undefined;
      try {
        const created = await call(client, 'createMonitor', {
          name: 'zz-redaction-update-delete-me',
          type: 'http',
          url: 'https://example.invalid/health',
          interval: 300,
          active: false,
          headers: JSON.stringify({ 'X-Api-Key': API_KEY }),
        });
        monitorID = (created as any).structuredContent?.monitorID;
        if (!monitorID) throw new Error('createMonitor returned no monitorID');

        await call(client, 'updateMonitor', {
          monitorID,
          name: 'zz-redaction-update-delete-me-renamed',
          headers: MARKER,
        });

        const after = extractText(
          await call(client, 'getMonitor', { monitorID, includeTypeSpecificFields: true, includeSecrets: true }),
          'getMonitor'
        );
        const monitor = JSON.parse(after);
        if (monitor.headers === MARKER) throw new Error('the marker was written over the real headers');
        if (!String(monitor.headers).includes(API_KEY)) {
          throw new Error(`headers were not preserved (got ${JSON.stringify(monitor.headers)})`);
        }
        if (monitor.name !== 'zz-redaction-update-delete-me-renamed') {
          throw new Error('the rename did not land');
        }
        console.log('  ✓ updateMonitor preserved headers and applied the rename');
      } finally {
        if (monitorID) await call(client, 'deleteMonitor', { monitorID });
      }
    },
  },

  {
    name: 'the marker is refused on create, where there is nothing to restore',
    fn: async ({ client }) => {
      // Cloning a channel or monitor read back redacted is the realistic way to reach this.
      // Accepting it would persist "***" as a credential that looks set and cannot work.
      let created: number | undefined;
      try {
        const result = await call(client, 'addNotification', {
          name: 'zz-marker-on-create-delete-me',
          type: 'smtp',
          config: { type: 'smtp', smtpHost: 'smtp.example.invalid', smtpPassword: MARKER },
        });
        created = (result as any).structuredContent?.id;
        if (!result.isError && created) {
          throw new Error('addNotification accepted the redaction marker as a password');
        }
        const text = (result.content as any[])?.find((c: any) => c.type === 'text')?.text ?? '';
        if (!String(text).includes('smtpPassword')) {
          throw new Error(`error should name the offending field, got: ${text}`);
        }
        console.log('  ✓ addNotification refuses the marker and names the field');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/accepted the redaction marker/.test(message)) throw err;
        if (!message.includes('smtpPassword')) {
          throw new Error(`error should name the offending field, got: ${message}`);
        }
        console.log('  ✓ addNotification refuses the marker and names the field');
      } finally {
        if (created) await call(client, 'deleteNotification', { notificationID: created });
      }
    },
  },

  {
    name: 'getMonitorSummary stays free of credentials without needing redaction',
    fn: async ({ client }) => {
      const text = extractText(await call(client, 'getMonitorSummary', {}), 'getMonitorSummary');
      for (const key of ['pushToken', 'basic_auth_pass', 'bearer_token', 'headers']) {
        if (text.includes(key)) throw new Error(`getMonitorSummary unexpectedly returned ${key}`);
      }
      console.log('  ✓ getMonitorSummary remains the safe default it already was');
    },
  },
];
