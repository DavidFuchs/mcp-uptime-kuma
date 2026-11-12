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
} from '../llm/claude-driver.js';

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
    expect(s.command).toBe('npx');
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
