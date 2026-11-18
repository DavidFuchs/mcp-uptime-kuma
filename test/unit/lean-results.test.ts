import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { omitEmpty, leanToolResult } from '../../src/tools/lean-results.js';

/**
 * Read results leave out null and empty values: a field that is not there has no value, so
 * nothing is lost, and every result stays in the model's context for the rest of the session.
 */
describe('omitEmpty', () => {
  it('drops null, empty strings, empty arrays and empty objects at every depth', () => {
    expect(
      omitEmpty({
        description: null,
        cron: '',
        tags: [],
        notificationIDList: {},
        config: { footerText: null, theme: 'dark' },
        nested: { only: null },
      })
    ).toEqual({ config: { theme: 'dark' } });
  });

  it('keeps false and 0, which carry meaning', () => {
    expect(omitEmpty({ active: false, maxretries: 0, upsideDown: false })).toEqual({
      active: false,
      maxretries: 0,
      upsideDown: false,
    });
  });

  it('trims inside array elements but keeps every element', () => {
    expect(omitEmpty([{ id: 1, parent: null }, null, '', {}])).toEqual([{ id: 1 }, null, '', {}]);
  });

  it('keeps a field the schema requires, even when it is empty', () => {
    const heartbeat = {
      type: 'object',
      properties: { time: { type: 'string' }, msg: { type: 'string' }, ping: { type: ['number', 'null'] } },
      required: ['time', 'msg'],
    };
    const schema = { type: 'object', additionalProperties: { type: 'array', items: heartbeat } };
    expect(omitEmpty({ '7': [{ time: 't', msg: '', ping: null }] }, schema)).toEqual({ '7': [{ time: 't', msg: '' }] });
  });

  it('keeps every entry of a record, whose keys are data such as monitor IDs', () => {
    const schema = { type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } } };
    expect(omitEmpty({ '7': [], '8': [{ msg: 'x', ping: null }] }, schema)).toEqual({ '7': [], '8': [{ msg: 'x' }] });
  });

  it('still trims an object with named properties that allows others', () => {
    const schema = { type: 'object', properties: { id: { type: 'number' } }, additionalProperties: {} };
    expect(omitEmpty({ id: 1, url: '', hostname: null }, schema)).toEqual({ id: 1 });
  });

  it('finds required fields inside a union such as anyOf [object, null]', () => {
    const schema = {
      type: 'object',
      properties: {
        ping: {
          anyOf: [
            { type: 'object', properties: { avg: { type: ['number', 'null'] } }, required: ['avg'] },
            { type: 'null' },
          ],
        },
      },
    };
    expect(omitEmpty({ ping: { avg: null, note: null } }, schema)).toEqual({ ping: { avg: null } });
  });

  it('returns a root value as it is when it is itself empty', () => {
    expect(omitEmpty([])).toEqual([]);
    expect(omitEmpty({})).toEqual({});
    expect(omitEmpty(null)).toBeNull();
  });
});

describe('leanToolResult', () => {
  it('keeps the top-level keys of structuredContent, which are the output contract', () => {
    const result = leanToolResult({
      content: [{ type: 'text', text: '[]' }],
      structuredContent: { monitors: [], count: 0, note: null },
    });
    expect(result.structuredContent).toEqual({ monitors: [], count: 0, note: null });
  });

  it('trims JSON text and the values below the top level of structuredContent alike', () => {
    const monitor = { id: 1, description: null, tags: [], active: false };
    const result = leanToolResult({
      content: [{ type: 'text', text: JSON.stringify(monitor) }],
      structuredContent: { monitor },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"id":1,"active":false}' }]);
    expect(result.structuredContent).toEqual({ monitor: { id: 1, active: false } });
  });

  it('leaves prose text alone', () => {
    const text = 'Database: sqlite, 1.2 MB {"size": null}';
    expect(leanToolResult({ content: [{ type: 'text', text }] }).content).toEqual([{ type: 'text', text }]);
  });

  it('leaves error results alone', () => {
    const result = { isError: true, content: [{ type: 'text', text: '{"error":"x","detail":null}' }] };
    expect(leanToolResult(result)).toEqual(result);
  });
});

describe('read tools through the server', () => {
  const MONITOR = {
    id: 7,
    name: 'shop',
    type: 'http',
    interval: 60,
    retryInterval: 60,
    description: null,
    parent: null,
    active: false,
    maxretries: 0,
    tags: [],
    notificationIDList: {},
    childrenIDs: [],
    uptime: {},
    avgPing: null,
  };

  async function connect() {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'lean-results-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('getMonitor leaves out the empty fields and keeps false and 0', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({ ...MONITOR } as never);
    const client = await connect();
    const result = (await client.callTool({ name: 'getMonitor', arguments: { monitorID: 7 } })) as CallToolResult;

    const expected = {
      id: 7,
      name: 'shop',
      type: 'http',
      interval: 60,
      retryInterval: 60,
      active: false,
      maxretries: 0,
    };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(expected);
    expect(result.structuredContent).toEqual({ monitor: expected });
  });

  it('listMonitors with no matches still returns its monitors and count', async () => {
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitorList').mockReturnValue({} as never);
    const client = await connect();
    const result = (await client.callTool({ name: 'listMonitors', arguments: {} })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ monitors: [], count: 0 });
  });
});
