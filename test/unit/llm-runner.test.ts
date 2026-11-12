import { describe, it, expect } from 'vitest';
import { parseArgs, selectScenarios } from '../llm/args.js';
import { summarize, formatConsole } from '../llm/report.js';
import { preflight, PreflightError, assertTestInstance, createInterruptHandler } from '../llm/run-llm.js';
import { defineScenario, expectThat, type RunResult } from '../llm/scenario.js';

const sc = (id: string, tags: string[]) =>
  defineScenario({ id, description: id, tags, prompt: 'p', check: async () => [] });

const run = (scenarioId: string, outcome: RunResult['outcome'], extra: Partial<RunResult> = {}): RunResult => ({
  scenarioId, run: 1, outcome, degraded: false, degradedReasons: [], assertions: [], ...extra,
});

describe('parseArgs', () => {
  it('parseArgs defaults', () => {
    expect(parseArgs([])).toEqual({ scenarios: [], tags: [], repeat: 1, model: 'sonnet', minPassRate: 1, keepTraces: false });
  });

  it('parseArgs repeats and overrides', () => {
    expect(parseArgs(['--scenario', 'a', '--scenario', 'b', '--tag', 'monitors', '--repeat', '3', '--model', 'opus', '--min-pass-rate', '0.66', '--keep-traces']))
      .toEqual({ scenarios: ['a', 'b'], tags: ['monitors'], repeat: 3, model: 'opus', minPassRate: 0.66, keepTraces: true });
  });

  it('parseArgs rejects bad values', () => {
    expect(() => parseArgs(['--repeat', '0'])).toThrow();
    expect(() => parseArgs(['--repeat', 'x'])).toThrow();
    expect(() => parseArgs(['--min-pass-rate', '1.5'])).toThrow();
    expect(() => parseArgs(['--model'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow(/Usage/);
  });
});

describe('selectScenarios', () => {
  const all = [sc('a', ['monitors']), sc('b', ['tags']), sc('c', ['monitors', 'safety'])];
  const base = parseArgs([]);

  it('selectScenarios filters by id and tag, errors on unknown id', () => {
    expect(selectScenarios(all, base).map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(selectScenarios(all, { ...base, scenarios: ['b'] }).map(s => s.id)).toEqual(['b']);
    expect(selectScenarios(all, { ...base, tags: ['monitors'] }).map(s => s.id)).toEqual(['a', 'c']);
    expect(() => selectScenarios(all, { ...base, scenarios: ['zzz'] })).toThrow(/zzz/);
  });
});

describe('summarize', () => {
  it('summarize exit 1 when pass rate below threshold', () => {
    const results = [run('a', 'pass'), run('a', 'pass'), run('a', 'fail')];
    expect(summarize(results, 1).exitCode).toBe(1);
    expect(summarize(results, 0.66).exitCode).toBe(0);
    expect(summarize(results, 0.66).rows[0]).toMatchObject({ scenarioId: 'a', passes: 2, runs: 3 });
  });

  it('summarize exit 1 on any error run even if threshold met', () => {
    const results = [run('a', 'pass'), run('a', 'pass'), run('a', 'error')];
    expect(summarize(results, 0.5).exitCode).toBe(1);
  });

  it('degraded alone does not fail', () => {
    const results = [run('a', 'pass', { degraded: true, degradedReasons: ['tool calls 9 > 8'] })];
    const s = summarize(results, 1);
    expect(s.exitCode).toBe(0);
    expect(s.rows[0].degraded).toBe(true);
  });

  it('averages tool calls and errors and totals cost', () => {
    const t = (n: number, errs: number, cost: number) => ({
      toolCalls: Array.from({ length: n }, (_, i) => ({ name: 'x', input: {}, isError: i < errs, resultText: '' })),
      turns: 1, costUsd: cost, durationMs: 0, finalText: '', rawPath: '', resultSubtype: 'success',
    });
    const s = summarize([run('a', 'pass', { trace: t(4, 0, 0.01) }), run('a', 'pass', { trace: t(6, 2, 0.03) })], 1);
    expect(s.rows[0]).toMatchObject({ avgToolCalls: 5, avgToolErrors: 1 });
    expect(s.totalCostUsd).toBeCloseTo(0.04);
  });
});

describe('formatConsole', () => {
  it('formatConsole shows failed assertion labels and a tool timeline for failing runs', () => {
    const results = [run('a', 'fail', {
      assertions: [expectThat('monitor is paused', false), expectThat('has tag', true)],
      trace: {
        toolCalls: [
          { name: 'listMonitors', input: {}, isError: true, resultText: 'boom' },
          { name: 'pauseMonitor', input: { monitorID: 3 }, isError: false, resultText: 'ok' },
        ],
        turns: 2, costUsd: 0.01, durationMs: 10, finalText: '', rawPath: '/r/a-1.jsonl', resultSubtype: 'success',
      },
    })];
    const out = formatConsole(summarize(results, 1), results);
    expect(out).toContain('monitor is paused');
    expect(out).not.toContain('✗ has tag');
    expect(out).toMatch(/listMonitors .*✗/);
    expect(out).toMatch(/pauseMonitor .*monitorID.*✓/);
  });
});

describe('preflight', () => {
  it('preflight failure aborts before scenarios', async () => {
    const p = preflight(() => Promise.reject(new Error('not logged in')));
    await expect(p).rejects.toBeInstanceOf(PreflightError);
    await expect(preflight(() => Promise.reject(new Error('not logged in')))).rejects.toThrow(/claude.*not logged in/s);
  });

  it('preflight passes when the probe resolves', async () => {
    await expect(preflight(() => Promise.resolve())).resolves.toBeUndefined();
  });
});

describe('assertTestInstance', () => {
  it('accepts a local test instance', () => {
    for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001']) {
      expect(() => assertTestInstance(url, {})).not.toThrow();
    }
  });

  it('refuses any other host unless explicitly allowed', () => {
    expect(() => assertTestInstance('https://kuma.example.com', {})).toThrow(/kuma\.example\.com.*LLM_EVAL_ALLOW_REMOTE/s);
    expect(() => assertTestInstance('not a url', {})).toThrow();
    expect(() => assertTestInstance('https://kuma.example.com', { LLM_EVAL_ALLOW_REMOTE: '1' })).not.toThrow();
  });
});

describe('createInterruptHandler', () => {
  it('aborts the running session on the first signal and exits on the second', () => {
    let aborts = 0;
    const exits: number[] = [];
    const { state, onSignal } = createInterruptHandler({ abort: () => { aborts++; return true; }, exit: code => { exits.push(code); } });
    expect(state.interrupted).toBe(false);
    onSignal();
    expect(state.interrupted).toBe(true);
    expect(aborts).toBe(1);
    expect(exits).toEqual([]);
    onSignal();
    expect(exits).toEqual([130]);
  });
});
