import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/server.js';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * Issue #83: the SDK stamps every tool's input/output schema with
 * "$schema": "http://json-schema.org/draft-07/schema#" (zod-to-json-schema's default target),
 * which clients validating strictly against the MCP spec's default dialect (2020-12, per
 * SEP-1613) reject outright. src/tools/registration.ts drops the stamp on the way out, so the
 * spec's default applies; this asserts no advertised schema declares a dialect.
 */
describe('tools/list schema dialect', () => {
  type Tool = { name: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> };

  /**
   * A client built before the MCP spec named a default dialect may read an unstamped schema
   * with its validator's own default, often draft-07. Every advertised schema has to compile,
   * with unknown keywords refused, under both drafts, so it means the same either way.
   */
  it('compiles every advertised schema under draft-07 and 2020-12 alike', async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });
    type ToolsListHandler = (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>;
    const handler = (
      server.server as unknown as { _requestHandlers: Map<string, ToolsListHandler> }
    )._requestHandlers.get('tools/list');
    const { tools } = await handler!({ method: 'tools/list', params: {} }, {});

    const options = { strictSchema: true, strictTypes: false, strictTuples: false, logger: false } as const;
    const validators = { 'draft-07': new Ajv(options), '2020-12': new Ajv2020(options) };
    const failures: string[] = [];
    for (const tool of tools) {
      for (const [part, schema] of [
        ['inputSchema', tool.inputSchema],
        ['outputSchema', tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        for (const [draft, ajv] of Object.entries(validators)) {
          try {
            ajv.compile(schema);
          } catch (error) {
            failures.push(`${tool.name}.${part} (${draft}): ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('declares no dialect on any tool schema, so the MCP default of 2020-12 applies', async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });

    const handler = (
      server.server as unknown as {
        _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: unknown[] }>>;
      }
    )._requestHandlers.get('tools/list');
    expect(handler).toBeDefined();

    const { tools } = await handler!({ method: 'tools/list', params: {} }, {});
    expect(tools.length).toBeGreaterThan(0);

    const found: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          if (key === '$schema') found.push(`${path}: ${String(val)}`);
          walk(val, `${path}.${key}`);
        }
      }
    };
    for (const tool of tools as Tool[]) {
      walk(tool.inputSchema, `${tool.name}.inputSchema`);
      walk(tool.outputSchema, `${tool.name}.outputSchema`);
    }

    expect(found).toEqual([]);
  });

  it('uses a boolean for unconstrained record values', async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });

    type ToolsListHandler = (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>;
    const handler = (
      server.server as unknown as {
        _requestHandlers: Map<string, ToolsListHandler>;
      }
    )._requestHandlers.get('tools/list');
    expect(handler).toBeDefined();

    const { tools } = await handler!({ method: 'tools/list', params: {} }, {});
    const createNotification = tools.find((tool) => tool.name === 'createNotification');
    const config = (createNotification?.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined)
      ?.config;

    expect(config?.additionalProperties).toBe(true);
  });

  /**
   * Guard for the class issue #55 belongs to. Home Assistant converts a tool's inputSchema with
   * voluptuous-openapi, which raises "Invalid schema, missing type" for an empty schema in any
   * position it recurses into, and "Invalid schema, expected a dictionary" for a boolean in any
   * position except `additionalProperties`, which it special-cases. `additionalProperties: {}`
   * is normalized on the way out; nothing else can be, so an empty schema reaching one of these
   * positions is a tool declaration that needs fixing at the source (give the field a concrete
   * type instead of z.unknown()/z.any()). Scoped to inputSchema: Home Assistant never converts
   * outputSchema, which legitimately carries `not: {}` nullable markers.
   */
  it('advertises no empty schema in a position Home Assistant converts', async () => {
    const { server } = await createServer({
      url: 'http://localhost:3001',
      username: undefined,
      password: undefined,
      token: undefined,
      jwtToken: undefined,
    });

    const handler = (
      server.server as unknown as {
        _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>>;
      }
    )._requestHandlers.get('tools/list');
    expect(handler).toBeDefined();

    const { tools } = await handler!({ method: 'tools/list', params: {} }, {});
    expect(tools.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (typeof node === 'boolean' || node === null || typeof node !== 'object' || Array.isArray(node)) return;
      const schema = node as Record<string, unknown>;
      if (Object.keys(schema).length === 0) {
        offenders.push(path);
        return;
      }
      // Keywords holding a single subschema (or, for draft-07 tuples, an array of them).
      for (const key of ['additionalProperties', 'items', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']) {
        if (!(key in schema)) continue;
        const val = schema[key];
        if (Array.isArray(val)) val.forEach((sub, i) => visit(sub, `${path}.${key}[${i}]`));
        else visit(val, `${path}.${key}`);
      }
      // Keywords holding an array of subschemas.
      for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
        const val = schema[key];
        if (Array.isArray(val)) val.forEach((sub, i) => visit(sub, `${path}.${key}[${i}]`));
      }
      // Keywords holding a map of subschemas keyed by name.
      for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
        const val = schema[key];
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        for (const [name, sub] of Object.entries(val as Record<string, unknown>)) {
          visit(sub, `${path}.${key}.${name}`);
        }
      }
    };

    for (const tool of tools) {
      if (tool.inputSchema) visit(tool.inputSchema, tool.name);
    }

    expect(offenders).toEqual([]);
  });
});
