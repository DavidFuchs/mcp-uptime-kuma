import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpApp } from '../../src/http-app.js';
import { createKumaSession } from '../../src/server.js';

/**
 * The HTTP transport is stateless: every POST is its own exchange. An McpServer can be
 * connected to only one transport at a time, so a single shared server answered a request
 * that arrived while another was still in flight with a 500. Agents send tool calls in
 * parallel, so that was a routine failure rather than an edge case.
 */

const CONFIG = {
  url: 'http://localhost:3001',
  username: undefined,
  password: undefined,
  token: undefined,
  jwtToken: undefined,
};

let listening: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (listening ? listening.close(resolve) : resolve(undefined)));
  listening = undefined;
});

/** Starts the app with a session whose login stays pending until `release()` is called. */
async function start(env: Record<string, string | undefined> = {}) {
  const session = createKumaSession(CONFIG);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let logins = 0;
  session.authenticateClient = async () => {
    logins++;
    await gate;
    throw new Error('Uptime Kuma is not reachable in this test');
  };

  const { app } = await createHttpApp(CONFIG, { env, session });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  listening = server;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  const post = (body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });

  return { post, release, logins: () => logins };
}

const listTools = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });
const callTool = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('streamable HTTP transport', () => {
  it('answers a request that arrives while another is still in flight', async () => {
    const { post, release, logins } = await start();

    // Held open: the tool waits on the login, which the test has not released.
    const slow = post(callTool(1, 'getSettings'));
    await expect.poll(logins).toBe(1);

    const fast = await post(listTools(2));
    expect(fast.status).toBe(200);
    const listed = (await fast.json()) as { id: number; result: { tools: unknown[] } };
    expect(listed.id).toBe(2);
    expect(listed.result.tools.length).toBeGreaterThan(0);

    release();
    const slowResponse = await slow;
    expect(slowResponse.status).toBe(200);
    expect(((await slowResponse.json()) as { id: number }).id).toBe(1);
  });

  it('answers many simultaneous requests, each with its own id', async () => {
    const { post, release } = await start();
    release();

    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const responses = await Promise.all(ids.map((id) => post(listTools(id))));
    expect(responses.map((r) => r.status)).toEqual(ids.map(() => 200));
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ id: number }>));
    expect(bodies.map((b) => b.id)).toEqual(ids);
  });

  it('answers requests that need no login while Uptime Kuma is unreachable', async () => {
    const { post, release } = await start();
    release();

    const response = await post(listTools(1));
    expect(response.status).toBe(200);
  });

  it('applies the request limit from RATE_LIMIT_MAX', async () => {
    const { post, release } = await start({ RATE_LIMIT_MAX: '2' });
    release();

    const statuses = [];
    for (const id of [1, 2, 3]) statuses.push((await post(listTools(id))).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('applies no request limit when RATE_LIMIT_MAX is 0', async () => {
    const { post, release } = await start({ RATE_LIMIT_MAX: '0' });
    release();

    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => post(listTools(i + 1))));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  });
});
