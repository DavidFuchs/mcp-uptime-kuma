import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractText } from './helpers.js';

/**
 * Integration tests for notification operations.
 * Covers: listNotifications, createNotification, updateNotification, deleteNotification
 */

export const notificationTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listNotifications returns array',
    fn: async ({ client }) => {
      const result = (await client.callTool({ name: 'listNotifications', arguments: {} })) as CallToolResult;
      const text = extractText(result, 'listNotifications');
      const notifications = JSON.parse(text);
      if (!Array.isArray(notifications)) throw new Error('Expected array');
      console.log(`  ✓ listNotifications: ${notifications.length} notifications`);
    },
  },
  {
    name: 'updateNotification with only a name keeps the type and the provider settings',
    fn: async ({ client }) => {
      // Uptime Kuma's Notification.save() replaces the row from what it is sent, so a rename
      // passed straight through used to erase the type and every provider setting.
      const created = (await client.callTool({
        name: 'createNotification',
        arguments: {
          name: 'zz-partial-update-delete-me',
          type: 'webhook',
          isDefault: false,
          config: { webhookURL: 'https://example.invalid/hook', webhookContentType: 'json' },
        },
      })) as CallToolResult;
      extractText(created, 'createNotification');
      const notificationID = (created.structuredContent as { id?: number } | undefined)?.id;
      if (!notificationID) throw new Error('createNotification returned no id');

      try {
        const updated = (await client.callTool({
          name: 'updateNotification',
          arguments: { notificationID, name: 'zz-partial-update-renamed' },
        })) as CallToolResult;
        extractText(updated, 'updateNotification');

        const listed = JSON.parse(
          extractText(
            (await client.callTool({
              name: 'listNotifications',
              arguments: { includeSecrets: true },
            })) as CallToolResult,
            'listNotifications'
          )
        ) as Array<{ id: number; name: string; type?: string; config: Record<string, unknown> }>;
        const row = listed.find((n) => n.id === notificationID);
        if (!row) throw new Error('notification vanished after update');
        if (row.name !== 'zz-partial-update-renamed') throw new Error('the rename did not land');
        if (row.type !== 'webhook') throw new Error(`the type was lost (got ${JSON.stringify(row.type)})`);
        if (row.config.webhookURL !== 'https://example.invalid/hook') {
          throw new Error(`the provider settings were lost (got ${JSON.stringify(row.config)})`);
        }
        console.log('  ✓ updateNotification: rename kept the type and webhookURL');
      } finally {
        await client.callTool({ name: 'deleteNotification', arguments: { notificationID } });
      }
    },
  },
  {
    name: 'testNotification makes Uptime Kuma try to deliver through the stored channel',
    fn: async ({ client }) => {
      // Nothing listens on port 1, so the provider's own connection error shows that Uptime Kuma
      // really tried to send, using the stored webhook URL.
      const created = (await client.callTool({
        name: 'createNotification',
        arguments: {
          name: 'zz-test-notification-delete-me',
          type: 'webhook',
          isDefault: false,
          config: { webhookURL: 'http://127.0.0.1:1/hook', webhookContentType: 'json' },
        },
      })) as CallToolResult;
      extractText(created, 'createNotification');
      const notificationID = (created.structuredContent as { id?: number } | undefined)?.id;
      if (!notificationID) throw new Error('createNotification returned no id');

      try {
        const result = (await client.callTool({
          name: 'testNotification',
          arguments: { notificationID },
        })) as CallToolResult;
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
        if (!result.isError) throw new Error(`expected the delivery to fail, got: ${text}`);
        if (!/ECONNREFUSED|connect|127.0.0.1/i.test(text)) {
          throw new Error(`expected a connection error from the webhook, got: ${text}`);
        }
        console.log('  ✓ testNotification: Uptime Kuma tried the stored webhook and reported its error');
      } finally {
        await client.callTool({ name: 'deleteNotification', arguments: { notificationID } });
      }
    },
  },
];
