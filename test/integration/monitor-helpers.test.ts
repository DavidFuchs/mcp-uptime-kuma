import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, type TestContext, extractText } from './helpers.js';

/**
 * Integration tests for the monitor-creation helpers.
 * Covers: listGames, listPM2Processes, testChrome, getPushExample, checkDomainExpirySupport
 */

type Structured = Record<string, any>;

const raw = ({ client }: TestContext, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult & { structuredContent: Structured }>;

/** The text of a result, error or not (extractText throws on an error). */
const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const caller =
  (ctx: TestContext) =>
  async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(ctx, name, args);
    if (result.isError) throw new Error(`${name} failed: ${extractText(result, name)}`);
    return result.structuredContent;
  };

export const monitorHelperTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listGames finds a GameDig ID by name',
    fn: async (ctx) => {
      const found = await caller(ctx)('listGames', { search: 'minecraft', limit: 5 });
      const minecraft = (found.games as Structured[]).find((g) => g.id === 'minecraft');
      if (!minecraft) throw new Error(`minecraft not among ${JSON.stringify(found.games)}`);
      if (!(found.total > 100)) throw new Error(`expected GameDig's full list, got ${found.total}`);
      console.log(`  ✓ ${found.total} games; "minecraft" → ${minecraft.name}, port ${minecraft.defaultPort}`);
    },
  },
  {
    name: 'listPM2Processes answers with a list, or says PM2 is missing',
    fn: async (ctx) => {
      const result = await raw(ctx, 'listPM2Processes');
      const text = textOf(result);
      if (result.isError) {
        if (!/PM2 is not installed/.test(text)) throw new Error(`unexpected error: ${text}`);
        console.log(`  ✓ no PM2 in the test image: ${text.slice(0, 100)}`);
      } else {
        console.log(`  ✓ ${result.structuredContent.count} PM2 processes`);
      }
    },
  },
  {
    name: 'testChrome reaches Uptime Kuma, which refuses a path off its list (nothing is installed)',
    fn: async (ctx) => {
      const result = await raw(ctx, 'testChrome', { executable: '/bin/sh' });
      const text = textOf(result);
      if (!result.isError || !/not allowed/i.test(text)) throw new Error(`expected a refusal: ${text}`);
      console.log('  ✓ /bin/sh refused by Uptime Kuma');
    },
  },
  {
    name: "getPushExample fills a push monitor's URL and interval into Uptime Kuma's sample",
    fn: async (ctx) => {
      const call = caller(ctx);
      const created = await call('createMonitor', { name: 'zz-push-example', type: 'push', interval: 45 });
      const monitorID = created.monitorID as number;
      const token = created.pushToken as string;
      try {
        const hidden = await call('getPushExample', { monitorID, language: 'python' });
        if (hidden.code.includes(token)) throw new Error('the token was not hidden');
        const shown = await call('getPushExample', { monitorID, language: 'python', includeSecrets: true });
        if (!shown.code.includes(`/api/push/${token}?status=up`) || !/interval = 45/.test(shown.code)) {
          throw new Error(`URL or interval not filled in:\n${shown.code}`);
        }
        if (shown.code.includes('/api/push/key?')) throw new Error('the placeholder URL is still there');
        console.log(`  ✓ python example for push monitor ${monitorID}: token and interval 45 filled in`);
      } finally {
        await ctx.client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: 'checkDomainExpirySupport accepts a .com address and explains a refusal',
    fn: async (ctx) => {
      const call = caller(ctx);
      const com = await call('checkDomainExpirySupport', { address: 'https://www.example.com/health' });
      if (!com.supported || com.domain !== 'example.com' || com.tld !== 'com') {
        throw new Error(`expected example.com to be supported: ${JSON.stringify(com)}`);
      }
      const lan = await call('checkDomainExpirySupport', { address: 'printer.lan' });
      if (lan.supported || !/not managed by ICANN/.test(lan.reason ?? '')) {
        throw new Error(`expected printer.lan to be refused with a reason: ${JSON.stringify(lan)}`);
      }
      console.log(`  ✓ example.com supported; printer.lan: ${lan.reason}`);
    },
  },
];
