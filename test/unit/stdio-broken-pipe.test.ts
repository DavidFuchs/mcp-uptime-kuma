import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Found while testing Ctrl+C in the LLM eval: when the process reading the server's stdout goes
 * away (an MCP client that crashed or was killed), the next response write fails with EPIPE.
 * Without an error handler on stdout that is an unhandled 'error' event, and the server dies
 * with a stack trace instead of shutting down.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('stdio transport with a broken stdout pipe', () => {
  it('shuts down quietly instead of crashing on EPIPE', async () => {
    const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/index.ts'), '-t', 'stdio'], {
      // Nothing listens here, so startup auth fails fast; the server keeps running regardless.
      env: { ...process.env, UPTIME_KUMA_URL: 'http://127.0.0.1:9', UPTIME_KUMA_USERNAME: 'u', UPTIME_KUMA_PASSWORD: 'p' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    // Give the server time to start, then close the read end of its stdout and make it write.
    await new Promise(r => setTimeout(r, 2500));
    child.stdout.destroy();
    const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    child.stdin.write(JSON.stringify(request) + '\n');

    const code = await Promise.race([exited, new Promise<'still running'>(r => setTimeout(() => r('still running'), 8000))]);
    if (code === 'still running') child.kill('SIGKILL');

    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(stderr).not.toContain('EPIPE');
    expect(code).toBe(0);
  }, 20_000);
});
