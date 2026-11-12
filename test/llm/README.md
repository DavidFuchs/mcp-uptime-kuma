# LLM agent-usability eval

Gives a real model plain-language tasks ("pause the billing API monitor and tag it prod") and
checks whether it gets them done through this MCP server. It tests what the scripted
integration suite cannot: whether the tool names, descriptions and input schemas are clear
enough for an agent to pick the right tool, fill in arguments that pass validation, and recover
from errors.

Each run is graded on the **state of the Uptime Kuma test container afterwards**, read through
the scripted MCP client. What the model says it did is recorded but not graded, so a confident
"Done!" counts for nothing.

## Prerequisites

- Docker (the same test container as `npm run test:integration`).
- The `claude` CLI, installed and logged in. Your normal Claude Code login is used; no
  `ANTHROPIC_API_KEY` is needed.

## Running

```bash
npm run test:llm                                   # every scenario once, with sonnet
npm run test:llm -- --scenario pause-and-tag       # one scenario (repeatable)
npm run test:llm -- --tag monitors                 # scenarios with a tag (repeatable)
npm run test:llm -- --repeat 3                     # run each scenario 3 times
npm run test:llm -- --model opus                   # another model
npm run test:llm -- --repeat 3 --min-pass-rate 0.66
npm run test:llm -- --keep-traces                  # keep raw traces of passing runs too
```

`npm run test:llm` starts the container, creates the admin account from
`test/integration/.env.test` if needed, runs the eval and tears the container down. With the
container already up, `npx tsx test/llm/run-llm.ts [options]` skips that.

A full run of the 8 starter scenarios with sonnet takes about 40 seconds of model time and
costs about $0.25 (measured: 16 runs for $0.49). Each run is capped at $0.50 and 180 seconds.

## What a run does

For each scenario and repeat:

1. Delete anything left over whose name starts with `llm-eval-`.
2. `setup` seeds state through the scripted MCP client.
3. Start one headless Claude Code session with the scenario's prompt.
4. `check` reads the resulting state and returns assertions.
5. `teardown`, then the `llm-eval-` sweep again.

The Claude session is isolated:

| Flag / setting | Why |
|---|---|
| `--mcp-config` + `--strict-mcp-config` | only this MCP server, started with the test credentials |
| `--tools ""` | no Bash, Read, WebFetch: Uptime Kuma is reachable only through the server |
| `--allowedTools "mcp__uptime-kuma__*"` | tool calls run without permission prompts |
| `--setting-sources ""` | your settings, hooks and plugins are not loaded |
| empty temp working directory | the repo's `CLAUDE.md` / `AGENTS.md` are not loaded |
| `UPTIME_KUMA_*` removed from the environment | the model can never reach your real instance |
| `--no-session-persistence` | runs do not show up in your session history |

`--bare` is not used because it refuses the Claude Code login and accepts only
`ANTHROPIC_API_KEY`. Checked with Claude Code 2.1.311: with these flags the MCP tools are
offered directly (no tool-search step), and the user-level `~/.claude/CLAUDE.md` is not loaded.

## Reading the results

```
pause-and-tag               2/2 pass    avg 5.0 calls   0.0 errors   $0.06
create-dns-monitor          1/2 pass    avg 4.5 calls   1.5 errors   $0.08   ⚠ degraded
```

| Outcome | Meaning |
|---|---|
| pass | every assertion held |
| fail | an assertion did not hold: the model did not get the task done |
| error | the harness could not grade the run: setup or check threw, timeout, budget cap |
| degraded | a flag on any outcome: over the scenario's tool-call or tool-error budget, or called a tool the scenario forbids |

A tool error the model recovered from does not fail the run, but it is counted. That is the
friction this eval exists to find: if the model keeps getting rejected on its first
`createMonitor`, the schema or description needs work even though it got there in the end.

For each failed or degraded run the console lists the failed assertions and the tool calls in
order (name, arguments, ✓ or ✗ with the error). Everything is also written to
`test/llm/results/<timestamp>/` (gitignored):

- `summary.json`: every run's outcome, assertions and tool calls, plus model and git SHA.
- `<scenario>-<n>.jsonl`: the raw Claude stream, for failed, degraded and error runs (all
  runs with `--keep-traces`).

The exit code is 1 when a scenario's pass rate is below `--min-pass-rate` (default 1) or any run
is an error, 2 when the arguments are wrong or `claude` cannot run, and 0 otherwise. A degraded
run alone does not fail.

## Writing a scenario

Add a file to `scenarios/` and list it in `scenarios/index.ts`:

```ts
import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { createMonitor, getMonitor } from '../kuma.js';

export default defineScenario({
  id: 'pause-by-name',
  description: 'Pause a monitor found by name',
  tags: ['monitors'],
  async setup(ctx) {
    return { id: await createMonitor(ctx, { name: `${PREFIX}Shop`, type: 'http', url: 'https://example.com' }) };
  },
  prompt: 'Pause the shop monitor.',
  async check(ctx, seed) {
    const m = await getMonitor(ctx, seed.id);
    return [expectThat('shop monitor is paused', m.active === false, `active=${m.active}`)];
  },
  budget: { maxToolCalls: 4, maxToolErrors: 0 },
});
```

Rules:

- **Name everything `llm-eval-…`** (monitors, tags, maintenance titles, notifications, status
  page slugs). That is how the sweep finds and deletes it, including entities the model creates.
- **Never name a tool in the prompt.** Choosing the tool is part of what is being tested. Write
  the prompt the way a person would ask.
- **Check state, not the reply.** Read the result back with the helpers in `kuma.ts`. Only read
  `trace.finalText` when handing something back is the task (see `create-push-monitor`).
- Return every assertion rather than stopping at the first, and put the actual value in the
  `detail` so a failure says what happened.
- Use `unexpectedTools` for things the model must not do (see `ambiguous-delete`), and
  `budget` for how many calls and errors a task should reasonably take.
- When a scenario fails, decide whether the server or the check is wrong before changing the
  check. A failure that shows a confusing tool is the point of the exercise.

## Layout

| File | What it does |
|---|---|
| `run-llm.sh` | brings the container up and down around `run-llm.ts` |
| `run-llm.ts` | preflight, the scenario × repeat loop, exit code |
| `claude-driver.ts` | starts `claude -p` and turns its stream-json into a `Trace` |
| `scenario.ts` | `defineScenario`, `expectThat`, outcome classification |
| `kuma.ts` | scripted-client helpers: `call`, `getMonitor`, `findMonitor`, `createMonitor`, `sweep` |
| `args.ts`, `report.ts` | command-line options; console summary and results files |
| `scenarios/` | one scenario per file |

The parts that do not need a model have unit tests in `test/unit/llm-*.test.ts`.
