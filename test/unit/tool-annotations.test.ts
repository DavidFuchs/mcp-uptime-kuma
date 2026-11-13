import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, CHANGE_NOTHING_TOOLS, READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/server.js';

/**
 * Clients read these hints to decide which calls may run unattended and which need a
 * confirmation. A tool with none is treated as the worst case, so every tool must carry them,
 * and a read must never be advertised as a write or the reverse.
 */

async function listTools() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });
  const client = new Client({ name: 'annotations-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tool annotations', () => {
  it('marks every read tool read-only and every changing tool not', async () => {
    const tools = await listTools();
    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual([...READ_ONLY_TOOLS, ...CHANGE_NOTHING_TOOLS].sort());

    const changing = tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(changing).toEqual([...WRITE_TOOLS].filter((n) => !CHANGE_NOTHING_TOOLS.has(n)).sort());
  });

  it('marks deletes and updates destructive, and creates, pauses and resumes not', async () => {
    const tools = await listTools();
    const destructive = (name: string) => tools.find((t) => t.name === name)?.annotations?.destructiveHint;
    for (const name of [
      'deleteMonitor',
      'deleteNotification',
      'deleteStatusPage',
      'updateMonitor',
      'updateStatusPage',
    ]) {
      expect(destructive(name), name).toBe(true);
    }
    for (const name of ['createMonitor', 'addNotification', 'addTag', 'pauseMonitor', 'resumeMaintenance']) {
      expect(destructive(name), name).toBe(false);
    }
  });

  it('marks updates, pauses and resumes idempotent, and creates and deletes not', async () => {
    const tools = await listTools();
    const idempotent = (name: string) => tools.find((t) => t.name === name)?.annotations?.idempotentHint;
    for (const name of ['updateMonitor', 'pauseMonitor', 'resumeMonitor', 'pauseMaintenance']) {
      expect(idempotent(name), name).toBe(true);
    }
    for (const name of ['createMonitor', 'addTag', 'deleteMonitor']) {
      expect(idempotent(name), name).toBe(false);
    }
  });
});
