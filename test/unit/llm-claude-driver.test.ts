import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseStreamJson,
  buildClaudeArgs,
  buildChildEnv,
  buildMcpConfig,
  runClaude,
  ClaudeTimeoutError,
  assertProbeTrace,
  abortActiveClaude,
  ClaudeAbortedError,
} from '../llm/claude-driver.js';
import { classify } from '../llm/scenario.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureLines = readFileSync(join(here, 'fixtures/claude-stream.jsonl'), 'utf8').split('\n');

const toolUse = (id: string, name: string, input: unknown = {}) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, content: unknown, isError?: boolean) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const result = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 2, duration_ms: 5, result: 'done' });

describe('parseStreamJson', () => {
  it('parses MCP tool calls in order with prefix stripped', () => {
    const t = parseStreamJson(fixtureLines, 'x');
    expect(t.toolCalls.map(c => c.name)).toEqual(['listMonitors', 'getMonitor']);
    for (const c of t.toolCalls) expect(c.name).not.toContain('mcp__uptime-kuma__');
    expect(t.toolCalls[1].input).toEqual({ monitorID: 999999 });
    expect(t.rawPath).toBe('x');
  });

  it('counts is_error tool results', () => {
    const t = parseStreamJson(fixtureLines, 'x');
    expect(t.toolCalls[0].isError).toBe(false);
    expect(t.toolCalls[1].isError).toBe(true);
    expect(t.toolCalls[1].resultText).toContain('not found');
  });

  it('reads text from array-form tool result content', () => {
    const t = parseStreamJson([
      toolUse('a', 'mcp__uptime-kuma__listTags'),
      toolResult('a', [{ type: 'text', text: 'Input validation error: bad' }], true),
      result,
    ], 'x');
    expect(t.toolCalls[0]).toMatchObject({ name: 'listTags', isError: true, resultText: 'Input validation error: bad' });
  });

  it('excludes non-MCP tools from toolCalls', () => {
    const t = parseStreamJson([
      toolUse('s', 'ToolSearch', { query: 'monitor' }),
      toolResult('s', 'found'),
      toolUse('a', 'mcp__uptime-kuma__listMonitors'),
      toolResult('a', '[]'),
      result,
    ], 'x');
    expect(t.toolCalls.map(c => c.name)).toEqual(['listMonitors']);
  });

  it('reads cost, duration, turns, subtype and final text from the result message', () => {
    const t = parseStreamJson(fixtureLines, 'x');
    expect(t.costUsd).toBeGreaterThan(0);
    expect(t.turns).toBeGreaterThanOrEqual(1);
    expect(t.durationMs).toBeGreaterThan(0);
    expect(t.resultSubtype).toBe('success');
    expect(t.finalText.length).toBeGreaterThan(0);
  });

  it('reports a missing result message as subtype "missing"', () => {
    const t = parseStreamJson([toolUse('a', 'mcp__uptime-kuma__listMonitors')], 'x');
    expect(t.resultSubtype).toBe('missing');
  });

  it('ignores blank and non-JSON lines', () => {
    expect(() => parseStreamJson(['', 'not json', '{"type":"unknown"}', result], 'x')).not.toThrow();
  });
});

describe('failed sessions', () => {
  // The result line a logged-out `claude -p` really prints: subtype success, but is_error true.
  const loggedOut = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0, num_turns: 1, duration_ms: 3 });

  it('treats an is_error result as a failed session', () => {
    const t = parseStreamJson([loggedOut], 'x');
    expect(t.resultSubtype).toBe('is_error');
    expect(t.finalText).toContain('Not logged in');
  });

  it('a logged-out run classifies as error, not pass', () => {
    const r = classify({ assertions: [], trace: parseStreamJson([loggedOut], 'x'), scenario: {} });
    expect(r.outcome).toBe('error');
    expect(r.errorMessage).toContain('Not logged in');
  });

  it('reads the MCP server status from the init message', () => {
    expect(parseStreamJson(fixtureLines, 'x').mcpStatus).toBe('connected');
    const failed = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'uptime-kuma', status: 'failed' }] });
    expect(parseStreamJson([failed, result], 'x').mcpStatus).toBe('failed');
    expect(parseStreamJson([result], 'x').mcpStatus).toBeUndefined();
  });

  it('assertProbeTrace rejects a logged-out or disconnected session and accepts a good one', () => {
    expect(() => assertProbeTrace(parseStreamJson([loggedOut], 'x'))).toThrow(/Not logged in/);
    const failed = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'uptime-kuma', status: 'failed' }] });
    expect(() => assertProbeTrace(parseStreamJson([failed, result], 'x'))).toThrow(/uptime-kuma.*failed/);
    expect(() => assertProbeTrace(parseStreamJson(fixtureLines, 'x'))).not.toThrow();
  });
});

