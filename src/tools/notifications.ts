import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { NotificationSchema } from '../types/index.js';
import { redactNotifications, rehydrateSecrets } from '../redact.js';
import { presentNotification } from '../utils/notification-view.js';
import { requiredId } from './schema.js';
import {
  COMMON_NOTIFICATION_FIELDS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_FIELDS,
  findNotificationType,
  miscasedNotificationFields,
  miscasedNotificationType,
  missingNotificationFields,
} from '../notifications/types.js';

/**
 * What is wrong with a channel of `type` holding `config`, as far as this server can tell, or
 * undefined. Uptime Kuma saves anything, so these are the mistakes that produce a channel which
 * looks fine and never sends. A type this server has no field table for is let through.
 */
function notificationProblem(type: unknown, config: Record<string, unknown>): string | undefined {
  if (typeof type !== 'string') return undefined;
  const exact = miscasedNotificationType(type);
  if (exact !== undefined) {
    return `notification type '${type}' does not exist — type names are case-sensitive. Did you mean '${exact}'?`;
  }
  const miscased = Object.entries(miscasedNotificationFields(type, config));
  if (miscased.length > 0) {
    return (
      `field names are case-sensitive and Uptime Kuma ignores a misspelled one: ` +
      `${miscased.map(([given, right]) => `'${right}' for '${given}'`).join(', ')}.`
    );
  }
  const missing = missingNotificationFields(type, config);
  if (missing.length > 0) {
    return (
      `a ${type} notification needs ${missing.join(', ')}. ` +
      `Call getNotificationTypeFields { "type": "${type}" } for what each field means.`
    );
  }
  return undefined;
}

/**
 * A stored channel's config as an object. Uptime Kuma keeps it as a JSON string (type and
 * provider fields included); anything unreadable is treated as empty.
 */
