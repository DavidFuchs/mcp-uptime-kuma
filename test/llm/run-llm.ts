import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createTestClient, loadTestConfig, validateTestConfig, type TestContext, type TestConfig } from '../integration/helpers.js';
import { runClaude, assertProbeTrace, type Trace } from './claude-driver.js';
import { classify, type RunResult, type Scenario, type Assertion } from './scenario.js';
import { sweep } from './kuma.js';
import { parseArgs, selectScenarios, type LlmArgs } from './args.js';
import { summarize, formatConsole, writeResults } from './report.js';
import { scenarios as allScenarios } from './scenarios/index.js';

/**
 * LLM agent-usability eval. Normally started through `npm run test:llm`, which brings the
 * test container up first. See test/llm/README.md.
 */

const MAX_BUDGET_USD = 0.5;
const TIMEOUT_MS = 180_000;

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** Runs the probe; any failure becomes one clear PreflightError instead of N error rows. */
export async function preflight(runProbe: () => Promise<void>): Promise<void> {
  try {
    await runProbe();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new PreflightError(
      `Preflight failed: could not run a headless claude session (${why}).\n` +
      `Check that the claude CLI is installed and that you are logged in (run \`claude\` once interactively).`,
    );
  }
}

async function probeClaude(config: TestConfig, model: string, dir: string): Promise<void> {
  execFileSync(process.env.CLAUDE_BIN ?? 'claude', ['--version'], { stdio: 'ignore' });
  const trace = await runClaude({
    prompt: 'Reply with OK.', model, maxBudgetUsd: 0.05, timeoutMs: 60_000, config, rawPath: join(dir, 'preflight.jsonl'),
  });
  assertProbeTrace(trace);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The eval hands a model write and delete tools, so it only runs against a local test instance
 * unless LLM_EVAL_ALLOW_REMOTE=1 says otherwise.
 */
export function assertTestInstance(url: string, env: NodeJS.ProcessEnv): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`UPTIME_KUMA_URL is not a valid URL: ${url}`);
  }
  if (LOCAL_HOSTS.has(host) || env.LLM_EVAL_ALLOW_REMOTE === '1') return;
  throw new Error(
    `Refusing to run: UPTIME_KUMA_URL points at ${host}, not a local test instance. The eval lets a ` +
    `model create and delete monitors. Set LLM_EVAL_ALLOW_REMOTE=1 if ${host} really is a disposable test instance.`,
  );
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function runOnce(ctx: TestContext, scenario: Scenario<any>, n: number, args: LlmArgs, dir: string): Promise<RunResult> {
  const rawPath = join(dir, `${scenario.id}-${n}.jsonl`);
  let seed: unknown;
  let trace: Trace | undefined;
  let assertions: Assertion[] | undefined;
  let error: unknown;
  try {
    await sweep(ctx);
    seed = scenario.setup ? await scenario.setup(ctx) : undefined;
    const prompt = typeof scenario.prompt === 'function' ? scenario.prompt(seed) : scenario.prompt;
    trace = await runClaude({ prompt, model: args.model, maxBudgetUsd: MAX_BUDGET_USD, timeoutMs: TIMEOUT_MS, config: ctx.config, rawPath });
    assertions = await scenario.check(ctx, seed, trace);
  } catch (e) {
    error = e;
  } finally {
    try {
      if (scenario.teardown) await scenario.teardown(ctx, seed);
    } catch (e) {
      error ??= e;
    }
    try {
      await sweep(ctx);
    } catch (e) {
      error ??= e;
    }
  }
  const result: RunResult = { scenarioId: scenario.id, run: n, ...classify({ assertions, trace, error, scenario }) };
  if (!args.keepTraces && result.outcome === 'pass' && !result.degraded && existsSync(rawPath)) {
    rmSync(rawPath);
    if (result.trace) result.trace = { ...result.trace, rawPath: '' };
  }
  return result;
}

async function main(): Promise<number> {
  let args: LlmArgs;
  let selected: Scenario<any>[];
  try {
    args = parseArgs(process.argv.slice(2));
    selected = selectScenarios(allScenarios, args);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const config = loadTestConfig();
  validateTestConfig(config);
  try {
    assertTestInstance(config.url, process.env);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    return 2;
  }

  const startedAt = new Date().toISOString();
  const dir = join(import.meta.dirname, 'results', startedAt.replace(/:/g, '-'));
  mkdirSync(dir, { recursive: true });

  console.log(`🔎 Preflight: checking headless claude (${args.model})...`);
  try {
    await preflight(() => probeClaude(config, args.model, dir));
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    rmSync(dir, { recursive: true, force: true });
    return 2;
  }
  rmSync(join(dir, 'preflight.jsonl'), { force: true });

  console.log(`▶ ${selected.length} scenarios × ${args.repeat} runs, model ${args.model}\n`);
  const { client } = await createTestClient(config);
  const ctx: TestContext = { client, config };
  const results: RunResult[] = [];
  try {
    for (const scenario of selected) {
      for (let n = 1; n <= args.repeat; n++) {
        const r = await runOnce(ctx, scenario, n, args, dir);
        results.push(r);
        const icon = r.outcome === 'pass' ? (r.degraded ? '⚠' : '✓') : r.outcome === 'fail' ? '✗' : '!';
        const calls = r.trace ? `${r.trace.toolCalls.length} calls` : '';
        console.log(`  ${icon} ${scenario.id} #${n} ${r.outcome} ${calls}${r.errorMessage ? ` — ${r.errorMessage}` : ''}`);
      }
    }
  } finally {
    await client.close();
  }

  const summary = summarize(results, args.minPassRate);
  writeResults(dir, results, { model: args.model, gitSha: gitSha(), startedAt });
  console.log(`\n${formatConsole(summary, results)}`);
  console.log(`\nResults: ${dir}`);
  return summary.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), e => {
    console.error(e);
    process.exit(2);
  });
}
