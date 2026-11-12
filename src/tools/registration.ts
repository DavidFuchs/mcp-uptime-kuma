/**
 * What applies to every tool alike: which ones exist in read-only mode, the behaviour hints
 * each advertises, strict input schemas, and the shape of the advertised JSON Schema.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MONITOR_TYPE_FIELD_NAMES, looseFieldName } from '../monitors/fields.js';

/**
 * The tools that remain when UPTIME_KUMA_READ_ONLY is set: the ones that only report.
 *
 * An allowlist, so a tool added later is left out of read-only mode until someone decides it
 * belongs — the safe way to be wrong. A test fails if a registered tool is in neither this set
 * nor WRITE_TOOLS, so that decision cannot be skipped.
 *
 * testDockerHost changes nothing but makes Uptime Kuma connect to an address of the caller's
 * choosing, and getMonitorTypeFields only serves the write tools, so neither is here.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'getMonitor', 'listMonitors', 'listMonitorTypes', 'getMonitorSummary', 'getHeartbeats', 'listHeartbeats',
  'getSettings', 'listNotifications', 'listDockerHosts', 'listTags', 'getMaintenanceWindows', 'listStatusPages',
  'getStatusPage',
]);

/** Every other tool. Left out of read-only mode. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'getMonitorTypeFields', 'createMonitor', 'updateMonitor', 'deleteMonitor', 'pauseMonitor', 'resumeMonitor',
  'addNotification', 'updateNotification', 'deleteNotification',
  'addDockerHost', 'updateDockerHost', 'deleteDockerHost', 'testDockerHost',
  'addTag', 'deleteTag',
  'createMaintenance', 'updateMaintenance', 'deleteMaintenance', 'pauseMaintenance', 'resumeMaintenance',
  'createStatusPage', 'updateStatusPage', 'deleteStatusPage',
]);

/** In WRITE_TOOLS, so absent from read-only mode, but a call changes nothing. */
export const CHANGE_NOTHING_TOOLS: ReadonlySet<string> = new Set(['getMonitorTypeFields', 'testDockerHost']);

/**
 * The behaviour hints advertised for a tool, which clients use to decide what may run without
 * asking and what deserves a confirmation.
 *
 * Derived from the tool's name so that a tool added later is covered without an entry here.
 * Nothing reaches beyond the one Uptime Kuma instance, hence openWorldHint: false throughout.
 */
export function toolAnnotations(name: string): {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
} {
  // Two tools change nothing yet stay out of read-only mode, for the reasons given on
  // READ_ONLY_TOOLS. The hint describes what a call does, so they carry it all the same.
  if (READ_ONLY_TOOLS.has(name) || CHANGE_NOTHING_TOOLS.has(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  // Deleting removes; updating replaces what was stored, a status page's groups included.
  const destructive = name.startsWith('delete') || name.startsWith('update');
  // Repeating an update, pause or resume with the same arguments leaves the same state.
  // A second create makes a second object, and a second delete fails.
  const idempotent = name.startsWith('update') || name.startsWith('pause') || name.startsWith('resume');
  return { readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false };
}

const DRAFT_07_DIALECT = 'http://json-schema.org/draft-07/schema#';
const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

// Keywords whose value is a map of schemas keyed by arbitrary names, not by JSON Schema
// keywords. Descending into one has to stop treating its keys as keywords.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']);

// Keywords whose value is instance data rather than a schema. Nothing inside them is a schema,
// so they are passed through untouched.
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);

const isEmptySchema = (value: unknown): value is Record<string, never> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;

/**
 * Normalizes the JSON Schema the SDK advertises from tools/list.
 *
 * Issue #83: the SDK converts every tool's input/output Zod schema to JSON Schema via
 * zod-to-json-schema without setting a `target`, so each one is stamped
 * "$schema": "http://json-schema.org/draft-07/schema#" — verified against both the SDK
 * version this project pins (^1.22.0) and the current latest (1.30.0); the behavior is
 * unchanged between them. Clients whose validator only accepts the MCP spec's default
 * dialect (2020-12, per SEP-1613) reject every tool outright before ever calling it
 * (see modelcontextprotocol/typescript-sdk#745, still open upstream).
 *
 * None of the schemas advertised here use anything that differs between the two drafts (no
 * `dependencies`, no positional tuple items), so relabeling the declared dialect is safe —
 * only the version stamp was wrong, not the shape.
 *
 * Issue #55: Home Assistant rejects the valid empty-schema form Zod emits for
 * z.record(..., z.unknown()), so `additionalProperties: {}` is rewritten to the equivalent
 * boolean form.
 *
 * Integer bounds: Zod stamps every `.int()` with `minimum: -9007199254740991` and
 * `maximum: 9007199254740991`, the safe-integer range. They constrain nothing a JSON number
 * could violate in practice and cost about 60 bytes per integer field in every session's
 * tool list, so they are dropped. A bound the schema actually declares is a different number
 * and is kept.
 */
export function normalizeAdvertisedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAdvertisedSchema);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'additionalProperties' && isEmptySchema(val)) {
        out[key] = true;
      } else if (key === '$schema' && val === DRAFT_07_DIALECT) {
        out[key] = DIALECT_2020_12;
      } else if (
        (key === 'minimum' && val === Number.MIN_SAFE_INTEGER) ||
        (key === 'maximum' && val === Number.MAX_SAFE_INTEGER)
      ) {
        // Dropped: see the note on integer bounds above.
      } else if (DATA_KEYWORDS.has(key)) {
        out[key] = val;
      } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
        out[key] = normalizeSchemaMap(val);
      } else {
        out[key] = normalizeAdvertisedSchema(val);
      }
    }
    return out;
  }
  return value;
}

