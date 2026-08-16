import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { createServer } from '../../src/server.js';

/**
 * The write-path half of the coercion problem behind #65.
 *
 * Required record IDs were fixed first, but every OTHER numeric argument was still
 * `z.coerce.number()`, and coercion runs `Number()` over whatever arrives:
 * `Number(null)`, `Number('')` and `Number([])` are 0, and `Number(true)` is 1. On the read
 * tools that returned the wrong record; on the write tools it STORES the wrong config.
 *
 * The motivating case is `timeout`. Its own field description warns that a stored 0 makes
 * Uptime Kuma compute a ~13 hour timeout, so the monitor can never report DOWN against a host
 * that accepts the connection and never answers. `.nullable()` happened to protect
 * `timeout: null`, but nothing protected `timeout: ''` — which wrote exactly that 0 and
 * silently disabled DOWN detection for the monitor.
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

/**
 * Unwraps optional/nullable/default/effect layers to ask what a field really is.
 *
 * Deliberately recognises numeric fields in BOTH spellings — the old `z.coerce.number()`
 * (a bare ZodNumber) and the new preprocess wrapper (ZodEffects around a ZodNumber) — so the
 * sweep below finds the same fields before and after the fix. A detector that only matched the
 * new shape would find nothing in the old code and pass vacuously.
 */
function classify(schema: z.ZodTypeAny): { numeric: boolean; nullable: boolean } {
  let current: z.ZodTypeAny = schema;
  let nullable = false;

  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      if (current instanceof z.ZodNullable) nullable = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    break;
  }

  if (current instanceof z.ZodUnion) {
    const options = current.options as z.ZodTypeAny[];
    const parts = options.map(classify);
    return {
      numeric: parts.some((p) => p.numeric),
      nullable: nullable || options.some((o) => o instanceof z.ZodNull) || parts.some((p) => p.nullable),
    };
  }

  return { numeric: current instanceof z.ZodNumber, nullable };
}

/** Every (tool, field) pair whose field accepts a number. */
function numericFields(): Array<{ tool: string; field: string; nullable: boolean }> {
  const found: Array<{ tool: string; field: string; nullable: boolean }> = [];
  for (const [toolName, tool] of Object.entries(tools)) {
    const shape = tool.inputSchema?.shape;
    if (!shape) continue;
    for (const [field, fieldSchema] of Object.entries(shape)) {
      const { numeric, nullable } = classify(fieldSchema as z.ZodTypeAny);
      if (numeric) found.push({ tool: toolName, field, nullable });
    }
  }
  return found;
}

/** Parses `args`, returning the issue raised against `field`, if any. */
function issueFor(toolName: string, field: string, value: unknown) {
  // updateMonitor and friends need their own required ID present, or the only issue reported
  // is the missing ID and the field under test is never reached.
  const required: Record<string, unknown> = {
    monitorID: 1,
    notificationID: 1,
    dockerHostID: 1,
    tagID: 1,
    name: 'x',
    type: 'http',
    title: 'x',
    strategy: 'single',
    active: true,
  };
  const args: Record<string, unknown> = {};
  for (const [key] of Object.entries(tools[toolName].inputSchema!.shape)) {
    if (key !== field && key in required) args[key] = required[key];
  }
  args[field] = value;

  const result = tools[toolName].inputSchema!.safeParse(args);
  if (result.success) return undefined;
  return result.error.issues.find((i) => i.path[0] === field);
}

describe('numeric arguments reject junk instead of coercing it', () => {
  it.each([
    ['createMonitor', { name: 'x', type: 'http' }],
    ['updateMonitor', { monitorID: 1 }],
  ])('%s: timeout:"" does not become the 0 that disables DOWN detection', (tool, base) => {
    const parsed = tools[tool].inputSchema!.safeParse({ ...base, timeout: '' });

    // Guard against passing vacuously: if the whole object were rejected for an unrelated
    // reason (a missing required field, a key the strict schema does not know), `timeout`
    // would never be examined at all and the assertion below would prove nothing.
    const timeoutIssue = parsed.success
      ? undefined
      : parsed.error.issues.find((i) => i.path[0] === 'timeout');
    const otherIssues = parsed.success
      ? []
      : parsed.error.issues.filter((i) => i.path[0] !== 'timeout').map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(otherIssues, `${tool} rejected the fixture for an unrelated reason`).toEqual([]);

    if (parsed.success) {
      expect((parsed.data as { timeout?: unknown }).timeout, `${tool} coerced timeout:"" to 0`).not.toBe(0);
    } else {
      expect(timeoutIssue).toBeDefined();
    }
  });

  it('timeout: null is still accepted, because null is a meaningful value there', () => {
    const parsed = tools.updateMonitor.inputSchema!.safeParse({ monitorID: 1, timeout: null });
    expect(parsed).toMatchObject({ success: true, data: { timeout: null } });
  });

  it('interval: junk does not silently become 0', () => {
    for (const junk of [null, '', [], true]) {
      expect(issueFor('updateMonitor', 'interval', junk), `interval accepted ${JSON.stringify(junk)}`)
        .toBeDefined();
    }
  });

  it('holds for every numeric field on every tool', () => {
    const fields = numericFields();
    expect(fields.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const { tool, field, nullable } of fields) {
      // `null` is junk only where the field does not explicitly allow it.
      const junkValues: unknown[] = nullable ? ['', [], true] : [null, '', [], true];
      for (const junk of junkValues) {
        if (!issueFor(tool, field, junk)) {
          offenders.push(`${tool}.${field} accepted ${JSON.stringify(junk)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still accepts the values callers legitimately send', () => {
    const cases: Array<[string, string, unknown, unknown]> = [
      ['updateMonitor', 'interval', 60, 60],
      ['updateMonitor', 'interval', '60', 60],
      ['updateMonitor', 'interval', '  60  ', 60],
      ['updateMonitor', 'timeout', 4.8, 4.8],
      ['updateMonitor', 'timeout', '4.8', 4.8],
      ['updateMonitor', 'parent', null, null],
      ['getHeartbeats', 'maxHeartbeats', '10', 10],
      ['listMonitors', 'parentId', '3', 3],
      ['listMonitors', 'parentId', null, null],
    ];
    for (const [tool, field, input, expected] of cases) {
      const args: Record<string, unknown> = { [field]: input };
      if ('monitorID' in tools[tool].inputSchema!.shape) args.monitorID = 1;
      const parsed = tools[tool].inputSchema!.safeParse(args);
      expect(parsed.success, `${tool}.${field} rejected ${JSON.stringify(input)}`).toBe(true);
      expect((parsed as { data: Record<string, unknown> }).data[field]).toBe(expected);
    }
  });

  it('reports what actually arrived rather than a NaN', () => {
    const issue = issueFor('updateMonitor', 'interval', null);
    expect(JSON.stringify(issue)).not.toMatch(/nan/i);
    expect(issue!.message).toMatch(/null/i);
  });

  /** Nested numerics are the easiest to miss, being neither top-level nor swept above. */
  it('applies inside createMaintenance time ranges', () => {
    const withHours = (hours: unknown) => tools.createMaintenance.inputSchema!.safeParse({
      title: 'x',
      strategy: 'recurring-interval',
      timeRange: [{ hours, minutes: 0 }],
    });
    expect(withHours('').success, 'timeRange hours accepted ""').toBe(false);
    expect(withHours(null).success, 'timeRange hours accepted null').toBe(false);
    expect(withHours(9)).toMatchObject({ success: true });
    expect(withHours('9')).toMatchObject({ success: true });
  });
});
