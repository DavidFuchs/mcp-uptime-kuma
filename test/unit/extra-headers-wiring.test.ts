import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end check that UPTIME_KUMA_HEADERS reaches the wire from both entry points.
 *
 * Each test runs the real entry point in a child process against a plain HTTP server
 * standing in for Uptime Kuma (or the Cloudflare Access edge in front of it). The server
 * never completes a Socket.IO handshake — it only needs to see the first request, which
 * is the one an auth proxy inspects.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const SECRET = 'cf-secret-8f3a1c9e';

const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A stand-in upstream that resolves with the headers of the first Socket.IO request. */
async function startUpstream(): Promise<{ url: string; firstRequest: Promise<IncomingHttpHeaders> }> {
  let resolveFirst!: (headers: IncomingHttpHeaders) => void;
  const firstRequest = new Promise<IncomingHttpHeaders>((r) => { resolveFirst = r; });

  const server = createServer((req, res) => {
    if (req.url?.startsWith('/socket.io/')) resolveFirst(req.headers);
    res.writeHead(403).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, firstRequest };
}

/** Runs a src/ entry point under tsx with a clean Uptime Kuma environment. */
function run(script: string, args: string[], env: Record<string, string>) {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('UPTIME_KUMA_'))
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: repoRoot,
    env: { ...baseEnv, MCP_TEST_MODE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));

  return { exited, output: () => output };
}

const HEADERS = JSON.stringify({
  'CF-Access-Client-Id': 'abc.access',
  'CF-Access-Client-Secret': SECRET,
});

describe('UPTIME_KUMA_HEADERS wiring', () => {
  it('the MCP server sends the configured headers to Uptime Kuma', async () => {
    const upstream = await startUpstream();
    run('src/index.ts', ['-t', 'stdio'], {
      UPTIME_KUMA_URL: upstream.url,
      UPTIME_KUMA_HEADERS: HEADERS,
    });

    const headers = await upstream.firstRequest;
    expect(headers['cf-access-client-id']).toBe('abc.access');
    expect(headers['cf-access-client-secret']).toBe(SECRET);
  }, 30_000);

  it('mcp-uptime-kuma-get-jwt sends the configured headers to Uptime Kuma', async () => {
    const upstream = await startUpstream();
    run('src/get-jwt.ts', [upstream.url, 'admin', 'password'], {
      UPTIME_KUMA_HEADERS: HEADERS,
    });

    const headers = await upstream.firstRequest;
    expect(headers['cf-access-client-id']).toBe('abc.access');
    expect(headers['cf-access-client-secret']).toBe(SECRET);
  }, 30_000);

  it.each([
    ['the MCP server', 'src/index.ts', ['-t', 'stdio']],
    ['mcp-uptime-kuma-get-jwt', 'src/get-jwt.ts', ['http://127.0.0.1:1', 'admin', 'password']],
  ])('%s refuses to start on malformed headers without printing them', async (_label, script, args) => {
    const proc = run(script, args, {
      UPTIME_KUMA_URL: 'http://127.0.0.1:1',
      UPTIME_KUMA_HEADERS: `CF-Access-Client-Secret=${SECRET}`,
    });

    expect(await proc.exited).toBe(1);
    expect(proc.output()).toMatch(/UPTIME_KUMA_HEADERS/);
    expect(proc.output()).not.toContain(SECRET);
  }, 30_000);
});
