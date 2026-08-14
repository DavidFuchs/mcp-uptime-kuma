import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/server.js';

/**
 * Issue #83: the SDK stamps every tool's input/output schema with
 * "$schema": "http://json-schema.org/draft-07/schema#" (zod-to-json-schema's default target),
 * which clients validating strictly against the MCP spec's default dialect (2020-12, per
 * SEP-1613) reject outright. server.ts relabels the dialect on the way out; this asserts none
 * of the advertised schemas still declare draft-07.
 */
describe('tools/list schema dialect', () => {
  it('advertises the 2020-12 dialect on every tool schema, never draft-07', async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });

    const handler = (server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: unknown[] }>>;
    })._requestHandlers.get('tools/list');
    expect(handler).toBeDefined();

    const { tools } = await handler!({ method: 'tools/list', params: {} }, {});
    expect(tools.length).toBeGreaterThan(0);

    const draft07 = 'http://json-schema.org/draft-07/schema#';
    const found = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          if (key === '$schema' && typeof val === 'string') found.add(val);
          walk(val);
        }
      }
    };
    walk(tools);

    expect(found.has(draft07)).toBe(false);
    expect(found.has('https://json-schema.org/draft/2020-12/schema')).toBe(true);
  });
});
