import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, TOOLSETS, READ_ONLY_TOOLS } from '../../src/server.js';

/**
 * UPTIME_KUMA_DYNAMIC_TOOLSETS: the server starts with the monitors tools and enableToolsets,
 * and loads the other toolsets when the model asks, so a session pays only for the tool
 * definitions it uses.
 */
async function connect(config: { toolsets?: string[]; readOnly?: boolean; dynamicToolsets?: boolean } = {}) {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
    dynamicToolsets: true,
    ...config,
  });
  const client = new Client({ name: 'dynamic-toolsets-test', version: '1.0.0' }, { capabilities: {} });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  const enable = async (toolsets: string[]) =>
    (await client.callTool({ name: 'enableToolsets', arguments: { toolsets } })) as CallToolResult;
  return { client, names, enable, listChanged: () => listChanged, instructions: client.getInstructions() ?? '' };
}

const sorted = (names: readonly string[]) => [...names].sort();

describe('dynamic toolsets', () => {
  it('start with the monitors tools and enableToolsets', async () => {
    const { names } = await connect();
    expect(await names()).toEqual(sorted([...TOOLSETS.monitors, 'enableToolsets']));
  });

  it('list the other toolsets in enableToolsets, and not the loaded one', async () => {
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'enableToolsets');
    expect(tool?.description).toContain('maintenance (maintenance windows');
    expect(tool?.description).not.toContain('monitors (');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('load a toolset on request, and tell the client the list changed', async () => {
    const { names, enable, listChanged } = await connect();
    const result = await enable(['tags']);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ loaded: ['tags'], alreadyLoaded: [], tools: [...TOOLSETS.tags] });
    expect(await names()).toEqual(sorted([...TOOLSETS.monitors, ...TOOLSETS.tags, 'enableToolsets']));
    // One notification for the call, not one per tool: a burst of them left Claude Code without
    // the new tools. Notifications arrive asynchronously; the listTools round trip lets it through.
    expect(listChanged()).toBe(1);
  });

  it('say which toolsets were already loaded', async () => {
    const { enable } = await connect();
    await enable(['tags']);
    const again = await enable(['tags', 'monitors', 'proxies']);
    expect(again.structuredContent).toEqual({
      loaded: ['proxies'],
      alreadyLoaded: ['tags', 'monitors'],
      tools: [...TOOLSETS.proxies],
    });
  });

  it('refuse a toolset that does not exist', async () => {
    const { enable } = await connect();
    const result = await enable(['alerts']);
    expect(result.isError).toBe(true);
  });

  it('cannot call a tool before its toolset is loaded', async () => {
    const { client, enable } = await connect();
    const before = (await client.callTool({ name: 'listTags', arguments: {} })) as CallToolResult;
    expect(before.isError).toBe(true);
    await enable(['tags']);
    expect((await client.listTools()).tools.some((t) => t.name === 'listTags')).toBe(true);
  });

  it('never load a write tool in read-only mode', async () => {
    const { names, enable } = await connect({ readOnly: true });
    await enable(['maintenance', 'tags']);
    const listed = await names();
    expect(listed.filter((n) => n !== 'enableToolsets' && !READ_ONLY_TOOLS.has(n))).toEqual([]);
    expect(listed).toContain('listMaintenanceWindows');
  });

  it('load only toolsets UPTIME_KUMA_TOOLSETS allows', async () => {
    const { names, enable } = await connect({ toolsets: ['tags', 'maintenance'] });
    expect(await names()).toEqual(['enableToolsets']);
    expect((await enable(['proxies'])).isError).toBe(true);
    await enable(['tags']);
    expect(await names()).toEqual(sorted([...TOOLSETS.tags, 'enableToolsets']));
  });

  it('have no enableToolsets, and say nothing of it, when nothing is left to load', async () => {
    const { names, instructions } = await connect({ toolsets: ['monitors'] });
    expect(await names()).toEqual(sorted(TOOLSETS.monitors));
    expect(instructions).not.toContain('enableToolsets');
  });

  it('tell the model in the instructions to load what it needs', async () => {
    expect((await connect()).instructions).toContain("call 'enableToolsets' first");
    expect((await connect({ dynamicToolsets: false })).instructions).not.toContain('enableToolsets');
  });

  it('are off by default: every tool is listed and there is no enableToolsets', async () => {
    const { names } = await connect({ dynamicToolsets: false });
    expect(await names()).toEqual(sorted(Object.values(TOOLSETS).flat()));
  });
});
