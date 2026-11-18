import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractText } from './helpers.js';

/**
 * Integration tests for status page operations.
 * Covers: listStatusPages, getStatusPage, createStatusPage, updateStatusPage, deleteStatusPage
 */

export const statusPageTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listStatusPages returns array',
    fn: async ({ client }) => {
      const result = (await client.callTool({ name: 'listStatusPages', arguments: {} })) as CallToolResult;
      const text = extractText(result, 'listStatusPages');
      const pages = JSON.parse(text);
      if (!Array.isArray(pages)) throw new Error('Expected array');
      console.log(`  ✓ listStatusPages: ${pages.length} status pages`);
    },
  },
  {
    name: 'createStatusPage → getStatusPage → updateStatusPage → deleteStatusPage lifecycle',
    fn: async ({ client }) => {
      const slug = 'int-test-page';
      const title = 'Integration Test Page';

      // Create
      const createResult = (await client.callTool({
        name: 'createStatusPage',
        arguments: { title, slug },
      })) as CallToolResult;
      const createText = extractText(createResult, 'createStatusPage');
      if (!createText) throw new Error('createStatusPage returned empty');

      try {
        // Update with a description and publish it so getStatusPage works
        const updateResult = (await client.callTool({
          name: 'updateStatusPage',
          arguments: {
            slug,
            config: {
              slug,
              title,
              description: 'Created by integration tests',
              published: true,
              showTags: false,
              showPoweredBy: true,
              theme: 'auto',
              icon: '',
              customCSS: '',
              footerText: '',
              domainNameList: [],
              googleAnalyticsId: '',
              analyticsType: null,
            },
            publicGroupList: [{ name: 'Default', weight: 1, monitorList: [] }],
          },
        })) as CallToolResult;
        extractText(updateResult, 'updateStatusPage');

        // Get full details (this hits the API directly, not cache)
        const getResult = (await client.callTool({
          name: 'getStatusPage',
          arguments: { slug },
        })) as CallToolResult;
        const details = JSON.parse(extractText(getResult, 'getStatusPage'));
        if (!details.config) throw new Error('getStatusPage returned no config');
        if (details.config.title !== title) {
          throw new Error(`Expected title "${title}", got "${details.config.title}"`);
        }

        console.log(`  ✓ createStatusPage/getStatusPage/updateStatusPage lifecycle: slug="${slug}"`);
      } finally {
        // Cleanup
        await client.callTool({ name: 'deleteStatusPage', arguments: { slug } });
        console.log(`  ✓ deleteStatusPage: cleaned up slug="${slug}"`);
      }
    },
  },
  {
    name: 'incident lifecycle: create → list → update (merge) → unpin → resolve → delete',
    fn: async ({ client }) => {
      const slug = 'int-test-incidents';
      type Incident = { id: number; title: string; content: string; style: string; pin: boolean; active: boolean };
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = (await client.callTool({ name, arguments: args })) as CallToolResult & {
          structuredContent: Record<string, unknown>;
        };
        if (result.isError) throw new Error(`${name} failed: ${extractText(result, name)}`);
        return result.structuredContent;
      };
      const find = async (id: number) =>
        ((await call('listIncidents', { slug })).incidents as Incident[]).find((i) => i.id === id);

      await call('createStatusPage', { title: 'Incident Test Page', slug });
      try {
        const created = (
          await call('createIncident', {
            slug,
            title: 'API degraded',
            content: 'We are **investigating**.',
            style: 'danger',
          })
        ).incident as Incident;
        if (!created?.id) throw new Error('createIncident returned no incident ID');
        const id = created.id;

        let stored = await find(id);
        if (!stored?.pin || !stored.active)
          throw new Error(`new incident should be pinned and active: ${JSON.stringify(stored)}`);

        const page = await call('getStatusPage', { slug });
        if (!((page.incidents ?? []) as Incident[]).some((i) => i.id === id)) {
          throw new Error('getStatusPage does not show the active incident');
        }

        await call('updateIncident', { slug, incidentID: id, title: 'API degraded (EU)' });
        stored = await find(id);
        if (
          stored?.title !== 'API degraded (EU)' ||
          stored.content !== 'We are **investigating**.' ||
          stored.style !== 'danger'
        ) {
          throw new Error(`update did not keep the other fields: ${JSON.stringify(stored)}`);
        }

        await call('updateIncident', { slug, incidentID: id, pinned: false });
        stored = await find(id);
        if (stored?.pin !== false || stored.active !== true)
          throw new Error(`unpin should keep it active: ${JSON.stringify(stored)}`);

        await call('resolveIncident', { slug, incidentID: id });
        stored = await find(id);
        if (stored?.active !== false) throw new Error(`resolve should make it inactive: ${JSON.stringify(stored)}`);

        await call('deleteIncident', { slug, incidentID: id });
        if (await find(id)) throw new Error('deleted incident is still listed');

        console.log(`  ✓ incident ${id}: created, merged update, unpinned, resolved, deleted`);
      } finally {
        await client.callTool({ name: 'deleteStatusPage', arguments: { slug } });
      }
    },
  },
  {
    name: 'maintenance window shown on a status page via statusPageSlugs',
    fn: async ({ client }) => {
      const slug = 'int-test-maint-page';
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = (await client.callTool({ name, arguments: args })) as CallToolResult & {
          structuredContent: Record<string, unknown>;
        };
        if (result.isError) throw new Error(`${name} failed: ${extractText(result, name)}`);
        return result.structuredContent;
      };
      // null when the window is not listed; read results leave an empty list out.
      const slugsOf = async (id: number) => {
        const window = (
          (await call('listMaintenanceWindows', { limit: 100_000 })).maintenanceWindows as Array<{
            id: number;
            statusPageSlugs?: string[];
          }>
        ).find((w) => w.id === id);
        return window ? (window.statusPageSlugs ?? []) : null;
      };

      await call('createStatusPage', { title: 'Maintenance Test Page', slug });
      let maintenanceID: number | undefined;
      try {
        maintenanceID = (
          await call('createMaintenanceWindow', {
            title: 'int-test status page window',
            strategy: 'manual',
            active: false,
            statusPageSlugs: [slug],
          })
        ).maintenanceID as number;
        const linked = await slugsOf(maintenanceID);
        if (JSON.stringify(linked) !== JSON.stringify([slug]))
          throw new Error(`expected [${slug}], got ${JSON.stringify(linked)}`);

        await call('updateMaintenanceWindow', { maintenanceID, statusPageSlugs: [] });
        const after = await slugsOf(maintenanceID);
        if (JSON.stringify(after) !== '[]') throw new Error(`expected [], got ${JSON.stringify(after)}`);

        console.log(`  ✓ maintenance window ${maintenanceID}: shown on "${slug}", then removed`);
      } finally {
        if (maintenanceID !== undefined) {
          await client.callTool({ name: 'deleteMaintenanceWindow', arguments: { maintenanceID } });
        }
        await client.callTool({ name: 'deleteStatusPage', arguments: { slug } });
      }
    },
  },
];