/**
 * Normalizes a map whose keys are names rather than JSON Schema keywords — the members of
 * `properties`, `$defs`, and friends. Each value is a schema, but the keys are arbitrary, so a
 * tool declaring a field called `additionalProperties` must not have it mistaken for the
 * keyword one level up.
 */
function normalizeSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalizeAdvertisedSchema(value);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = normalizeAdvertisedSchema(val);
  }
  return out;
}

/**
 * Wraps the server's tool registration, before any tool is registered: leaves the write tools
 * out in read-only mode, adds each tool's annotations, makes its input schema strict, and
 * normalizes the JSON Schema that tools/list advertises.
 */
export function installToolRegistration(server: McpServer, readOnly: boolean): void {
  // Reject unknown keys instead of silently stripping them.
  //
  // registerTool is normally handed a raw Zod *shape*, which the SDK turns into a plain
  // z.object(shape). A plain object schema DROPS keys it doesn't know about rather than
  // erroring, and the write handlers then merge what survived over the monitor's existing
  // config — so a field this server doesn't declare is refilled with its old value and
  // Uptime Kuma answers {"ok":true,"msg":"Saved."}. A partial write reported as a complete
  // one. That is the shared mechanism behind #58, #60, #63 and #65; each was reported
  // separately because there is nothing in the response to connect them.
  //
  // getZodSchemaObject / normalizeObjectSchema both accept an already-built Zod object and
  // pass it through untouched, so upgrading every shape to .strict() here converts the whole
  // class from silent data loss into a loud error that names the offending key. It also puts
  // additionalProperties: false into the advertised JSON Schema, so callers are told up front
  // rather than discovering it from a write that didn't happen.
  //
  // Done by wrapping the method once rather than editing ~31 schemas by hand: one seam, no
  // chance of missing one, and it covers any tool added later.
  const registerToolUnstrict = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: Record<string, unknown>,
    cb: unknown
  ) => {
    // Read-only mode: a tool that is not registered cannot be called, listed, or cost context.
    if (readOnly && !READ_ONLY_TOOLS.has(name)) return undefined;
    config = { annotations: toolAnnotations(name), ...config };
    const shape = config?.inputSchema as Record<string, unknown> | undefined;
    // Only upgrade raw shapes; anything already a Zod schema is left alone.
    if (shape && typeof shape === 'object' && !('_def' in shape) && !('_zod' in shape)) {
      config = { ...config, inputSchema: strictInputSchema(name, shape as z.ZodRawShape) };
    }
    return (registerToolUnstrict as unknown as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as typeof server.registerTool;

  /**
   * Builds the strict schema, and makes an unknown key the FIRST thing the caller reads.
   *
   * Zod appends `unrecognized_keys` after the per-field issues, so `getMonitor {monitorId: 1}`
   * reports the absent monitorID first and the misspelled key second. The first line is the
   * misleading one: it points at a field the caller never got wrong. Reordering turns a
   * message that sends you hunting for a missing argument into one that says "you misspelled
   * this key" (#65).
   *
   * The message comes from the schema's own `error` option. The order has no public hook, so
   * it is applied where every parse path meets: the SDK runs a Zod 4 schema through Zod's
   * top-level safeParseAsync(), which calls `_zod.run` and never the schema's safeParse().
   */
  function strictInputSchema(toolName: string, shape: z.ZodRawShape) {
    const accepted = Object.keys(shape);
    // camelCase, snake_case and a wrong capital are the same guess at a name. Uptime Kuma mixes
    // all three (basic_auth_user, authMethod, monitorID), so say which one this field uses
    // rather than leaving the caller to find it in the list.
    const looseName = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');
    const byLooseName = new Map(accepted.map((key) => [looseName(key), key]));
    // Names this server used to accept as aliases, where dropping the separators does not
    // lead back to the accepted name: parentID / parent_id for `parent` on updateMonitor, and
    // limit / count for `maxHeartbeats` on the heartbeat tools. `limit` in particular is what
    // a caller reaches for first, and before unknown fields were refused it was dropped and
    // the call silently returned a single beat — so the refusal has to say what to pass.
    const FORMER_NAMES: Record<string, string> = { parentid: 'parent', limit: 'maxHeartbeats', count: 'maxHeartbeats' };
    const formerName = (key: string): string | undefined => {
      const target = FORMER_NAMES[looseName(key)];
      return target !== undefined && accepted.includes(target) ? target : undefined;
    };

    const schema = z.strictObject(shape, {
      error: (issue) => {
        if (issue.code !== 'unrecognized_keys') return undefined;
        const suggestions = issue.keys
          .map((k) => [k, byLooseName.get(looseName(k)) ?? formerName(k)])
          .filter(([, match]) => match !== undefined)
          .map(([k, match]) => `'${match}' for '${k}'`);
        // The fields that live in typeFields are the likeliest thing to be passed here instead.
        const typeFieldFor = (k: string) => MONITOR_TYPE_FIELD_NAMES.find((name) => looseFieldName(name) === looseFieldName(k));
        const nested = 'typeFields' in shape ? issue.keys.filter((k) => typeFieldFor(k) !== undefined) : [];
        return (
          `Unknown field(s) for ${toolName}: ${issue.keys.map((k) => `'${k}'`).join(', ')}. ` +
          (nested.length > 0
            ? `${nested.map((k) => `'${k}'`).join(', ')} ${nested.length > 1 ? 'are type-specific fields and go' : 'is a type-specific field and goes'} ` +
              `inside typeFields: {"typeFields": {${nested.map((k) => `"${typeFieldFor(k)}": …`).join(', ')}}}. `
            : '') +
          (suggestions.length > 0 ? `Did you mean ${suggestions.join(', ')}? ` : '') +
          'Field names are case-sensitive — check spelling and casing first (monitorID, not monitorId). ' +
          `Accepted fields: ${accepted.join(', ')}. ` +
          'Any other issue reported below may be a knock-on effect of this one: a required field ' +
          'that looks absent is usually the misspelled key.'
        );
      },
    });

    type Payload = { issues: Array<{ code?: string }> };
    const unknownKeysFirst = <P extends Payload>(payload: P): P => {
      payload.issues.sort(
        (a, b) => Number(b.code === 'unrecognized_keys') - Number(a.code === 'unrecognized_keys')
      );
      return payload;
    };
    const internals = schema._zod as unknown as {
      run: (payload: Payload, ctx: unknown) => Payload | Promise<Payload>;
    };
    const run = internals.run;
    internals.run = (payload, ctx) => {
      const result = run(payload, ctx);
      return result instanceof Promise ? result.then(unknownKeysFirst) : unknownKeysFirst(result);
    };

    return schema;
  }

  // Normalize the advertised JSON Schema on the way out (see normalizeAdvertisedSchema).
  // This intercepts the SDK's own `setRequestHandler(ListToolsRequestSchema, ...)` call (made
  // lazily on first `registerTool`, below) rather than reimplementing tools/list, so it keeps
  // working across SDK internals changing between versions.
  const setRequestHandlerUnpatched = server.server.setRequestHandler.bind(server.server) as (
    requestSchema: unknown,
    handler: (...args: unknown[]) => unknown
  ) => unknown;
  (server.server as unknown as { setRequestHandler: typeof server.server.setRequestHandler }).setRequestHandler = ((
    requestSchema: unknown,
    handler: (...args: unknown[]) => unknown
  ) => {
    if (requestSchema === ListToolsRequestSchema) {
      const wrapped = async (...args: unknown[]) => normalizeAdvertisedSchema(await handler(...args));
      return setRequestHandlerUnpatched(requestSchema, wrapped);
    }
    return setRequestHandlerUnpatched(requestSchema, handler);
  }) as typeof server.server.setRequestHandler;
}
