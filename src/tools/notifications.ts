import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { NotificationSchema } from '../types/index.js';
import { redactNotifications, rehydrateSecrets } from '../redact.js';
import { presentNotification } from '../utils/notification-view.js';
import { requiredId } from './schema.js';

/** The notification channel tools. */
export function registerNotificationTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  server.registerTool(
    'listNotifications',
    {
      title: 'List Notifications',
      description: 'Returns all configured notification channels (Slack, ntfy, Discord, email, webhooks, etc.), each with its `type` and its type-specific settings in `config`. To attach a channel to a monitor you only need its id — the credentials in `config` are withheld by default and the names of the withheld fields are listed in `redactedConfigKeys`.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        notifications: z.array(NotificationSchema).describe('Array of notification channel configurations. By default `config` is reduced to its non-secret fields and `redactedConfigKeys` names what was withheld.'),
        count: z.number(),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const raw = client.getNotificationList();
        // getNotificationList() returns references into notificationListCache, so this
        // must not mutate — redactNotifications builds new objects.
        const rows = wantsSecrets(includeSecrets)
          ? (raw as unknown as Record<string, unknown>[])
          : redactNotifications(raw as unknown as Record<string, unknown>[]);
        const notifications = rows.map(presentNotification);
        return {
          content: [{ type: 'text', text: JSON.stringify(notifications) }],
          structuredContent: { notifications, count: notifications.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list notifications: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addNotification',
    {
      title: 'Add Notification',
      description: 'Creates a new notification channel. The configuration fields depend on the notification type (e.g., for slack: webhookURL; for ntfy: ntfyTopic, ntfyServerUrl; for discord: discordWebhookUrl).',
      inputSchema: {
        name: z.string().describe('Human-readable name for this notification channel'),
        type: z.string().describe('Notification type (e.g. slack, ntfy, discord, telegram, webhook, smtp)'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Apply this notification to all existing monitors now'),
        config: z.record(z.string(), z.unknown()).describe('Type-specific configuration fields (e.g. webhookURL for slack, ntfyTopic for ntfy)'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, type, isDefault, applyExisting, config }) => {
      await authenticateClient();

      try {
        const notification = { name, type, isDefault, applyExisting, ...config };

        // Issue #59: as with createMonitor, there is no stored value to restore on a create,
        // so the redaction marker is refused rather than saved as the credential. This is the
        // path you hit cloning an existing channel from a redacted listNotifications.
        const markers = rehydrateSecrets(notification as Record<string, unknown>, undefined).missing;
        if (markers.length > 0) {
          throw new Error(
            `"***" is the redaction marker, not a credential — pass the real value for ${markers.join(', ')}. ` +
            'To copy an existing channel, read it with listNotifications { includeSecrets: true }.'
          );
        }

        const response = await client.addNotification(notification as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: response.msg || `Notification created with ID ${response.id}` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add notification: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateNotification',
    {
      title: 'Update Notification',
      description: 'Updates an existing notification channel. Use listNotifications to find the notification ID.',
      inputSchema: {
        notificationID: requiredId('The ID of the notification to update'),
        name: z.string().optional().describe('Human-readable name'),
        type: z.string().optional().describe('Notification type'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Apply to all existing monitors now'),
        config: z.record(z.string(), z.unknown()).optional().describe('Type-specific configuration fields to update'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ notificationID, name, type, isDefault, applyExisting, config }) => {
      await authenticateClient();

      try {
        const notification: Record<string, unknown> = { ...config };
        if (name !== undefined) notification['name'] = name;
        if (type !== undefined) notification['type'] = type;
        if (isDefault !== undefined) notification['isDefault'] = isDefault;
        if (applyExisting !== undefined) notification['applyExisting'] = applyExisting;

        // Issue #59, and the sharper edge of it. Uptime Kuma's addNotification REPLACES the
        // row rather than merging, so the read-edit-write loop writes back whatever the
        // caller was shown — and after redaction that is `smtpPassword: "***"`. Renaming a
        // channel would otherwise destroy the credential that makes it work.
        const stored = client
          .getNotificationList()
          .find((n) => (n as Record<string, unknown>)['id'] === notificationID) as
          | Record<string, unknown>
          | undefined;
        let storedConfig: Record<string, unknown> | undefined;
        const rawStored = stored?.['config'];
        if (typeof rawStored === 'string') {
          try {
            const parsed: unknown = JSON.parse(rawStored);
            if (parsed && typeof parsed === 'object') storedConfig = parsed as Record<string, unknown>;
          } catch {
            storedConfig = undefined;
          }
        } else if (rawStored && typeof rawStored === 'object') {
          storedConfig = rawStored as Record<string, unknown>;
        }

        const { preserved, missing } = rehydrateSecrets(notification, storedConfig);
        if (missing.length > 0) {
          throw new Error(
            `Cannot write the redaction marker "***" to ${missing.join(', ')} — notification ${notificationID} has ` +
            'no stored value to restore. Pass the real value, or call listNotifications with includeSecrets ' +
            'to read the current one.'
          );
        }

        const response = await client.addNotification(notification, notificationID);
        let text = response.msg || `Notification ${notificationID} updated`;
        if (preserved.length > 0) {
          text += `\n\nKept the existing value for ${preserved.join(', ')} — "***" was sent, which is the redaction marker, not a credential.`;
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update notification: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteNotification',
    {
      title: 'Delete Notification',
      description: 'Permanently deletes a notification channel. Monitors that used this channel will no longer send alerts through it.',
      inputSchema: {
        notificationID: requiredId('The ID of the notification to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ notificationID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteNotification(notificationID);
        return {
          content: [{ type: 'text', text: response.msg || `Notification ${notificationID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete notification: ${errorMessage}`);
      }
    }
  );
}
