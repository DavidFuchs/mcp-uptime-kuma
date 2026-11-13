import { spawn } from 'child_process';
import { createWriteStream, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { finished } from 'stream';
import { join } from 'path';
import type { TestConfig } from '../integration/helpers.js';

/**
 * Runs one headless Claude Code session against this MCP server and turns its stream-json
 * output into a Trace.
 *
 * Isolation (see the design spec): only our MCP server is loaded, no built-in tools, no user or
 * project settings, an empty working directory, and no ambient UPTIME_KUMA_* variables. --bare
 * is deliberately not used: it refuses the developer's OAuth login.
 */

const MCP_PREFIX = 'mcp__uptime-kuma__';

export interface ToolCall {
  name: string;
  input: unknown;
  isError: boolean;
  resultText: string;
}

export interface Trace {
  /** MCP tool calls only, in order, names without the mcp__uptime-kuma__ prefix. */
  toolCalls: ToolCall[];
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Recorded, never graded (except where returning text is the task). */
  finalText: string;
  rawPath: string;
  /**
   * subtype of the final result message; 'is_error' when that message has is_error set (a
   * logged-out or rate-limited claude still reports subtype 'success'); 'missing' when the
   * stream had none.
   */
  resultSubtype: string;
  /** Status of the uptime-kuma MCP server in the init message ('connected', 'failed', ...). */
  mcpStatus?: string;
  /** HTTP status of the API error that ended a failed session (e.g. 529 overloaded), if any. */
  apiErrorStatus?: number;
}

/** Why a session that did not succeed ended, for error messages: its reply, else the API status. */
export function failureDetail(trace: Trace): string {
  const parts = [];
  if (trace.finalText) parts.push(trace.finalText);
  if (trace.apiErrorStatus !== undefined) parts.push(`API error ${trace.apiErrorStatus}`);
  return parts.length ? `: ${parts.join(' — ')}` : '';
}

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  config: TestConfig;
  rawPath: string;
}

export class ClaudeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`claude did not finish within ${timeoutMs}ms`);
    this.name = 'ClaudeTimeoutError';
  }
}

export class ClaudeAbortedError extends Error {
  constructor() {
    super('claude session aborted');
    this.name = 'ClaudeAbortedError';
  }
}

// The session in flight, if any. claude runs in its own process group (so a timeout can take
// the MCP server down with it), which also means a terminal's Ctrl+C never reaches it.
let activeAbort: (() => void) | null = null;

/** Kills the running claude session and its process group. Returns whether one was running. */
export function abortActiveClaude(): boolean {
  if (!activeAbort) return false;
  activeAbort();
  return true;
}

export function buildMcpConfig(config: TestConfig, repoRoot: string): object {
  const env: Record<string, string> = { UPTIME_KUMA_URL: config.url };
  if (config.username) env.UPTIME_KUMA_USERNAME = config.username;
  if (config.password) env.UPTIME_KUMA_PASSWORD = config.password;
  if (config.jwtToken) env.UPTIME_KUMA_JWT_TOKEN = config.jwtToken;
  env.MCP_TEST_MODE = '1';
  return {
    mcpServers: {
      'uptime-kuma': {
        // The repo's own tsx, run by this node. `npx tsx` from the empty temp cwd would resolve
        // tsx from the npx cache or the registry instead.
        command: process.execPath,
        args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'src/index.ts'), '-t', 'stdio'],
        env,
      },
    },
  };
}

export function buildClaudeArgs(opts: {
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  mcpConfigPath: string;
}): string[] {
  return [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    opts.mcpConfigPath,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    `${MCP_PREFIX}*`,
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--model',
    opts.model,
    '--max-budget-usd',
    String(opts.maxBudgetUsd),
  ];
}

/** The parent env minus every UPTIME_KUMA_* variable, so the model can never reach a real instance. */
export function buildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (!k.startsWith('UPTIME_KUMA_')) env[k] = v;
  }
  return env;
}

function resultContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function parseStreamJson(lines: string[], rawPath: string): Trace {
  const byId = new Map<string, ToolCall>();
  const toolCalls: ToolCall[] = [];
  let turns = 0;
  let costUsd = 0;
  let durationMs = 0;
  let finalText = '';
  let resultSubtype = 'missing';
  let mcpStatus: string | undefined;
  let apiErrorStatus: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.mcp_servers)) {
      mcpStatus = msg.mcp_servers.find((m: any) => m?.name === 'uptime-kuma')?.status;
    } else if (msg.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(MCP_PREFIX)) {
          const call: ToolCall = {
            name: block.name.slice(MCP_PREFIX.length),
            input: block.input,
            isError: false,
            resultText: '',
          };
          byId.set(block.id, call);
          toolCalls.push(call);
        }
      }
    } else if (msg.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.isError = block.is_error === true;
        call.resultText = resultContentText(block.content);
      }
    } else if (msg.type === 'result') {
      resultSubtype = msg.is_error === true ? 'is_error' : typeof msg.subtype === 'string' ? msg.subtype : 'unknown';
      costUsd = Number(msg.total_cost_usd) || 0;
      durationMs = Number(msg.duration_ms) || 0;
      turns = Number(msg.num_turns) || 0;
      finalText = typeof msg.result === 'string' ? msg.result : '';
      if (typeof msg.api_error_status === 'number') apiErrorStatus = msg.api_error_status;
    }
  }

  return { toolCalls, turns, costUsd, durationMs, finalText, rawPath, resultSubtype, mcpStatus, apiErrorStatus };
}

/** Throws unless the session succeeded and the uptime-kuma MCP server connected. Used by preflight. */
export function assertProbeTrace(trace: Trace): void {
  if (trace.resultSubtype !== 'success') {
    throw new Error(`claude session ended with ${trace.resultSubtype}${failureDetail(trace)}`);
  }
  if (trace.mcpStatus !== 'connected') {
    throw new Error(`MCP server uptime-kuma did not connect (status: ${trace.mcpStatus ?? 'not reported'})`);
  }
}

export async function runClaude(opts: ClaudeRunOptions): Promise<Trace> {
  const workDir = mkdtempSync(join(tmpdir(), 'llm-eval-'));
  const cwd = join(workDir, 'cwd');
  const mcpConfigPath = join(workDir, 'mcp.json');
  const repoRoot = join(import.meta.dirname, '../..');
  // Empty cwd: the repo's CLAUDE.md / AGENTS.md must not be picked up.
  mkdirSync(cwd);
  writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(opts.config, repoRoot)));

  const bin = process.env.CLAUDE_BIN ?? 'claude';
  const args = buildClaudeArgs({
    prompt: opts.prompt,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
    mcpConfigPath,
  });

  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        const child = spawn(bin, args, {
          cwd,
          env: buildChildEnv(process.env),
          stdio: ['ignore', 'pipe', 'pipe'],
          // Own process group, so a timeout also kills the MCP server claude started.
          detached: true,
        });
        const raw = createWriteStream(opts.rawPath);
        let out = '';
        let err = '';
        let settled = false;
        const killGroup = () => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        };
        const fail = (e: unknown) => {
          if (settled) return;
          settled = true;
          activeAbort = null;
          clearTimeout(timer);
          killGroup();
          reject(e);
        };
        activeAbort = () => fail(new ClaudeAbortedError());
        // raw is only ever ended in 'close', after the last stdout chunk, so no write can follow it.
        raw.on('error', fail);
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (!raw.writableEnded) raw.write(d);
        });
        child.stderr.on('data', (d: Buffer) => {
          err += d.toString();
        });
        const timer = setTimeout(() => fail(new ClaudeTimeoutError(opts.timeoutMs)), opts.timeoutMs);
        child.on('error', fail);
        child.on('close', (c) => {
          clearTimeout(timer);
          if (!settled) activeAbort = null;
          // finished() rather than end(cb): if the trace file never opened (bad path), the
          // child can exit before the stream's 'error' event fires, and that error must
          // still reject rather than be swallowed by a successful-looking resolve.
          raw.end();
          finished(raw, (e) => {
            if (e) return fail(e);
            if (settled) return;
            settled = true;
            resolve({ stdout: out, stderr: err, code: c });
          });
        });
      }
    );

    const trace = parseStreamJson(stdout.split('\n'), opts.rawPath);
    if (trace.resultSubtype === 'missing') {
      const why = stderr.trim().split('\n').slice(-3).join(' | ') || `exit code ${code}`;
      throw new Error(`claude exited without a result message: ${why}`);
    }
    return trace;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
