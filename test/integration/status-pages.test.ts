import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText } from './helpers.js';

/**
 * Integration tests for status page operations.
 * Covers: listStatusPages, getStatusPage, createStatusPage, updateStatusPage, deleteStatusPage
 */

export const statusPageTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listStatusPages returns array',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'listStatusPages', arguments: {} }) as CallToolResult;
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
      const createResult = await client.callTool({
        name: 'createStatusPage',
        arguments: { title, slug },
      }) as CallToolResult;
      const createText = extractText(createResult, 'createStatusPage');
      if (!createText) throw new Error('createStatusPage returned empty');

      try {
        // Update with a description and publish it so getStatusPage works
        const updateResult = await client.callTool({
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
            publicGroupList: [
              { name: 'Default', weight: 1, monitorList: [] },
            ],
          },
        }) as CallToolResult;
        extractText(updateResult, 'updateStatusPage');

        // Get full details (this hits the API directly, not cache)
        const getResult = await client.callTool({
          name: 'getStatusPage',
          arguments: { slug },
        }) as CallToolResult;
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
];
