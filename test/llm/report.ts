import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isSecretKey, redactSecrets } from '../../src/redact.js';
import type { RunResult } from './scenario.js';

export interface SummaryRow {
  scenarioId: string;
  passes: number;
  runs: number;
  avgToolCalls: number;
  avgToolErrors: number;
  costUsd: number;
  degraded: boolean;
  passRate: number;
}

export interface Summary {
  rows: SummaryRow[];
  totalCostUsd: number;
  exitCode: 0 | 1;
}

const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarize(results: RunResult[], minPassRate: number): Summary {
  const ids = [...new Set(results.map((r) => r.scenarioId))];
  const rows = ids.map((scenarioId): SummaryRow => {
    const rs = results.filter((r) => r.scenarioId === scenarioId);
    const traced = rs.filter((r) => r.trace);
    const passes = rs.filter((r) => r.outcome === 'pass').length;
    return {
      scenarioId,
      passes,
      runs: rs.length,
      avgToolCalls: avg(traced.map((r) => r.trace!.toolCalls.length)),
      avgToolErrors: avg(traced.map((r) => r.trace!.toolCalls.filter((c) => c.isError).length)),
      costUsd: rs.reduce((sum, r) => sum + (r.trace?.costUsd ?? 0), 0),
      degraded: rs.some((r) => r.degraded),
      passRate: rs.length === 0 ? 0 : passes / rs.length,
    };
  });
  const anyError = results.some((r) => r.outcome === 'error');
  const belowThreshold = rows.some((r) => r.passRate < minPassRate);
  return {
    rows,
    totalCostUsd: rows.reduce((sum, r) => sum + r.costUsd, 0),
    exitCode: anyError || belowThreshold ? 1 : 0,
  };
}

/**
 * Masks `key=value` pairs whose key names a secret (the server's own isSecretKey), so a failed
 * check's detail never prints a credential. Scenario values are fixtures, but console output
 * gets pasted into issues and CI logs.
 */
export function maskSecretPairs(text: string): string {
  return text.replace(/([A-Za-z_][\w.-]*)=(\S+)/g, (whole, key: string) => (isSecretKey(key) ? `${key}=***` : whole));
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatConsole(summary: Summary, results: RunResult[]): string {
  const lines: string[] = [];
  const width = Math.max(20, ...summary.rows.map((r) => r.scenarioId.length + 2));

  for (const r of summary.rows) {
    lines.push(
      [
        r.scenarioId.padEnd(width),
        `${r.passes}/${r.runs} pass`.padEnd(11),
        `avg ${r.avgToolCalls.toFixed(1)} calls`.padEnd(15),
        `${r.avgToolErrors.toFixed(1)} errors`.padEnd(12),
        `$${r.costUsd.toFixed(2)}`,
        r.degraded ? '  ⚠ degraded' : '',
      ].join(' ')
    );
  }

  const runs = results.length;
  const passes = results.filter((r) => r.outcome === 'pass').length;
  const errors = results.filter((r) => r.outcome === 'error').length;
  const ms = results.reduce((sum, r) => sum + (r.trace?.durationMs ?? 0), 0);
  lines.push('');
  lines.push(
    `Total: ${passes}/${runs} runs passed, ${errors} errors, $${summary.totalCostUsd.toFixed(2)}, ${(ms / 1000).toFixed(0)}s in claude`
  );

  const notable = results.filter((r) => r.outcome !== 'pass' || r.degraded);
  for (const r of notable) {
    lines.push('');
    lines.push(`── ${r.scenarioId} #${r.run}: ${r.outcome}${r.degraded ? ' (degraded)' : ''}`);
    if (r.errorMessage) lines.push(`   error: ${maskSecretPairs(r.errorMessage)}`);
    for (const a of r.assertions.filter((a) => !a.ok))
      lines.push(`   ✗ ${a.label}${a.detail ? ` — ${maskSecretPairs(a.detail)}` : ''}`);
    for (const reason of r.degradedReasons) lines.push(`   ⚠ ${reason}`);
    if (r.trace) {
      r.trace.toolCalls.forEach((c, i) => {
        const input = truncate(JSON.stringify(redactSecrets(c.input ?? {})), 80);
        const mark = c.isError ? `✗ ${truncate(maskSecretPairs(c.resultText.replace(/\s+/g, ' ')), 100)}` : '✓';
        lines.push(`   ${String(i + 1).padStart(2)}. ${c.name} ${input} ${mark}`);
      });
      if (r.trace.rawPath) lines.push(`   trace: ${r.trace.rawPath}`);
    }
  }
  return lines.join('\n');
}

export function writeResults(
  dir: string,
  results: RunResult[],
  meta: { model: string; gitSha: string; startedAt: string }
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ...meta, results }, null, 2));
}
