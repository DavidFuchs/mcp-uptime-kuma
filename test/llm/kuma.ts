import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TestContext } from '../integration/helpers.js';
import { PREFIX } from './scenario.js';

/**
 * Scripted-client helpers for scenario setup, checks and cleanup. These go through the MCP
 * server like the model does, but deterministically.
 */

/** Calls a tool and returns its structuredContent, else its text parsed as JSON, else the raw text. Throws on isError. */
export async function call(ctx: TestContext, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await ctx.client.callTool({ name: tool, arguments: args }) as CallToolResult;
  const text = (result.content as any[] | undefined)?.find(c => c?.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${tool} returned error: ${text}`);
  if (result.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const hasPrefix = (v: unknown) => typeof v === 'string' && v.startsWith(PREFIX);

/** Deletes every monitor, tag, maintenance window, notification and status page whose name/title/slug has the prefix. Returns the number deleted. */
export async function sweep(ctx: TestContext): Promise<number> {
  let deleted = 0;
  const del = async (tool: string, args: Record<string, unknown>) => {
    await call(ctx, tool, args);
    deleted++;
  };

  const { monitors = [] } = await call(ctx, 'listMonitors');
  // Children before groups, so deleting a group never trips over a child already gone.
  const ours = (monitors as any[]).filter(m => hasPrefix(m.name)).sort((a, b) => (b.parent ? 1 : 0) - (a.parent ? 1 : 0));
  for (const m of ours) await del('deleteMonitor', { monitorID: m.id });

  const { tags = [] } = await call(ctx, 'listTags');
  for (const t of tags as any[]) if (hasPrefix(t.name)) await del('deleteTag', { tagID: t.id });

  const { maintenanceWindows = [] } = await call(ctx, 'getMaintenanceWindows');
  for (const w of maintenanceWindows as any[]) if (hasPrefix(w.title)) await del('deleteMaintenance', { maintenanceID: w.id });

  const { notifications = [] } = await call(ctx, 'listNotifications');
  for (const n of notifications as any[]) if (hasPrefix(n.name)) await del('deleteNotification', { notificationID: n.id });

  const { statusPages = [] } = await call(ctx, 'listStatusPages');
  for (const p of statusPages as any[]) if (hasPrefix(p.slug) || hasPrefix(p.title)) await del('deleteStatusPage', { slug: p.slug });

  return deleted;
}

/** Full monitor record, type-specific fields and secrets included. */
export async function getMonitor(ctx: TestContext, monitorID: number): Promise<any> {
  const { monitor } = await call(ctx, 'getMonitor', { monitorID, includeTypeSpecificFields: true, includeSecrets: true });
  return monitor;
}

/** The monitor with exactly this name, read in full, or undefined. */
export async function findMonitor(ctx: TestContext, name: string): Promise<any | undefined> {
  const { monitors = [] } = await call(ctx, 'listMonitors');
  const m = (monitors as any[]).find(x => x.name === name);
  return m ? getMonitor(ctx, m.id) : undefined;
}

/** Creates a monitor through the scripted client and returns its ID. */
export async function createMonitor(ctx: TestContext, args: Record<string, unknown>): Promise<number> {
  const { monitorID } = await call(ctx, 'createMonitor', args);
  return Number(monitorID);
}
