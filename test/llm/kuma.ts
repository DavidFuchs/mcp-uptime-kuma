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

/**
 * Deletes every monitor, tag, maintenance window, notification, status page and docker host
 * whose name/title/slug has the prefix. Returns the number deleted.
 */
export async function sweep(ctx: TestContext): Promise<number> {
  let deleted = 0;
  const del = async (tool: string, args: Record<string, unknown>) => {
    try {
      await call(ctx, tool, args);
      deleted++;
    } catch (e) {
      // Deleting a group can take its children with it, so a later delete may find nothing.
      if (!/not found/i.test((e as Error).message)) throw e;
    }
  };

  const { monitors = [] } = await call(ctx, 'listMonitors');
  const byId = new Map((monitors as any[]).map(m => [m.id, m]));
  const depth = (m: any): number => {
    let d = 0;
    for (let p = m.parent, seen = 0; p != null && byId.has(p) && seen < 100; p = byId.get(p).parent, seen++) d++;
    return d;
  };
  // Deepest first, so a group is only deleted once everything under it is gone.
  const ours = (monitors as any[]).filter(m => hasPrefix(m.name)).sort((a, b) => depth(b) - depth(a));
  for (const m of ours) await del('deleteMonitor', { monitorID: m.id });

  const { tags = [] } = await call(ctx, 'listTags');
  for (const t of tags as any[]) if (hasPrefix(t.name)) await del('deleteTag', { tagID: t.id });

  const { maintenanceWindows = [] } = await call(ctx, 'getMaintenanceWindows');
  for (const w of maintenanceWindows as any[]) if (hasPrefix(w.title)) await del('deleteMaintenance', { maintenanceID: w.id });

  const { notifications = [] } = await call(ctx, 'listNotifications');
  for (const n of notifications as any[]) if (hasPrefix(n.name)) await del('deleteNotification', { notificationID: n.id });

  const { statusPages = [] } = await call(ctx, 'listStatusPages');
  for (const p of statusPages as any[]) if (hasPrefix(p.slug) || hasPrefix(p.title)) await del('deleteStatusPage', { slug: p.slug });

  const { dockerHosts = [] } = await call(ctx, 'listDockerHosts');
  for (const h of dockerHosts as any[]) if (hasPrefix(h.name)) await del('deleteDockerHost', { dockerHostID: h.id });

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

/**
 * The host and port of an address stored with or without a scheme ("mqtt://broker:1883",
 * "tcp://10.0.0.9:2375", "broker.example.com"). Checks compare these exactly: a substring test
 * would also accept "mqtt://evil.test/broker.example.com".
 */
export function hostAndPort(value: unknown): { host: string; port: string } {
  const text = String(value ?? '').trim();
  try {
    const url = new URL(text.includes('://') ? text : `x://${text}`);
    return { host: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return { host: '', port: '' };
  }
}
