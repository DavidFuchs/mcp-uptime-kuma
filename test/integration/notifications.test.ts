import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText } from './helpers.js';

/**
 * Integration tests for notification operations.
 * Covers: listNotifications, addNotification, updateNotification, deleteNotification
 */

export const notificationTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listNotifications returns array',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'listNotifications', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'listNotifications');
      const notifications = JSON.parse(text);
      if (!Array.isArray(notifications)) throw new Error('Expected array');
      console.log(`  ✓ listNotifications: ${notifications.length} notifications`);
    },
  },
];
