import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createKumaSession } from '../../src/server.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** Runs node under tsx with no Uptime Kuma settings inherited from the developer's shell. */
function run(args: string[], env: Record<string, string> = {}) {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('UPTIME_KUMA_'))
  );
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: repoRoot,
    env: { ...baseEnv, MCP_TEST_MODE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));

  const waitForOutput = async (pattern: RegExp) => {
    const deadline = Date.now() + 20_000;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}; output so far:\n${output}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  return { child, exited, output: () => output, waitForOutput };
}

/** A port nothing is listening on, found by binding one and letting it go. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

describe('signal handling', () => {
  it('a Kuma session leaves the process signal handlers to the entry point', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };

    createKumaSession({ url: 'http://127.0.0.1:1', username: undefined, password: undefined, token: undefined, jwtToken: undefined });

    // A handler here runs ahead of the entry point's own and exits before it can close anything.
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('the HTTP transport closes its listener on %s before exiting', async (signal) => {
    const port = await freePort();
    const proc = run(['src/index.ts', '-t', 'streamable-http'], {
      UPTIME_KUMA_URL: 'http://127.0.0.1:1',
      HOST: '127.0.0.1',
      PORT: String(port),
    });
    await proc.waitForOutput(/server running/);

    proc.child.kill(signal);

    expect(await proc.exited).toBe(0);
    expect(proc.output()).toMatch(/Shutting down gracefully/);
    expect(proc.output()).toMatch(/Server closed/);
  }, 30_000);
});

describe('the package entry point', () => {
  it('can be imported for createServer without starting a server', async () => {
    const { main } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { main: string };
    // package.json names the compiled file; the same module in src/ is what tsx can load here.
    const source = main.replace(/^dist\//, './src/').replace(/\.js$/, '.ts');

    const proc = run([
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(source)}); console.log('createServer is a ' + typeof m.createServer);`,
    ]);

    // Importing must not read the environment, open a transport or keep the process alive.
    expect(await proc.exited).toBe(0);
    expect(proc.output().trim()).toBe('createServer is a function');
  }, 30_000);
});
