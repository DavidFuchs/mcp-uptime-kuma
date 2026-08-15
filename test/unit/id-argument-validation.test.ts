import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';
import { createServer } from '../../src/server.js';

/**
 * Issue #65, first half: required record IDs were declared `z.coerce.number()`.
 *
 * Coercion runs `Number()` over whatever arrives, which costs twice:
 *
 * 1. An ABSENT field coerces to NaN, so omitting `monitorID` (or misspelling it, since the
 *    unknown key is rejected and the declared one is then missing) reported
 *    "expected number, received nan" — a type complaint about a field the caller never wrote,
 *    rather than "this required field is missing".
 * 2. `Number(null)`, `Number('')` and `Number([])` are all 0, and `Number(true)` is 1. So
 *    `getMonitor {monitorID: null}` did not fail — it silently read monitor 0. Junk arguments
 *    became real IDs, which is the more damaging half.
 *
 * The fix keeps string IDs working (clients that stringify arguments are common) while
 * rejecting everything that was previously coerced into a plausible-looking ID.
 */

type RegisteredTool = { inputSchema?: z.ZodObject<z.ZodRawShape> };

let tools: Record<string, RegisteredTool>;

beforeAll(async () => {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });
  tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
});

/** The single issue reported against `field`, or undefined if the field was accepted. */
function issueFor(toolName: string, args: Record<string, unknown>, field: string) {
  const schema = tools[toolName].inputSchema!;
  const result = schema.safeParse(args);
  if (result.success) return undefined;
  return result.error.issues.find((i) => i.path[0] === field);
}

describe('required ID arguments (#65)', () => {
  it('reports an omitted monitorID as missing rather than as NaN', () => {
    const issue = issueFor('getMonitor', {}, 'monitorID');

    expect(issue).toBeDefined();
    // The whole complaint of #65: the error described a NaN type mismatch instead of an
    // absent field, sending the caller hunting for a type bug that was never there.
    expect(JSON.stringify(issue)).not.toMatch(/nan/i);
    expect(issue!.message).toMatch(/required|undefined|missing/i);
  });

  /**
   * The exact reproduction from the issue. #70 made the unknown key the first thing reported,
   * but the NaN line was still there underneath it; now the second line names the real
   * consequence — the declared field ended up absent.
   */
  it('reports a misspelled monitorId without a NaN complaint underneath it', () => {
    const result = tools.getMonitor.inputSchema!.safeParse({ monitorId: 1 });

    expect(result.success).toBe(false);
    const messages = (result as { error: z.ZodError }).error.issues.map((i) => i.message);
    expect(messages[0]).toMatch(/monitorId/);
    expect(messages.join('\n')).not.toMatch(/nan/i);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['an empty array', []],
    ['a boolean', true],
    ['a non-numeric string', 'abc'],
    ['a float', 1.5],
    ['a negative number', -1],
  ])('rejects %s instead of coercing it into an ID', (_label, value) => {
    expect(issueFor('getMonitor', { monitorID: value }, 'monitorID')).toBeDefined();
  });

  it('accepts a numeric ID', () => {
    expect(tools.getMonitor.inputSchema!.safeParse({ monitorID: 7 }))
      .toMatchObject({ success: true, data: { monitorID: 7 } });
  });

  it('accepts a stringified ID, for clients that stringify their arguments', () => {
    expect(tools.getMonitor.inputSchema!.safeParse({ monitorID: '7' }))
      .toMatchObject({ success: true, data: { monitorID: 7 } });
  });

  it('accepts zero, which is a valid ID', () => {
    expect(tools.getMonitor.inputSchema!.safeParse({ monitorID: 0 }))
      .toMatchObject({ success: true, data: { monitorID: 0 } });
  });

  /**
   * The coercion was spelled the same way on every record ID, so fixing only the one named in
   * the issue would leave the same trap on notifications, docker hosts and tags. Swept rather
   * than listed so a tool added later cannot quietly reintroduce it.
   */
  it('holds for every required ID field on every tool', () => {
    const idField = /(^|[a-z])ID$/;
    const offenders: string[] = [];
    let checked = 0;

    for (const [toolName, tool] of Object.entries(tools)) {
      const shape = tool.inputSchema?.shape;
      if (!shape) continue;

      for (const [field, fieldSchema] of Object.entries(shape)) {
        if (!idField.test(field) || fieldSchema.isOptional()) continue;
        checked++;

        for (const junk of [null, '', [], true]) {
          const result = tool.inputSchema!.safeParse({ [field]: junk });
          const issue = result.success
            ? undefined
            : result.error.issues.find((i) => i.path[0] === field);
          if (!issue) offenders.push(`${toolName}.${field} accepted ${JSON.stringify(junk)}`);
        }

        const missing = tool.inputSchema!.safeParse({});
        const missingIssue = missing.success
          ? undefined
          : missing.error.issues.find((i) => i.path[0] === field);
        if (missingIssue && /nan/i.test(JSON.stringify(missingIssue))) {
          offenders.push(`${toolName}.${field} reports NaN when omitted`);
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
