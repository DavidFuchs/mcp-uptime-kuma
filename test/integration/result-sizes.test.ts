import { appendFileSync } from 'fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, extractID, extractText } from './helpers.js';

/**
 * Reports how large the read tools' results are, the counterpart of test/token-budget.json for
 * tool results. Every result stays in the model's context for the rest of the conversation, so
 * this is the number that a leaner default result format brings down.
 *
 * Report only: a result's size moves a little with timestamps, IDs and uptime figures, so there
 * is no baseline to compare against. The suite fails only when a tool call does.
 *
 * It seeds three paused monitors named token-budget-..., so the monitor tools return the same
 * set on every instance, and reports size per monitor as well as in total. The tools that read
 * the whole instance (settings, tags, notifications, ...) report whatever the instance holds,
 * which depends on what the other suites left behind; their sizes are for comparing runs of the
 * same suite order, not for absolute numbers.
 *
 * In GitHub Actions the table is also written to the job summary.
 */

const PREFIX = 'token-budget-';

interface Row {
  call: string;
  text: number;
  structured: number;
  items?: number;
}

async function measure(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  label = name,
  countItems?: (structured: any) => number
): Promise<Row> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = extractText(result, name);
  const structured = result.structuredContent;
  return {
    call: label,
    text: text.length,
    structured: structured === undefined ? 0 : JSON.stringify(structured).length,
    items: countItems?.(structured),
  };
}

function formatTable(rows: Row[]): string[] {
  const lines = ['| Call | Text chars | Structured chars | Items | Text chars per item |', '|---|---:|---:|---:|---:|'];
  for (const r of rows) {
    const perItem = r.items ? Math.round(r.text / r.items) : '';
    lines.push(`| ${r.call} | ${r.text} | ${r.structured} | ${r.items ?? ''} | ${perItem} |`);
  }
  const text = rows.reduce((sum, r) => sum + r.text, 0);
  const structured = rows.reduce((sum, r) => sum + r.structured, 0);
  lines.push(`| **Total** | **${text}** | **${structured}** | | |`);
  return lines;
}

export const resultSizeTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'report the size of each read tool result',
    fn: async ({ client }) => {
      const seeds = [
        { name: `${PREFIX}http`, type: 'http', url: 'https://example.com' },
        { name: `${PREFIX}port`, type: 'port', hostname: 'example.com', port: 443 },
        { name: `${PREFIX}keyword`, type: 'keyword', url: 'https://example.com', keyword: 'Example' },
      ];
      const ids: number[] = [];
      try {
        for (const seed of seeds) {
          const created = (await client.callTool({
            name: 'createMonitor',
            arguments: { ...seed, active: false },
          })) as CallToolResult;
          ids.push(extractID(created, 'createMonitor', 'monitorID'));
        }
        const [first] = ids;
        const filter = { keywords: PREFIX };
        const length = (key: string) => (s: any) => (Array.isArray(s?.[key]) ? s[key].length : 0);

        const monitorRows = [
          await measure(client, 'listMonitors', filter, 'listMonitors (3 seeded)', length('monitors')),
          await measure(
            client,
            'listMonitors',
            { ...filter, includeTypeSpecificFields: true },
            'listMonitors (3 seeded, type-specific fields)',
            length('monitors')
          ),
          await measure(
            client,
            'listMonitors',
            { ...filter, fields: 'name,type,url,hostname,active' },
            'listMonitors (3 seeded, fields name,type,url,hostname,active)',
            length('monitors')
          ),
          await measure(client, 'getMonitor', { monitorID: first }, 'getMonitor (http)'),
          await measure(
            client,
            'getMonitor',
            { monitorID: first, includeTypeSpecificFields: true },
            'getMonitor (http, type-specific fields)'
          ),
          await measure(client, 'getMonitorSummary', filter, 'getMonitorSummary (3 seeded)'),
          await measure(client, 'listHeartbeats', { monitorID: first }, 'listHeartbeats (http)'),
          await measure(client, 'getMonitorUptime', { monitorID: first }, 'getMonitorUptime (http)'),
          await measure(client, 'getMonitorTypeFields', { type: 'http' }, 'getMonitorTypeFields (http)'),
          await measure(client, 'listMonitorTypes', {}),
          await measure(client, 'getNotificationTypeFields', { type: 'slack' }, 'getNotificationTypeFields (slack)'),
          await measure(client, 'listNotificationTypes', {}),
        ];

        const instanceRows = [];
        for (const name of [
          'getSettings',
          'listTags',
          'listNotifications',
          'listMaintenanceWindows',
          'listStatusPages',
          'listDockerHosts',
          'listProxies',
          'listRemoteBrowsers',
          'listAPIKeys',
          'getDatabaseInfo',
        ]) {
          instanceRows.push(await measure(client, name, {}));
        }
        instanceRows.push(
          await measure(
            client,
            'listMaintenanceWindows',
            { fields: 'title,active' },
            'listMaintenanceWindows (fields title,active)'
          )
        );

        const report = [
          '### Tool result sizes',
          '',
          'Seeded monitors, the same on every run:',
          '',
          ...formatTable(monitorRows),
          '',
          'Instance-wide reads, which depend on what earlier suites left:',
          '',
          ...formatTable(instanceRows),
          '',
        ];
        console.log(report.map((line) => `  ${line}`).join('\n'));
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join('\n')}\n`);
        console.log('  ✓ result sizes reported');
      } finally {
        for (const monitorID of ids) {
          await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
        }
      }
    },
  },
];
