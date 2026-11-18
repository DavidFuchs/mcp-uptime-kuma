import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createServer,
  buildInstructions,
  parseToolsets,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  TOOLSETS,
} from '../../src/server.js';

async function connect(config: { toolsets?: string[]; readOnly?: boolean } = {}) {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
    ...config,
  });
  const client = new Client({ name: 'toolsets-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, names, instructions: client.getInstructions() ?? '' };
}

const quotedTools = (text: string) => [...text.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);

describe('TOOLSETS', () => {
  it('puts every registered tool in exactly one toolset', async () => {
    const { names } = await connect();
    const placed = Object.values(TOOLSETS).flat();

    expect([...placed].sort()).toEqual(names);
    expect(new Set(placed).size).toBe(placed.length);
    expect(names.sort()).toEqual([...READ_ONLY_TOOLS, ...WRITE_TOOLS].sort());
  });
});

describe('parseToolsets', () => {
  it.each([undefined, '', '  ', 'all', 'monitors,all'])('treats %o as every toolset', (value) => {
    expect(parseToolsets(value)).toBeUndefined();
  });

  it('accepts a comma-separated list, ignoring case, spaces and repeats', () => {
    expect(parseToolsets(' Monitors , maintenance,monitors ')).toEqual(['monitors', 'maintenance']);
  });

  it('rejects an unknown toolset and names the valid ones', () => {
    expect(() => parseToolsets('monitors,monitor')).toThrow(/unknown toolset "monitor".*Valid toolsets: monitors/);
  });
});

describe('UPTIME_KUMA_TOOLSETS', () => {
  it('registers only the chosen toolsets', async () => {
    const { names } = await connect({ toolsets: ['monitors', 'heartbeats'] });

    expect(names).toEqual([...TOOLSETS.monitors, ...TOOLSETS.heartbeats].sort());
  });

  it('combines with read-only mode', async () => {
    const { names } = await connect({ toolsets: ['maintenance'], readOnly: true });

    expect(names).toEqual(['listMaintenanceWindows']);
  });

  it('refuses an unknown toolset passed in the config', async () => {
    await expect(connect({ toolsets: ['nope'] })).rejects.toThrow(/unknown toolset "nope"/);
  });

  it('cannot call a tool from a toolset that was left out', async () => {
    const { client } = await connect({ toolsets: ['tags'] });
    const result = await client
      .callTool({ name: 'deleteMonitor', arguments: { monitorID: 1 } })
      .catch((error: Error) => ({ isError: true, message: error.message }));

    expect(result.isError).toBe(true);
  });
});

describe('server instructions', () => {
  it.each([
    [{}],
    [{ readOnly: true }],
    [{ toolsets: ['monitors'] }],
    [{ toolsets: ['maintenance', 'tags'] }],
    [{ toolsets: ['settings'], readOnly: true }],
  ])('name only registered tools for %o', async (config) => {
    const { names, instructions } = await connect(config);
    const mentioned = quotedTools(instructions);

    expect(mentioned.filter((t) => !names.includes(t))).toEqual([]);
  });

  // They are sent with every request, so they hold only what applies across tools; what each
  // tool is for is in its own description, which a client that ignores the instructions still sees.
  it('point status questions at getMonitorSummary, and leave the rest to the tool descriptions', () => {
    const instructions = buildInstructions(() => true, false);

    expect(instructions).toContain("start with 'getMonitorSummary'");
    expect(quotedTools(instructions).sort()).toEqual(
      ['getMonitorSummary', 'updateMonitor', 'updateNotification', 'updateSettings'].sort()
    );
  });

  it('drop the getMonitorSummary line when that tool is left out', async () => {
    const { instructions } = await connect({ toolsets: ['heartbeats'], readOnly: true });

    expect(instructions).not.toContain('getMonitorSummary');
    expect(instructions).toContain('leave out fields that are null or empty');
  });

  it('keep the "***" round-trip line when any one update tool is present', () => {
    const onlySettings = buildInstructions((t) => t === 'updateSettings' || t === 'getSettings', false);

    expect(onlySettings).toContain("sent back to 'updateSettings' keeps the stored value");
    expect(buildInstructions((t) => t === 'getSettings', true)).not.toContain('keeps the stored value');
  });
});
