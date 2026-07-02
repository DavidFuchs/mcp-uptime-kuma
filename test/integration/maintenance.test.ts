import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText, extractID } from './helpers.js';

/**
 * Integration tests for maintenance window operations.
 * Covers: getMaintenanceWindows, createMaintenance, deleteMaintenance
 *
 * Issue coverage:
 * - #37: dateRange allows null in recurring maintenance windows
 */

export const maintenanceTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'getMaintenanceWindows returns array',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'getMaintenanceWindows', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'getMaintenanceWindows');
      const parsed = JSON.parse(text);
      // May be wrapped in { maintenanceWindows: [...] } or be a direct array
      const windows = Array.isArray(parsed) ? parsed : parsed.maintenanceWindows;
      if (!Array.isArray(windows)) throw new Error('Expected array of maintenance windows');
      console.log(`  ✓ getMaintenanceWindows: ${windows.length} windows`);
    },
  },
  {
    name: 'createMaintenance → getMaintenanceWindows → deleteMaintenance lifecycle',
    fn: async ({ client }) => {
      // Create a single-strategy maintenance window (description is required by Kuma DB)
      const startDate = new Date(Date.now() + 86400000).toISOString();
      const endDate = new Date(Date.now() + 90000000).toISOString();
      const createResult = await client.callTool({
        name: 'createMaintenance',
        arguments: {
          title: 'Integration Test - Single Window',
          description: 'Test maintenance window for integration tests',
          strategy: 'single',
          dateRange: [startDate, endDate],
          timeRange: [{ hours: 0, minutes: 0 }, { hours: 23, minutes: 59 }],
          active: true,
        },
      }) as CallToolResult;
      const maintenanceID = extractID(createResult, 'createMaintenance', 'maintenanceID');

      try {
        // List and find it
        const listResult = await client.callTool({ name: 'getMaintenanceWindows', arguments: {} }) as CallToolResult;
        const listText = extractText(listResult, 'getMaintenanceWindows');
        const parsed = JSON.parse(listText);
        const windows = Array.isArray(parsed) ? parsed : parsed.maintenanceWindows;
        const found = windows.find((w: any) => w.title === 'Integration Test - Single Window');
        if (!found) throw new Error('Created maintenance window not in listing');

        console.log(`  ✓ createMaintenance lifecycle: ID ${maintenanceID}`);
      } finally {
        await client.callTool({ name: 'deleteMaintenance', arguments: { maintenanceID } });
        console.log(`  ✓ deleteMaintenance: cleaned up ID ${maintenanceID}`);
      }
    },
  },
  {
    name: '#37: recurring-interval maintenance with dateRange [null] does not error',
    fn: async ({ client }) => {
      // Create a recurring-interval maintenance window
      // Uptime Kuma returns dateRange: [null] for these
      const createResult = await client.callTool({
        name: 'createMaintenance',
        arguments: {
          title: 'Integration Test - Issue 37 Recurring',
          description: 'Test recurring maintenance for issue 37',
          strategy: 'recurring-interval',
          intervalDay: 1,
          dateRange: [
            new Date(Date.now() - 86400000).toISOString(),
            new Date(Date.now() + 86400000 * 365).toISOString(),
          ],
          timeRange: [{ hours: 3, minutes: 0 }, { hours: 4, minutes: 0 }],
          active: true,
        },
      }) as CallToolResult;
      const maintenanceID = extractID(createResult, 'createMaintenance', 'maintenanceID');

      try {
        // The critical test: getMaintenanceWindows must handle dateRange: [null]
        // without a schema validation error (-32602)
        const listResult = await client.callTool({ name: 'getMaintenanceWindows', arguments: {} }) as CallToolResult;
        const listText = extractText(listResult, 'getMaintenanceWindows');
        const parsed = JSON.parse(listText);
        const windows = Array.isArray(parsed) ? parsed : parsed.maintenanceWindows;

        const recurring = windows.find((w: any) => w.title === 'Integration Test - Issue 37 Recurring');
        if (!recurring) throw new Error('Recurring maintenance window not found in listing');

        // dateRange should be [null] or similar — the key thing is no error was thrown
        console.log(`  ✓ #37: recurring maintenance listed successfully (dateRange: ${JSON.stringify(recurring.dateRange)})`);
      } finally {
        await client.callTool({ name: 'deleteMaintenance', arguments: { maintenanceID } });
      }
    },
  },
];