function storedNotificationConfig(stored: Record<string, unknown>): Record<string, unknown> {
  const raw = stored['config'];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Unreadable: treated as empty.
    }
    return {};
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The notification channel tools. */
export function registerNotificationTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  const NotificationFieldDescription = z.object({ name: z.string(), description: z.string() });

  server.registerTool(
    'listNotificationTypes',
    {
      title: 'List Notification Types',
      description:
        'Returns every notification type Uptime Kuma supports (Slack, email, ntfy, Telegram, webhooks and about a hundred more) with the exact, case-sensitive type string createNotification takes. An older Uptime Kuma may lack the newest ones. For the fields a type takes, call getNotificationTypeFields.',
      inputSchema: {},
      outputSchema: {
        types: z
          .array(
            z.object({
              type: z.string().describe('The value to pass as type. Case-sensitive.'),
              name: z.string().describe('The name Uptime Kuma shows for it'),
              fieldsDocumented: z.boolean().describe('Whether getNotificationTypeFields can describe its fields'),
            })
          )
          .describe('Array of notification types'),
        count: z.number(),
      },
    },
    async () => {
      const types = NOTIFICATION_TYPES.map((t) => ({ ...t, fieldsDocumented: t.type in NOTIFICATION_TYPE_FIELDS }));
      return {
        content: [{ type: 'text', text: JSON.stringify(types) }],
        structuredContent: { types, count: types.length },
      };
    }
  );

  server.registerTool(
    'getNotificationTypeFields',
    {
      title: 'Get Notification Type Fields',
      description:
        'Describes the config fields one notification type takes: which are required, which are optional and what each means. Call it before createNotification, or before updateNotification changes a type or its settings: field names are case-sensitive and Uptime Kuma saves a misspelled one without complaint. The common types are covered; for the rest it says so, and their field names can be copied from an existing channel in listNotifications. Type names come from listNotificationTypes.',
      inputSchema: {
        type: z
          .string()
          .describe('The notification type, e.g. slack, smtp, PagerDuty. Use listNotificationTypes for all options.'),
      },
      outputSchema: {
        type: z.string(),
        name: z.string().describe('The name Uptime Kuma shows for this type'),
        documented: z.boolean().describe('false when this server has no field table for the type'),
        required: z
          .array(NotificationFieldDescription)
          .describe('Fields the type cannot send without. A create without them is refused.'),
        optional: z.array(NotificationFieldDescription).describe('Other fields the type reads'),
        notes: z.array(z.string()),
        commonFields: z
          .array(z.string())
          .describe('Arguments of createNotification / updateNotification that every type takes, outside config'),
      },
    },
    async ({ type }) => {
      const known = findNotificationType(type);
      if (!known) {
        const exact = miscasedNotificationType(type);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown notification type '${type}'. ` +
            (exact !== undefined ? `Type names are case-sensitive: did you mean '${exact}'? ` : '') +
            'listNotificationTypes gives the valid ones.'
        );
      }

      const fields = NOTIFICATION_TYPE_FIELDS[type];
      const structuredContent = {
        type,
        name: known.name,
        documented: fields !== undefined,
        required: fields?.required ?? [],
        optional: fields?.optional ?? [],
        notes: fields
          ? [...(fields.notes ?? []), 'All of these go inside config. Other fields in config are stored as given.']
          : [
              'This server has no field table for this type, so createNotification stores config as given and checks nothing. ' +
                "The field names are those of Uptime Kuma's own form for the type: copy them from an existing channel of this type in listNotifications, or create the channel in the Uptime Kuma web UI.",
            ],
        commonFields: COMMON_NOTIFICATION_FIELDS,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
  );

  server.registerTool(
    'listNotifications',
    {
      title: 'List Notifications',
      description:
        'Returns every notification channel (Slack, ntfy, Discord, email, webhooks and so on) with its id, type and type-specific config. Credentials in config are withheld unless includeSecrets is set, and redactedConfigKeys names the withheld fields. To attach a channel to a monitor, pass its id in notificationIDList of createMonitor / updateMonitor.',
      inputSchema: {
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        notifications: z
          .array(NotificationSchema)
          .describe(
            'Array of notification channel configurations. By default `config` is reduced to its non-secret fields and `redactedConfigKeys` names what was withheld.'
          ),
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
    'createNotification',
    {
      title: 'Create Notification',
      description:
        "Creates a notification channel from a name, a type and that type's config fields. Choose the type with listNotificationTypes, then call getNotificationTypeFields for its field names: both are case-sensitive. A create that lacks a documented required field is refused rather than saved as a channel that never sends. Attach the channel with notificationIDList on createMonitor / updateMonitor, or pass applyExisting. A repeat call creates a second channel; to change one use updateNotification.",
      inputSchema: {
        name: z.string().describe('Human-readable name for this notification channel'),
        type: z
          .string()
          .describe('Notification type, e.g. slack, smtp, PagerDuty. Use listNotificationTypes for all options.'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Attach this channel to every existing monitor now'),
        config: z
          .record(z.string(), z.unknown())
          .describe(
            'The fields of this notification type, e.g. {"slackwebhookURL": "https://hooks.slack.com/…"} for slack. Call getNotificationTypeFields for the names.'
          ),
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

        // After the marker check: a "***" credential is the more specific mistake to report.
        const problem = notificationProblem(type, config);
        if (problem) throw new Error(problem);

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
      description:
        'Updates an existing notification channel. Only what you pass changes: name, isDefault and each field in config are merged onto the stored channel, so a rename keeps the credentials. A secret sent back as "***" keeps its stored value. Changing type discards the stored config, so pass the new type\'s full config with it. Find the ID with listNotifications; to add a channel use createNotification, and to remove one, deleteNotification.',
      inputSchema: {
        notificationID: requiredId('The ID of the notification to update'),
        name: z.string().optional().describe('New human-readable name. Omit to keep the current one.'),
        type: z
          .string()
          .optional()
          .describe(
            'New notification type. Omit to keep the current one. A different type discards the stored config.'
          ),
        isDefault: z
          .boolean()
          .optional()
          .describe('Enable by default for new monitors. Omit to keep the current value.'),
        applyExisting: z
          .boolean()
          .optional()
          .describe('Attach this channel to every existing monitor now. One-off: it is not stored.'),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Type-specific configuration fields to change. Fields left out keep their stored value, unless type changes.'
          ),
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
        // Uptime Kuma's Notification.save() REPLACES the row from what it is sent: the name, the
        // default flag, and the whole config (JSON.stringify of this object, `type` included).
        // Passing only the caller's fields through meant a rename erased the channel's type and
        // every provider setting. So the stored channel is the base and the caller's fields go
        // on top — the same merge updateDockerHost does.
        const stored = client
          .getNotificationList()
          .find((n) => (n as Record<string, unknown>)['id'] === notificationID) as Record<string, unknown> | undefined;
        if (!stored) {
          throw new Error(`Notification ${notificationID} not found — call listNotifications to see available IDs`);
        }
        const storedConfig = storedNotificationConfig(stored);

        // A different provider shares no settings with the old one. Carrying them over would
        // leave the old provider's fields, credentials among them, in a config that no longer
        // uses them.
        const storedType = storedConfig['type'];
        const requestedType = type ?? config?.['type'];
        const typeChanged = requestedType !== undefined && storedType !== undefined && requestedType !== storedType;

        const notification: Record<string, unknown> = {
          ...(typeChanged ? {} : storedConfig),
          ...config,
        };
        notification['name'] = name ?? config?.['name'] ?? storedConfig['name'] ?? stored['name'];
        if (requestedType !== undefined || storedType !== undefined) notification['type'] = requestedType ?? storedType;
        notification['isDefault'] =
          isDefault ?? config?.['isDefault'] ?? storedConfig['isDefault'] ?? stored['isDefault'] ?? false;
        // One-off, never stored: only ever what this call asks for.
        notification['applyExisting'] = applyExisting ?? false;

        // A new type gets the checks a create gets. Under an unchanged type only the fields this
        // call passes are checked for spelling, so a channel made before these checks existed
        // can still be renamed.
        if (typeChanged) {
          const problem = notificationProblem(requestedType, notification);
          if (problem) throw new Error(problem);
        } else if (typeof storedType === 'string' && config) {
          const miscased = Object.entries(miscasedNotificationFields(storedType, { ...storedConfig, ...config }));
          const passed = miscased.filter(([given]) => given in config);
          if (passed.length > 0) {
            throw new Error(
              `field names are case-sensitive and Uptime Kuma ignores a misspelled one: ` +
                `${passed.map(([given, right]) => `'${right}' for '${given}'`).join(', ')}.`
            );
          }
        }

        // Issue #59. The read-edit-write loop writes back whatever the caller was shown — and
        // after redaction that is `smtpPassword: "***"`. Restore the stored value instead. After
        // a type change there is nothing to restore from, so the marker is refused.
        const { preserved, missing } = rehydrateSecrets(notification, typeChanged ? undefined : storedConfig);
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
        if (typeChanged) {
          text += `\n\nType changed from ${String(storedType)} to ${String(requestedType)}: the ${String(storedType)} settings were not carried over.`;
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
      description:
        'Permanently deletes a notification channel. Monitors that used it stop alerting through it, and this cannot be undone. To change a channel instead, use updateNotification. Find the ID with listNotifications.',
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
  server.registerTool(
    'testNotification',
    {
      title: 'Test Notification',
      description:
        'Sends a test message ("<channel name> Testing") through a saved notification channel, as the Test button in Uptime Kuma does, to check its settings work. It really is delivered, to Slack, email or wherever the channel points, so do not repeat it without reason. Nothing is saved. Find the ID with listNotifications.',
      inputSchema: {
        notificationID: requiredId('The ID of the channel to test'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional().describe('The provider\'s answer, e.g. "Sent Successfully."'),
      },
    },
    async ({ notificationID }) => {
      await authenticateClient();

      try {
        const stored = client
          .getNotificationList()
          .find((n) => (n as Record<string, unknown>)['id'] === notificationID) as Record<string, unknown> | undefined;
        if (!stored) {
          throw new Error(`Notification ${notificationID} not found — call listNotifications to see available IDs`);
        }
        // testNotification takes the whole config, as the web UI's form holds it, not an ID.
        const config = storedNotificationConfig(stored);
        const response = await client.testNotification({
          ...config,
          name: config['name'] ?? stored['name'],
          type: config['type'] ?? stored['type'],
        });
        return {
          content: [
            { type: 'text', text: `Test notification sent through channel ${notificationID}: ${response.msg ?? 'ok'}` },
          ],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to send the test notification: ${errorMessage}`);
      }
    }
  );
}
