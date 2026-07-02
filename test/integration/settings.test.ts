import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText } from './helpers.js';

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
        'getMonitor', 'listMonitors', 'listMonitorTypes', 'getMonitorSummary',
        'createMonitor', 'updateMonitor', 'deleteMonitor',
        'pauseMonitor', 'resumeMonitor',
        'getHeartbeats', 'listHeartbeats',
        'getSettings',
        'listNotifications',
        'listDockerHosts',
        'listTags', 'addTag', 'deleteTag',
        'getMaintenanceWindows', 'createMaintenance',
        'listStatusPages',
      ];

      const missing = expectedTools.filter(t => !tools.tools.find(tool => tool.name === t));
      if (missing.length > 0) {
        throw new Error(`Missing expected tools: ${missing.join(', ')}`);
      }

      console.log(`  ✓ listTools: ${tools.tools.length} tools (all expected tools present)`);
    },
  },
  {
    name: 'getSettings returns server configuration',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'getSettings', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'getSettings');
      const settings = JSON.parse(text);
      if (typeof settings !== 'object' || settings === null) throw new Error('Expected object');
      console.log(`  ✓ getSettings: timezone=${settings.serverTimezone || 'n/a'}`);
    },
  },
];
