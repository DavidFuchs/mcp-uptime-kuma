import { describe, it, expect } from 'vitest';
import { classify, expectThat, PREFIX } from '../llm/scenario.js';
import { sweep, call, hostAndPort } from '../llm/kuma.js';
import type { Trace, ToolCall } from '../llm/claude-driver.js';

const trace = (calls: Partial<ToolCall>[] = [], resultSubtype = 'success'): Trace => ({
  toolCalls: calls.map(c => ({ name: 'listMonitors', input: {}, isError: false, resultText: '', ...c })),
  turns: 1, costUsd: 0, durationMs: 0, finalText: '', rawPath: '', resultSubtype,
});

describe('classify', () => {
  it('all assertions true → pass, not degraded', () => {
    const r = classify({ assertions: [expectThat('a', true), expectThat('b', true)], trace: trace(), scenario: {} });
    expect(r.outcome).toBe('pass');
    expect(r.degraded).toBe(false);
    expect(r.degradedReasons).toEqual([]);
  });

  it('any assertion false → fail', () => {
    const r = classify({ assertions: [expectThat('a', true), expectThat('b', false)], trace: trace(), scenario: {} });
    expect(r.outcome).toBe('fail');
  });

  it('error present → error, regardless of assertions', () => {
    const r = classify({ assertions: [expectThat('a', true)], trace: trace(), error: new Error('setup blew up'), scenario: {} });
    expect(r.outcome).toBe('error');
    expect(r.errorMessage).toContain('setup blew up');
  });

  it("trace.resultSubtype !== 'success' → error", () => {
    const r = classify({ assertions: [expectThat('a', true)], trace: trace([], 'error_max_budget_usd'), scenario: {} });
    expect(r.outcome).toBe('error');
    expect(r.errorMessage).toContain('error_max_budget_usd');
  });

  it('over maxToolCalls on a pass → pass + degraded', () => {
    const r = classify({
      assertions: [expectThat('a', true)],
      trace: trace(Array.from({ length: 9 }, () => ({}))),
      scenario: { budget: { maxToolCalls: 8 } },
    });
    expect(r.outcome).toBe('pass');
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons).toContain('tool calls 9 > 8');
  });

  it('over maxToolErrors on a pass → degraded', () => {
    const r = classify({
      assertions: [expectThat('a', true)],
      trace: trace([{ isError: true }, { isError: true }]),
      scenario: { budget: { maxToolErrors: 1 } },
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons).toContain('tool errors 2 > 1');
  });

  it('unexpected tool called → degraded', () => {
    const r = classify({
      assertions: [expectThat('a', false)],
      trace: trace([{ name: 'deleteMonitor' }]),
      scenario: { unexpectedTools: ['deleteMonitor'] },
    });
    expect(r.outcome).toBe('fail');
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons).toContain('called unexpected tool deleteMonitor');
  });
});

describe('sweep', () => {
  function fakeCtx(data: Record<string, unknown>) {
    const calls: Array<{ name: string; arguments: any }> = [];
    const client = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: any }) => {
        calls.push({ name, arguments: args });
        const sc = data[name] ?? {};
        return { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc };
      },
    };
    return { ctx: { client, config: { url: 'x' } } as any, calls };
  }

  it('sweep deletes only llm-eval- prefixed entities', async () => {
    const { ctx, calls } = fakeCtx({
      listMonitors: { monitors: [{ id: 1, name: `${PREFIX}a` }, { id: 2, name: 'keep-me' }] },
      listTags: { tags: [{ id: 5, name: `${PREFIX}prod` }, { id: 6, name: 'prod' }] },
      getMaintenanceWindows: { maintenanceWindows: [{ id: 7, title: `${PREFIX}DB` }, { id: 8, title: 'real' }] },
      listNotifications: { notifications: [{ id: 9, name: `${PREFIX}hook` }, { id: 10, name: 'pager' }] },
      listStatusPages: { statusPages: [{ slug: `${PREFIX}page`, title: 'x' }, { slug: 'public', title: 'Public' }] },
    });
    const n = await sweep(ctx);
    const deletes = calls.filter(c => c.name.startsWith('delete'));
    expect(deletes).toEqual([
      { name: 'deleteMonitor', arguments: { monitorID: 1 } },
      { name: 'deleteTag', arguments: { tagID: 5 } },
      { name: 'deleteMaintenance', arguments: { maintenanceID: 7 } },
      { name: 'deleteNotification', arguments: { notificationID: 9 } },
      { name: 'deleteStatusPage', arguments: { slug: `${PREFIX}page` } },
    ]);
    expect(n).toBe(5);
  });
});

