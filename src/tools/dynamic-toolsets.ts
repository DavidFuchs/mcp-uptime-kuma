import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOLSETS, type ToolsetName } from './registration.js';

/**
 * UPTIME_KUMA_DYNAMIC_TOOLSETS: the server starts with the monitors toolset and one more tool,
 * enableToolsets, which loads the others when the model needs them. A client sends every listed
 * tool's definition to the model with every request, so a session that only asks about monitors
 * should not carry the definitions of maintenance windows, proxies and API keys.
 *
 * Loading a toolset enables tools that were registered but disabled, and the SDK then sends
 * notifications/tools/list_changed. That needs a client that refreshes its tool list on it, and
 * a transport that keeps one server for the session: stdio. The HTTP transport builds a server
 * per request and answers with plain JSON, so it could neither remember what was loaded nor send
 * the notification; index.ts refuses the combination.
 */

/** The toolsets loaded at the start. getMonitorSummary, the status overview, is in it. */
export const INITIAL_TOOLSETS: readonly ToolsetName[] = ['monitors'];

/** What each toolset is for, in the enableToolsets description. */
const TOOLSET_SUMMARIES: Record<ToolsetName, string> = {
  monitors: 'monitor status and configuration: create, update, pause and delete monitors',
  heartbeats: 'check history, uptime percentages, and clearing a monitor’s history',
  notifications: 'notification channels (Slack, email, webhooks...): list, create, update, test',
  tags: 'tags: list, create, update, delete',
  maintenance: 'maintenance windows that suppress alerts: list, create, update, switch on and off',
  'status-pages': 'public status pages and their incidents',
  'docker-hosts': 'Docker daemon connections that docker container monitors use',
  settings: 'Uptime Kuma server settings',
  proxies: 'proxies that monitors send requests through',
  'remote-browsers': 'remote browsers for real-browser monitors',
  'api-keys': 'API keys',
  database: 'database size, and shrinking it',
};

/**
 * Disables the registered tools outside the initial toolsets and registers enableToolsets,
 * which turns them back on a toolset at a time. `registered` holds every tool the selection
 * allows (read-only mode and UPTIME_KUMA_TOOLSETS still decide that), keyed by name.
 */
export function installDynamicToolsets(server: McpServer, registered: ReadonlyMap<string, RegisteredTool>): void {
  const toolsOf = (toolset: ToolsetName) =>
    (TOOLSETS[toolset] as readonly string[]).filter((name) => registered.has(name));
  const available = (Object.keys(TOOLSETS) as ToolsetName[]).filter((t) => toolsOf(t).length > 0);
  const loaded = new Set<ToolsetName>(INITIAL_TOOLSETS.filter((t) => available.includes(t)));

  for (const toolset of available) {
    if (loaded.has(toolset)) continue;
    for (const name of toolsOf(toolset)) registered.get(name)?.disable();
  }

  const unloaded = available.filter((t) => !loaded.has(t));
  if (unloaded.length === 0) return;

  const start = loaded.size > 0 ? `Only the ${[...loaded].join(', ')} tools are loaded at the start. ` : '';
  server.registerTool(
    'enableToolsets',
    {
      title: 'Enable Toolsets',
      description:
        `Loads more of this server's tools. ${start}Before a task needs tools that are not listed, call this with the toolsets it needs; their tools are listed from the next step on and stay for the rest of the session. Toolsets: ` +
        unloaded.map((t) => `${t} (${TOOLSET_SUMMARIES[t]})`).join('; ') +
        '.',
      inputSchema: {
        toolsets: z
          .array(z.enum(available as [ToolsetName, ...ToolsetName[]]))
          .min(1)
          .describe('The toolsets to load'),
      },
      outputSchema: {
        loaded: z.array(z.string()).describe('The toolsets this call loaded'),
        alreadyLoaded: z.array(z.string()).describe('The toolsets that were loaded before'),
        tools: z.array(z.string()).describe('The tools this call added'),
      },
      // It changes which tools are listed, not anything in Uptime Kuma.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ toolsets }) => {
      const newly = [...new Set(toolsets)].filter((t) => !loaded.has(t));
      const already = [...new Set(toolsets)].filter((t) => loaded.has(t));
      const tools = newly.flatMap(toolsOf);
      // One tools/list_changed for the call, not one per tool as enable() would send: a burst of
      // them left Claude Code without the new tools on the model's next step (status-pages, ten
      // tools, failed in the eval while the five-tool toolsets worked).
      for (const name of tools) {
        const tool = registered.get(name);
        if (tool) tool.enabled = true;
      }
      if (tools.length > 0) server.sendToolListChanged();
      for (const t of newly) loaded.add(t);

      const lines = [
        newly.length > 0
          ? `Loaded ${newly.join(', ')}: ${tools.join(', ')}. They are listed from the next step on.`
          : 'Nothing new to load.',
        ...(already.length > 0 ? [`Already loaded: ${already.join(', ')}.`] : []),
      ];
      return {
        content: [{ type: 'text', text: lines.join(' ') }],
        structuredContent: { loaded: newly, alreadyLoaded: already, tools },
      };
    }
  );
}
