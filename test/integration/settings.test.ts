import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractText } from './helpers.js';

/**
 * Integration tests for settings and general server operations.
 * Covers: getSettings, tool discovery
 */

export const settingsTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listTools returns expected tools',
    fn: async ({ client }) => {
      const tools = await client.listTools();
      if (tools.tools.length === 0) throw new Error('No tools found');

      const expectedTools = [
        'getMonitor',
        'listMonitors',
        'listMonitorTypes',
        'getMonitorTypeFields',
        'getMonitorSummary',
        'createMonitor',
        'updateMonitor',
        'deleteMonitor',
        'setMonitorActive',
        'listHeartbeats',
        'getSettings',
        'updateSettings',
        'listNotifications',
        'listNotificationTypes',
        'getNotificationTypeFields',
        'listDockerHosts',
        'listTags',
        'createTag',
        'updateTag',
        'deleteTag',
        'listMaintenanceWindows',
        'createMaintenance',
        'listStatusPages',
      ];

      const missing = expectedTools.filter((t) => !tools.tools.find((tool) => tool.name === t));
      if (missing.length > 0) {
        throw new Error(`Missing expected tools: ${missing.join(', ')}`);
      }

      console.log(`  ✓ listTools: ${tools.tools.length} tools (all expected tools present)`);
    },
  },
  {
    name: 'getSettings returns server configuration',
    fn: async ({ client }) => {
      const result = (await client.callTool({ name: 'getSettings', arguments: {} })) as CallToolResult;
      const text = extractText(result, 'getSettings');
      const settings = JSON.parse(text);
      if (typeof settings !== 'object' || settings === null) throw new Error('Expected object');
      console.log(`  ✓ getSettings: timezone=${settings.serverTimezone || 'n/a'}`);
    },
  },
  {
    name: 'updateSettings changes one setting and keeps the rest',
    fn: async ({ client }) => {
      const read = async () =>
        (
          (await client.callTool({ name: 'getSettings', arguments: {} })) as CallToolResult & {
            structuredContent: { settings: Record<string, unknown> };
          }
        ).structuredContent.settings;

      const before = await read();
      const original = typeof before.keepDataPeriodDays === 'number' ? before.keepDataPeriodDays : 180;
      const target = original === 42 ? 43 : 42;

      try {
        const result = (await client.callTool({
          name: 'updateSettings',
          arguments: { keepDataPeriodDays: target },
        })) as CallToolResult;
        if (result.isError) throw new Error(`updateSettings failed: ${extractText(result, 'updateSettings')}`);

        const after = await read();
        if (after.keepDataPeriodDays !== target) {
          throw new Error(`keepDataPeriodDays is ${after.keepDataPeriodDays}, expected ${target}`);
        }
        for (const key of ['serverTimezone', 'entryPage', 'primaryBaseURL', 'trustProxy', 'disableAuth']) {
          if (key in before && JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
            throw new Error(`${key} changed from ${JSON.stringify(before[key])} to ${JSON.stringify(after[key])}`);
          }
        }
      } finally {
        await client.callTool({ name: 'updateSettings', arguments: { keepDataPeriodDays: original } });
      }
      console.log(`  ✓ updateSettings: keepDataPeriodDays ${original} → ${target} → ${original}, others kept`);
    },
  },
];
