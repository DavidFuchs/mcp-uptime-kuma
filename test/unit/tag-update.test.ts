import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createMockSocket, createDisconnectedSocket, injectSocket } from './helpers.js';

describe('UptimeKumaClient.editTag', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
  });

  it('emits editTag with the id, name and color and resolves with the saved tag', async () => {
    const { socket } = createMockSocket({
      editTag: (tag, callback) => {
        expect(tag).toEqual({ id: 5, name: 'prod', color: '#00ff00' });
        (callback as (res: unknown) => void)({
          ok: true,
          msg: 'Saved.',
          tag: { id: 5, name: 'prod', color: '#00ff00' },
        });
      },
    });
    injectSocket(client, socket);

    const result = await client.editTag(5, 'prod', '#00ff00');
    expect(result.ok).toBe(true);
    expect(result.tag).toEqual({ id: 5, name: 'prod', color: '#00ff00' });
  });

  it('rejects when the server returns not ok', async () => {
    const { socket } = createMockSocket({
      editTag: (_tag, callback) => {
        (callback as (res: unknown) => void)({ ok: false, msg: 'tagNotFound' });
      },
    });
    injectSocket(client, socket);

    await expect(client.editTag(999, 'x', '#000')).rejects.toThrow('tagNotFound');
  });

  it('rejects when not connected', async () => {
    injectSocket(client, createDisconnectedSocket());
    await expect(client.editTag(1, 'x', '#000')).rejects.toThrow('Not connected to server');
  });
});

/**
 * Uptime Kuma's editTag handler writes both name and color from what it is sent, so the tool
 * fills in whichever one the caller left out.
 */
describe('updateTag tool', () => {
  let edit: ReturnType<typeof vi.spyOn>;

  const connect = async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    const client = new Client({ name: 'tag-update-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };
  const update = async (args: Record<string, unknown>) =>
    (await connect()).callTool({ name: 'updateTag', arguments: args }) as Promise<any>;

  beforeEach(() => {
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getTagList').mockResolvedValue([
      { id: 5, name: 'production', color: '#ff0000' },
      { id: 6, name: 'staging', color: '#0000ff' },
    ] as never);
    edit = vi.spyOn(UptimeKumaClient.prototype, 'editTag').mockImplementation((async (
      id: number,
      name: string,
      color: string
    ) => ({
      ok: true,
      msg: 'Saved.',
      tag: { id, name, color },
    })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renames a tag and keeps its color', async () => {
    const result = await update({ tagID: 5, name: 'prod' });

    expect(result.isError).toBeFalsy();
    expect(edit).toHaveBeenCalledWith(5, 'prod', '#ff0000');
    expect(result.structuredContent).toEqual({
      ok: true,
      tag: { id: 5, name: 'prod', color: '#ff0000' },
      msg: 'Saved.',
    });
  });

  it('recolors a tag and keeps its name', async () => {
    await update({ tagID: 5, color: '#00ff00' });

    expect(edit).toHaveBeenCalledWith(5, 'production', '#00ff00');
  });

  it('changes both at once', async () => {
    await update({ tagID: 6, name: 'stage', color: '#111111' });

    expect(edit).toHaveBeenCalledWith(6, 'stage', '#111111');
  });

  it('refuses a call that changes nothing', async () => {
    const result = await update({ tagID: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/name.*color/);
    expect(edit).not.toHaveBeenCalled();
  });

  it('refuses an unknown tag id and points at listTags', async () => {
    const result = await update({ tagID: 99, name: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('listTags');
    expect(edit).not.toHaveBeenCalled();
  });

  it('is advertised as a write that is not offered in read-only mode', async () => {
    const tools = (await (await connect()).listTools()).tools;
    const tool = tools.find((t) => t.name === 'updateTag');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });
});
