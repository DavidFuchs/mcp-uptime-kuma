import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import type { z } from 'zod';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { createServer } from '../../src/server.js';
import { injectMonitorListCache } from './helpers.js';

/**
 * getMonitorList({ parentId }) — issue #65.
 *
 * There was no parent filter at all, so a caller asking for one group's members got every
 * monitor back. The distinction that matters here is `undefined` (no filter) versus `null`
 * (top-level only): conflating them via a truthiness check silently breaks one of the two.
 */
describe('UptimeKumaClient - getMonitorList parentId filter', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
    injectMonitorListCache(client, {
      '1': { id: 1, name: 'Group A', type: 'group', parent: null, pathName: 'Group A', active: true },
      '2': { id: 2, name: 'Child A1', type: 'http', parent: 1, pathName: 'Group A / Child A1', active: true },
      '3': { id: 3, name: 'Child A2', type: 'http', parent: 1, pathName: 'Group A / Child A2', active: true },
      '4': { id: 4, name: 'Group B', type: 'group', parent: null, pathName: 'Group B', active: true },
      '5': { id: 5, name: 'Child B1', type: 'http', parent: 4, pathName: 'Group B / Child B1', active: true },
      '6': { id: 6, name: 'Grandchild', type: 'http', parent: 5, pathName: 'Group B / Child B1 / Grandchild', active: true },
    });
  });

  it('returns only the direct children of the given group', () => {
    const result = client.getMonitorList({ parentId: 1 });
    expect(Object.keys(result).sort()).toEqual(['2', '3']);
  });

  it('is not recursive — a grandchild is not returned', () => {
    const result = client.getMonitorList({ parentId: 4 });
    expect(Object.keys(result)).toEqual(['5']);
    expect(result['6']).toBeUndefined();
  });

  it('parentId null returns only top-level monitors', () => {
    const result = client.getMonitorList({ parentId: null });
    expect(Object.keys(result).sort()).toEqual(['1', '4']);
  });

  it('omitting parentId returns everything (undefined is not the same as null)', () => {
    expect(Object.keys(client.getMonitorList({})).length).toBe(6);
    expect(Object.keys(client.getMonitorList()).length).toBe(6);
  });

  it('parentId 0 is treated as a real id, not as "no filter"', () => {
    // Guards against a truthiness check: `if (filters.parentId)` would skip filtering here.
    const result = client.getMonitorList({ parentId: 0 });
    expect(Object.keys(result).length).toBe(0);
  });

  it('combines with other filters rather than replacing them', () => {
    const result = client.getMonitorList({ parentId: 1, type: 'http' });
    expect(Object.keys(result).sort()).toEqual(['2', '3']);
    expect(Object.keys(client.getMonitorList({ parentId: 1, type: 'group' })).length).toBe(0);
  });
});

/**
 * getMonitorSummary is the tool the instructions send callers to FIRST for status questions
 * ("what's down?"), so "what's down in this group?" lands there rather than on listMonitors.
 * The parent filter added for #65 only reached getMonitorList, so that question could not be
 * asked of the one tool most likely to be asked it.
 *
 * The two functions each keep their own copy of the same filter loop, which is how they came
 * to disagree in the first place — the same copy-paste divergence behind the rest of #65.
 */
describe('UptimeKumaClient - getMonitorSummary parentId filter', () => {
  let client: UptimeKumaClient;

  beforeEach(() => {
    client = new UptimeKumaClient('http://localhost:3001');
    injectMonitorListCache(client, {
      '1': { id: 1, name: 'Group A', type: 'group', parent: null, pathName: 'Group A', active: true },
      '2': { id: 2, name: 'Child A1', type: 'http', parent: 1, pathName: 'Group A / Child A1', active: true },
      '3': { id: 3, name: 'Child A2', type: 'http', parent: 1, pathName: 'Group A / Child A2', active: true },
      '4': { id: 4, name: 'Group B', type: 'group', parent: null, pathName: 'Group B', active: true },
      '5': { id: 5, name: 'Child B1', type: 'http', parent: 4, pathName: 'Group B / Child B1', active: true },
      '6': { id: 6, name: 'Grandchild', type: 'http', parent: 5, pathName: 'Group B / Child B1 / Grandchild', active: true },
    });
  });

  const ids = (summaries: Array<{ id: number }>) => summaries.map((s) => s.id).sort((a, b) => a - b);

  it('returns only the direct children of the given group', () => {
    expect(ids(client.getMonitorSummary({ parentId: 1 }))).toEqual([2, 3]);
  });

  it('is not recursive — a grandchild is not returned', () => {
    expect(ids(client.getMonitorSummary({ parentId: 4 }))).toEqual([5]);
  });

  it('parentId null returns only top-level monitors', () => {
    expect(ids(client.getMonitorSummary({ parentId: null }))).toEqual([1, 4]);
  });

  it('omitting parentId returns everything (undefined is not the same as null)', () => {
    expect(client.getMonitorSummary({}).length).toBe(6);
    expect(client.getMonitorSummary().length).toBe(6);
  });

  it('parentId 0 is treated as a real id, not as "no filter"', () => {
    expect(client.getMonitorSummary({ parentId: 0 }).length).toBe(0);
  });

  it('combines with other filters rather than replacing them', () => {
    expect(ids(client.getMonitorSummary({ parentId: 1, type: 'http' }))).toEqual([2, 3]);
    expect(client.getMonitorSummary({ parentId: 1, type: 'group' }).length).toBe(0);
  });

  it('agrees with getMonitorList about which monitors are in a group', () => {
    for (const parentId of [null, 0, 1, 4, 5]) {
      expect(ids(client.getMonitorSummary({ parentId })))
        .toEqual(Object.keys(client.getMonitorList({ parentId })).map(Number).sort((a, b) => a - b));
    }
  });
});

/**
 * The filter also has to survive the tool boundary: schemas are `.strict()`, so a `parentId`
 * the tool does not declare is rejected outright no matter what the client supports.
 */
describe('parentId at the tool boundary', () => {
  let tools: Record<string, { inputSchema?: z.ZodObject<z.ZodRawShape> }>;

  beforeAll(async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    tools = (server as unknown as { _registeredTools: typeof tools })._registeredTools;
  });

  it.each(['listMonitors', 'getMonitorSummary'])('%s accepts a group id and null', (toolName) => {
    expect(tools[toolName].inputSchema!.safeParse({ parentId: 3 }))
      .toMatchObject({ success: true, data: { parentId: 3 } });
    expect(tools[toolName].inputSchema!.safeParse({ parentId: null }))
      .toMatchObject({ success: true, data: { parentId: null } });
  });

  it.each(['listMonitors', 'getMonitorSummary'])('%s still distinguishes omitted from null', (toolName) => {
    const parsed = tools[toolName].inputSchema!.safeParse({});
    expect(parsed.success).toBe(true);
    expect((parsed as { data: Record<string, unknown> }).data.parentId).toBeUndefined();
  });
});