describe('sweep with nested groups and docker hosts', () => {
  it('deletes the deepest monitors first and ignores ones already gone', async () => {
    const deleted: number[] = [];
    const gone = new Set<number>();
    // 1 is a group holding group 2, which holds 3. Deleting a group takes its children with it,
    // as Uptime Kuma may do.
    const monitors = [
      { id: 1, name: `${PREFIX}top`, parent: null },
      { id: 2, name: `${PREFIX}mid`, parent: 1 },
      { id: 3, name: `${PREFIX}leaf`, parent: 2 },
      { id: 4, name: `${PREFIX}solo`, parent: null },
    ];
    const childrenOf = (id: number): number[] => monitors.filter(m => m.parent === id).flatMap(m => [m.id, ...childrenOf(m.id)]);
    const client = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: any }) => {
        const ok = (sc: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc });
        if (name === 'listMonitors') return ok({ monitors: monitors.filter(m => !gone.has(m.id)) });
        if (name === 'deleteMonitor') {
          if (gone.has(args.monitorID)) return { isError: true, content: [{ type: 'text', text: `Monitor with ID ${args.monitorID} not found` }] };
          deleted.push(args.monitorID);
          for (const id of [args.monitorID, ...childrenOf(args.monitorID)]) gone.add(id);
          return ok({ ok: true });
        }
        return ok({});
      },
    };
    await sweep({ client, config: { url: 'x' } } as any);
    expect(deleted.indexOf(3)).toBeLessThan(deleted.indexOf(2));
    expect(deleted.indexOf(2)).toBeLessThan(deleted.indexOf(1));
    expect([...deleted].sort()).toEqual([1, 2, 3, 4]);
  });

  it('carries on when a group delete already removed a child', async () => {
    let listed = false;
    const client = {
      callTool: async ({ name }: { name: string; arguments: any }) => {
        const ok = (sc: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc });
        if (name === 'listMonitors') {
          if (listed) return ok({ monitors: [] });
          listed = true;
          return ok({ monitors: [{ id: 9, name: `${PREFIX}x`, parent: null }] });
        }
        if (name === 'deleteMonitor') return { isError: true, content: [{ type: 'text', text: 'Failed to delete monitor: Monitor with ID 9 not found' }] };
        return ok({});
      },
    };
    await expect(sweep({ client, config: { url: 'x' } } as any)).resolves.toBe(0);
  });

  it('deletes llm-eval- docker hosts', async () => {
    const calls: Array<{ name: string; arguments: any }> = [];
    const client = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: any }) => {
        calls.push({ name, arguments: args });
        const sc = name === 'listDockerHosts' ? { dockerHosts: [{ id: 3, name: `${PREFIX}host` }, { id: 4, name: 'prod-host' }] } : {};
        return { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc };
      },
    };
    await sweep({ client, config: { url: 'x' } } as any);
    expect(calls.filter(c => c.name === 'deleteDockerHost')).toEqual([{ name: 'deleteDockerHost', arguments: { dockerHostID: 3 } }]);
  });
});

describe('call', () => {
  it('throws with the tool text when the result is an error', async () => {
    const ctx = { client: { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] }) } } as any;
    await expect(call(ctx, 'getMonitor', { monitorID: 1 })).rejects.toThrow(/nope/);
  });

  it('prefers structuredContent over text', async () => {
    const ctx = { client: { callTool: async () => ({ content: [{ type: 'text', text: 'Monitor 3' }], structuredContent: { monitor: { id: 3 } } }) } } as any;
    expect(await call(ctx, 'getMonitor', { monitorID: 3 })).toEqual({ monitor: { id: 3 } });
  });
});

describe('hostAndPort', () => {
  it('reads host and port with or without a scheme', () => {
    expect(hostAndPort('mqtt://broker.example.com:1883')).toEqual({ host: 'broker.example.com', port: '1883' });
    expect(hostAndPort('broker.example.com')).toEqual({ host: 'broker.example.com', port: '' });
    expect(hostAndPort('tcp://10.0.0.9:2375')).toEqual({ host: '10.0.0.9', port: '2375' });
  });

  it('does not take a host that only appears in the path or as a prefix', () => {
    expect(hostAndPort('mqtt://evil.test/broker.example.com').host).toBe('evil.test');
    expect(hostAndPort('mqtt://broker.example.com.evil.test').host).toBe('broker.example.com.evil.test');
  });

  it('returns an empty host for something that is not an address', () => {
    expect(hostAndPort(undefined).host).toBe('');
    expect(hostAndPort('not a host').host).toBe('');
  });
});
