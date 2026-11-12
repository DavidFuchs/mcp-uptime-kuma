import { spawn } from 'child_process';
import { createWriteStream, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
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

export interface ToolCall { name: string; input: unknown; isError: boolean; resultText: string }

export interface Trace {
  /** MCP tool calls only, in order, names without the mcp__uptime-kuma__ prefix. */
  toolCalls: ToolCall[];
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Recorded, never graded (except where returning text is the task). */
  finalText: string;
  rawPath: string;
  /** subtype of the final result message, or 'missing' when the stream had none. */
  resultSubtype: string;
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

export function buildMcpConfig(config: TestConfig, repoRoot: string): object {
  const env: Record<string, string> = { UPTIME_KUMA_URL: config.url };
  if (config.username) env.UPTIME_KUMA_USERNAME = config.username;
  if (config.password) env.UPTIME_KUMA_PASSWORD = config.password;
  if (config.jwtToken) env.UPTIME_KUMA_JWT_TOKEN = config.jwtToken;
  env.MCP_TEST_MODE = '1';
  return {
    mcpServers: {
      'uptime-kuma': {
        command: 'npx',
        args: ['tsx', join(repoRoot, 'src/index.ts'), '-t', 'stdio'],
        env,
      },
    },
  };
}

export function buildClaudeArgs(opts: { prompt: string; model: string; maxBudgetUsd: number; mcpConfigPath: string }): string[] {
  return [
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', opts.mcpConfigPath,
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', `${MCP_PREFIX}*`,
    '--setting-sources', '',
    '--no-session-persistence',
    '--model', opts.model,
    '--max-budget-usd', String(opts.maxBudgetUsd),
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
    return content
      .map((c: any) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join('');
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
    if (msg.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(MCP_PREFIX)) {
          const call: ToolCall = { name: block.name.slice(MCP_PREFIX.length), input: block.input, isError: false, resultText: '' };
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
      resultSubtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown';
      costUsd = Number(msg.total_cost_usd) || 0;
      durationMs = Number(msg.duration_ms) || 0;
      turns = Number(msg.num_turns) || 0;
      finalText = typeof msg.result === 'string' ? msg.result : '';
    }
  }

  return { toolCalls, turns, costUsd, durationMs, finalText, rawPath, resultSubtype };
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
  const args = buildClaudeArgs({ prompt: opts.prompt, model: opts.model, maxBudgetUsd: opts.maxBudgetUsd, mcpConfigPath });

  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
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
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); raw.write(d); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        raw.end();
        reject(new ClaudeTimeoutError(opts.timeoutMs));
      }, opts.timeoutMs);
      child.on('error', e => { clearTimeout(timer); raw.end(); reject(e); });
      child.on('close', c => { clearTimeout(timer); raw.end(() => resolve({ stdout: out, stderr: err, code: c })); });
    });

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
