import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText, extractID } from './helpers.js';

/**
 * Integration tests for maintenance window operations.
 * Covers: getMaintenanceWindows, createMaintenance, updateMaintenance,
 *         pauseMaintenance, resumeMaintenance, deleteMaintenance
 *
 * Issue coverage:
 * - #37: dateRange allows null in recurring maintenance windows
 */

async function listWindows(client: Client): Promise<any[]> {
  const result = await client.callTool({ name: 'getMaintenanceWindows', arguments: {} }) as CallToolResult;
  const parsed = JSON.parse(extractText(result, 'getMaintenanceWindows'));
  // May be wrapped in { maintenanceWindows: [...] } or be a direct array
  const windows = Array.isArray(parsed) ? parsed : parsed.maintenanceWindows;
  if (!Array.isArray(windows)) throw new Error('Expected array of maintenance windows');
  return windows;
}

async function findWindow(client: Client, maintenanceID: number): Promise<any> {
  const found = (await listWindows(client)).find((w) => w.id === maintenanceID);
  if (!found) throw new Error(`Maintenance window ${maintenanceID} not in listing`);
  return found;
}

/** Deletes a window and fails loudly if that did not work, so a test cannot leak one. */
async function deleteWindow(client: Client, maintenanceID: number): Promise<void> {
  const result = await client.callTool({ name: 'deleteMaintenance', arguments: { maintenanceID } }) as CallToolResult;
  extractText(result, 'deleteMaintenance');
}

async function createPushMonitor(client: Client, name: string): Promise<number> {
  const result = await client.callTool({
    name: 'createMonitor',
    arguments: { name, type: 'push', interval: 60 },
  }) as CallToolResult;
  return extractID(result, 'createMonitor', 'monitorID');
}

const sameIDs = (a: number[], b: number[]) =>
  JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

