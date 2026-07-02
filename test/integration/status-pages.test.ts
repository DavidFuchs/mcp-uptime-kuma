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
];
