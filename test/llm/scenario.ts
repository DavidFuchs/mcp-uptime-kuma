import type { TestContext } from '../integration/helpers.js';
import type { Trace } from './claude-driver.js';

/** Every entity a scenario creates is named (or slugged) with this prefix, so the sweep can find it. */
export const PREFIX = 'llm-eval-';

export interface Assertion { label: string; ok: boolean; detail?: string }

export function expectThat(label: string, ok: boolean, detail?: string): Assertion {
  return detail === undefined ? { label, ok } : { label, ok, detail };
}

export interface Budget { maxToolCalls?: number; maxToolErrors?: number }

export interface Scenario<S = unknown> {
  id: string;
  description: string;
  tags: string[];
  /** Seeds state through the scripted MCP client; the return value is passed to prompt/check/teardown. */
  setup?(ctx: TestContext): Promise<S>;
  /** What the model is asked. Never names a tool. */
  prompt: string | ((seed: S) => string);
  /** Grades the real Uptime Kuma state afterwards. Returns every assertion; does not stop at the first. */
  check(ctx: TestContext, seed: S, trace: Trace): Promise<Assertion[]>;
  /** Optional; the prefix sweep always runs as well. */
  teardown?(ctx: TestContext, seed: S): Promise<void>;
  /** Calling any of these marks the run degraded. */
  unexpectedTools?: string[];
  budget?: Budget;
}

export function defineScenario<S>(s: Scenario<S>): Scenario<S> {
  return s;
}

export type Outcome = 'pass' | 'fail' | 'error';

export interface RunResult {
  scenarioId: string;
  run: number;
  outcome: Outcome;
  degraded: boolean;
  degradedReasons: string[];
  assertions: Assertion[];
  errorMessage?: string;
  trace?: Trace;
}

export function classify(input: {
  assertions?: Assertion[];
  trace?: Trace;
  error?: unknown;
  scenario: Pick<Scenario, 'budget' | 'unexpectedTools'>;
}): Omit<RunResult, 'scenarioId' | 'run'> {
  const assertions = input.assertions ?? [];
  const { trace, scenario } = input;

  const degradedReasons: string[] = [];
  if (trace) {
    const calls = trace.toolCalls.length;
    const errors = trace.toolCalls.filter(c => c.isError).length;
    const { maxToolCalls, maxToolErrors } = scenario.budget ?? {};
    if (maxToolCalls !== undefined && calls > maxToolCalls) degradedReasons.push(`tool calls ${calls} > ${maxToolCalls}`);
    if (maxToolErrors !== undefined && errors > maxToolErrors) degradedReasons.push(`tool errors ${errors} > ${maxToolErrors}`);
    for (const name of scenario.unexpectedTools ?? []) {
      if (trace.toolCalls.some(c => c.name === name)) degradedReasons.push(`called unexpected tool ${name}`);
    }
  }
  const base = { degraded: degradedReasons.length > 0, degradedReasons, assertions, trace };

  if (input.error !== undefined) {
    const e = input.error;
    return { ...base, outcome: 'error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
  if (trace && trace.resultSubtype !== 'success') {
    return { ...base, outcome: 'error', errorMessage: `claude run ended with ${trace.resultSubtype}` };
  }
  return { ...base, outcome: assertions.every(a => a.ok) ? 'pass' : 'fail' };
}