export const maintenanceTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'getMaintenanceWindows returns array',
    fn: async ({ client }) => {
      const windows = await listWindows(client);
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
        const found = await findWindow(client, maintenanceID);
        if (found.title !== 'Integration Test - Single Window') throw new Error(`Unexpected title ${found.title}`);
        console.log(`  ✓ createMaintenance lifecycle: ID ${maintenanceID}`);
      } finally {
        await deleteWindow(client, maintenanceID);
        console.log(`  ✓ deleteMaintenance: cleaned up ID ${maintenanceID}`);
      }

      if ((await listWindows(client)).some((w) => w.id === maintenanceID)) {
        throw new Error(`Maintenance window ${maintenanceID} still listed after deleteMaintenance`);
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
        const recurring = await findWindow(client, maintenanceID);

        // dateRange should be [null] or similar — the key thing is no error was thrown
        console.log(`  ✓ #37: recurring maintenance listed successfully (dateRange: ${JSON.stringify(recurring.dateRange)})`);
      } finally {
        await deleteWindow(client, maintenanceID);
      }
    },
  },
  {
    name: 'manual window with only title and strategy is created (no dateRange, no active)',
    fn: async ({ client }) => {
      // Before the defaults in toKumaMaintenance this failed in Uptime Kuma with
      // "Cannot read properties of undefined (reading '0')", and without dateRange but with
      // active it failed on "NOT NULL constraint failed: maintenance.active".
      const createResult = await client.callTool({
        name: 'createMaintenance',
        arguments: { title: 'Integration Test - Manual Minimal', strategy: 'manual' },
      }) as CallToolResult;
      const maintenanceID = extractID(createResult, 'createMaintenance', 'maintenanceID');

      try {
        const found = await findWindow(client, maintenanceID);
        if (found.active !== true) throw new Error(`Expected active: true by default, got ${found.active}`);
        console.log(`  ✓ manual window created with defaults: ID ${maintenanceID}`);
      } finally {
        await deleteWindow(client, maintenanceID);
      }
    },
  },
  {
    name: 'timezone is stored, not silently replaced by the server timezone',
    fn: async ({ client }) => {
      const createResult = await client.callTool({
        name: 'createMaintenance',
        arguments: {
          title: 'Integration Test - Timezone',
          strategy: 'single',
          timezone: 'UTC',
          dateRange: ['2030-01-05T10:00', '2030-01-05T12:00'],
        },
      }) as CallToolResult;
      const maintenanceID = extractID(createResult, 'createMaintenance', 'maintenanceID');

      try {
        const found = await findWindow(client, maintenanceID);
        if (found.timezoneOption !== 'UTC') {
          throw new Error(`Expected timezoneOption "UTC", got ${JSON.stringify(found.timezoneOption)}`);
        }
        console.log(`  ✓ timezone stored as ${found.timezoneOption}`);
      } finally {
        await deleteWindow(client, maintenanceID);
      }
    },
  },
  {
    name: 'monitorIDs: create with monitors → update fields and monitors → pause → resume → delete',
    fn: async ({ client }) => {
      const monitorA = await createPushMonitor(client, 'Integration Test - Maint A');
      const monitorB = await createPushMonitor(client, 'Integration Test - Maint B');
      const monitorC = await createPushMonitor(client, 'Integration Test - Maint C');
      let maintenanceID: number | undefined;

      try {
        // Create covering A and B
        const createResult = await client.callTool({
          name: 'createMaintenance',
          arguments: {
            title: 'Integration Test - With Monitors',
            strategy: 'manual',
            active: false,
            monitorIDs: [monitorA, monitorB],
          },
        }) as CallToolResult;
        maintenanceID = extractID(createResult, 'createMaintenance', 'maintenanceID');
        extractText(createResult, 'createMaintenance');

        let found = await findWindow(client, maintenanceID);
        if (!sameIDs(found.monitorIDs, [monitorA, monitorB])) {
          throw new Error(`Expected monitors [${monitorA}, ${monitorB}], got ${JSON.stringify(found.monitorIDs)}`);
        }
        console.log(`  ✓ createMaintenance with monitorIDs: ${JSON.stringify(found.monitorIDs)}`);

        // Update a field and swap B for C in one call
        const updateResult = await client.callTool({
          name: 'updateMaintenance',
          arguments: {
            maintenanceID,
            title: 'Integration Test - With Monitors (edited)',
            monitorIDs: [monitorA, monitorC],
          },
        }) as CallToolResult;
        extractText(updateResult, 'updateMaintenance');

        found = await findWindow(client, maintenanceID);
        if (found.title !== 'Integration Test - With Monitors (edited)') throw new Error(`Title not updated: ${found.title}`);
        if (found.strategy !== 'manual') throw new Error(`Strategy changed unexpectedly: ${found.strategy}`);
        if (found.active !== false) throw new Error(`active changed by an update that did not ask for it: ${found.active}`);
        if (!sameIDs(found.monitorIDs, [monitorA, monitorC])) {
          throw new Error(`Expected monitors [${monitorA}, ${monitorC}], got ${JSON.stringify(found.monitorIDs)}`);
        }
        console.log('  ✓ updateMaintenance: title and monitor list replaced, other fields kept');

        // Resume (start the manual window), then pause it again
        const resumeResult = await client.callTool({ name: 'resumeMaintenance', arguments: { maintenanceID } }) as CallToolResult;
        extractText(resumeResult, 'resumeMaintenance');
        if ((await findWindow(client, maintenanceID)).active !== true) throw new Error('Window not active after resumeMaintenance');

        const pauseResult = await client.callTool({ name: 'pauseMaintenance', arguments: { maintenanceID } }) as CallToolResult;
        extractText(pauseResult, 'pauseMaintenance');
        if ((await findWindow(client, maintenanceID)).active !== false) throw new Error('Window still active after pauseMaintenance');
        console.log('  ✓ resumeMaintenance / pauseMaintenance');

        // Detach everything
        const detachResult = await client.callTool({
          name: 'updateMaintenance',
          arguments: { maintenanceID, monitorIDs: [] },
        }) as CallToolResult;
        extractText(detachResult, 'updateMaintenance');
        if ((await findWindow(client, maintenanceID)).monitorIDs.length !== 0) throw new Error('monitorIDs: [] did not detach');
        console.log('  ✓ updateMaintenance monitorIDs: [] detaches all');
      } finally {
        if (maintenanceID !== undefined) await deleteWindow(client, maintenanceID);
        for (const monitorID of [monitorA, monitorB, monitorC]) {
          await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
        }
      }
    },
  },
  {
    name: 'write tools report a missing window as not found',
    fn: async ({ client }) => {
      const missingID = 999999;
      const calls: Array<[string, Record<string, unknown>]> = [
        ['updateMaintenance', { maintenanceID: missingID, title: 'x' }],
        ['pauseMaintenance', { maintenanceID: missingID }],
        ['resumeMaintenance', { maintenanceID: missingID }],
        // Uptime Kuma itself answers ok: true here.
        ['deleteMaintenance', { maintenanceID: missingID }],
      ];

      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args }) as CallToolResult;
        const text = (result.content as any[])?.find((c: any) => c.type === 'text')?.text ?? '';
        if (!result.isError || !text.includes(`Maintenance window ${missingID} not found`)) {
          throw new Error(`${name} on a missing window should fail with "not found", got: ${text}`);
        }
      }
      console.log('  ✓ update / pause / resume / delete refuse a missing window');
    },
  },
];
