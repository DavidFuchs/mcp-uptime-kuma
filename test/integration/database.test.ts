import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractText } from './helpers.js';

/**
 * Integration tests for the database tools, against the SQLite database the test instance runs.
 * Covers: getDatabaseInfo, shrinkDatabase
 */

type Structured = Record<string, any>;

export const databaseTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'getDatabaseInfo reports the SQLite file, and shrinkDatabase runs VACUUM on it',
    fn: async ({ client }) => {
      const call = async (name: string) => {
        const result = (await client.callTool({ name, arguments: {} })) as CallToolResult & {
          structuredContent: Structured;
        };
        if (result.isError) throw new Error(`${name} failed: ${extractText(result, name)}`);
        return result.structuredContent;
      };

      const info = await call('getDatabaseInfo');
      if (info.dbType !== 'sqlite' || !info.canShrink) throw new Error(`expected SQLite: ${JSON.stringify(info)}`);
      if (!(info.sizeBytes > 0)) throw new Error(`expected a size: ${JSON.stringify(info)}`);
      if (typeof info.keepDataPeriodDays !== 'number') {
        throw new Error(`expected the retention period: ${JSON.stringify(info)}`);
      }

      const shrunk = await call('shrinkDatabase');
      if (!shrunk.ok || !(shrunk.sizeAfter > 0) || shrunk.sizeAfter > shrunk.sizeBefore) {
        throw new Error(`unexpected shrink result: ${JSON.stringify(shrunk)}`);
      }

      console.log(
        `  ✓ SQLite ${info.size}, keeps ${info.keepDataPeriodDays} days; shrink ${shrunk.sizeBefore} → ${shrunk.sizeAfter} bytes`
      );
    },
  },
];
