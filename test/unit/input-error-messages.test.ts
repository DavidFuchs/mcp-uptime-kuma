import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * The input error messages of #65, as a caller receives them.
 *
 * These go through an MCP client on purpose. The SDK chooses how to run a schema from the
 * Zod version it detects, and with Zod 4 it does not call the schema's own safeParse(). A test
 * that calls safeParse() directly therefore keeps passing while callers get Zod's defaults.
 */

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });
  const client = new Client({ name: 'input-error-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
}

describe('input error messages as the caller sees them (#65)', () => {
  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a misspelled key before any other complaint', async () => {
    const text = await callTool('getMonitor', { monitorId: 1 });

    expect(text).toContain("Unknown field(s) for getMonitor: 'monitorId'");
    expect(text).toContain('Accepted fields: monitorID');
    // The knock-on complaint about the now-absent monitorID must come second.
    const lines = text.split('\n');
    expect(lines[0]).toContain('Unknown field(s)');
    expect(lines.slice(1).join('\n')).toContain('monitorID');
    expect(text).not.toMatch(/\bnan\b/i);
  });

  it('lists every unknown key in one message', async () => {
    const text = await callTool('updateMonitor', { monitorID: 7, nmae: 'x', ulr: 'y' });

    expect(text).toContain("Unknown field(s) for updateMonitor: 'nmae', 'ulr'");
    expect(text.match(/Unknown field\(s\)/g)).toHaveLength(1);
  });

  it('reports an omitted required ID as missing', async () => {
    const text = await callTool('getMonitor', {});

    expect(text).toContain('this field is required and was not provided');
  });

  it('does not call a present but malformed ID missing', async () => {
    const text = await callTool('getMonitor', { monitorID: 'abc' });

    expect(text).not.toContain('was not provided');
    expect(text).toContain('monitorID');
  });
});