describe('buildClaudeArgs', () => {
  it('includes isolation flags', () => {
    const args = buildClaudeArgs({ prompt: 'p', model: 'sonnet', maxBudgetUsd: 0.5, mcpConfigPath: '/tmp/m.json' });
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(after('-p')).toBe('p');
    expect(after('--setting-sources')).toBe('');
    expect(after('--tools')).toBe('');
    expect(after('--allowedTools')).toBe('mcp__uptime-kuma__*');
    expect(after('--model')).toBe('sonnet');
    expect(after('--max-budget-usd')).toBe('0.5');
    expect(after('--mcp-config')).toBe('/tmp/m.json');
    expect(after('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).not.toContain('--bare');
  });
});

describe('buildChildEnv', () => {
  it('strips UPTIME_KUMA_ vars', () => {
    const env = buildChildEnv({ UPTIME_KUMA_URL: 'http://real', UPTIME_KUMA_JWT_TOKEN: 't', PATH: '/bin' });
    expect(env.PATH).toBe('/bin');
    expect(Object.keys(env).filter(k => k.startsWith('UPTIME_KUMA_'))).toEqual([]);
  });
});

describe('buildMcpConfig', () => {
  it('carries test credentials', () => {
    const cfg = buildMcpConfig({ url: 'http://localhost:3001', username: 'admin', password: 'pw' }, '/repo') as any;
    const s = cfg.mcpServers['uptime-kuma'];
    // The repo's own tsx, run by this node: no npx lookup from the empty temp cwd.
    expect(s.command).toBe(process.execPath);
    expect(s.args[0]).toBe('/repo/node_modules/tsx/dist/cli.mjs');
    expect(s.args.slice(-2)).toEqual(['-t', 'stdio']);
    expect(s.args).toContain('/repo/src/index.ts');
    expect(s.env).toEqual({
      UPTIME_KUMA_URL: 'http://localhost:3001',
      UPTIME_KUMA_USERNAME: 'admin',
      UPTIME_KUMA_PASSWORD: 'pw',
      MCP_TEST_MODE: '1',
    });
  });
});

describe('runClaude', () => {
  it('timeout yields error outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-driver-test-'));
    const bin = join(dir, 'slow-claude');
    writeFileSync(bin, '#!/bin/sh\nsleep 10\n');
    chmodSync(bin, 0o755);
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    const started = Date.now();
    try {
      await expect(runClaude({
        prompt: 'p', model: 'sonnet', maxBudgetUsd: 0.1, timeoutMs: 200,
        config: { url: 'http://localhost:3001', username: 'a', password: 'b' },
        rawPath: join(dir, 'raw.jsonl'),
      })).rejects.toBeInstanceOf(ClaudeTimeoutError);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a timeout while the process is still writing does not crash the runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-driver-test-'));
    const bin = join(dir, 'chatty-claude');
    writeFileSync(bin, '#!/bin/sh\nwhile true; do echo \'{"type":"noise","padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\'; done\n');
    chmodSync(bin, 0o755);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    try {
      await expect(runClaude({
        prompt: 'p', model: 'sonnet', maxBudgetUsd: 0.1, timeoutMs: 300,
        config: { url: 'http://localhost:3001', username: 'a', password: 'b' },
        rawPath: join(dir, 'raw.jsonl'),
      })).rejects.toBeInstanceOf(ClaudeTimeoutError);
      await new Promise(r => setTimeout(r, 300));
    } finally {
      process.off('uncaughtException', onUncaught);
      if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
    }
    expect(uncaught).toEqual([]);
  });

  it('an unwritable trace path rejects instead of crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-driver-test-'));
    const bin = join(dir, 'fake-claude');
    writeFileSync(bin, `#!/bin/sh\necho '${result}'\n`);
    chmodSync(bin, 0o755);
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    try {
      await expect(runClaude({
        prompt: 'p', model: 'sonnet', maxBudgetUsd: 0.1, timeoutMs: 5000,
        config: { url: 'http://localhost:3001', username: 'a', password: 'b' },
        rawPath: join(dir, 'no-such-dir', 'raw.jsonl'),
      })).rejects.toThrow(/ENOENT/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
    }
  });

  it('abortActiveClaude kills the running session and its process group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-driver-test-'));
    const bin = join(dir, 'slow-claude');
    const pidFile = join(dir, 'grandchild.pid');
    // A grandchild in the same group, standing in for the MCP server claude starts.
    writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nsleep 30\n`);
    chmodSync(bin, 0o755);
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    try {
      const run = runClaude({
        prompt: 'p', model: 'sonnet', maxBudgetUsd: 0.1, timeoutMs: 20_000,
        config: { url: 'http://localhost:3001', username: 'a', password: 'b' },
        rawPath: join(dir, 'raw.jsonl'),
      });
      await new Promise(r => setTimeout(r, 300));
      const started = Date.now();
      expect(abortActiveClaude()).toBe(true);
      await expect(run).rejects.toBeInstanceOf(ClaudeAbortedError);
      expect(Date.now() - started).toBeLessThan(2000);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      await new Promise(r => setTimeout(r, 100));
      expect(() => process.kill(grandchild, 0)).toThrow();
      expect(abortActiveClaude()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
    }
  });

  it('parses the stream of a process that exits normally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-driver-test-'));
    const bin = join(dir, 'fake-claude');
    writeFileSync(join(dir, 'out.jsonl'), fixtureLines.join('\n'));
    writeFileSync(bin, `#!/bin/sh\ncat "${join(dir, 'out.jsonl')}"\n`);
    chmodSync(bin, 0o755);
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = bin;
    try {
      const raw = join(dir, 'raw.jsonl');
      const t = await runClaude({
        prompt: 'p', model: 'sonnet', maxBudgetUsd: 0.1, timeoutMs: 5000,
        config: { url: 'http://localhost:3001', username: 'a', password: 'b' }, rawPath: raw,
      });
      expect(t.toolCalls.map(c => c.name)).toEqual(['listMonitors', 'getMonitor']);
      expect(readFileSync(raw, 'utf8')).toContain('"type": "result"');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
    }
  });
});
