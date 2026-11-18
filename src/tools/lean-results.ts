/**
 * Leaves null and empty values out of read results.
 *
 * Every tool result stays in the model's context for the rest of the conversation, and a
 * monitor or maintenance window from Uptime Kuma carries many fields that are null, "", [] or
 * {}: no description, no parent, no tags, no cron. Leaving them out takes 10 to 20% off a
 * typical result and loses nothing, as a field that is not there has no value either. The
 * server instructions say so. false and 0 are kept: they are values.
 *
 * A field the tool's output schema requires is always kept, empty or not. Clients check
 * structuredContent against the advertised schema themselves (Claude Desktop does, #83), so
 * a required field gone missing would make the tool unusable, and some required fields are
 * empty in real data: a heartbeat's msg is often "", and a ping average is null when there
 * were no checks.
 *
 * Applied to the read-only tools only. The tools that describe fields (getMonitorTypeFields,
 * getNotificationTypeFields) return JSON Schema, where `default: ""` is information.
 */

/** The parts of a JSON Schema that say where a value's properties and elements are described. */
export interface SchemaLike {
  type?: unknown;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  items?: SchemaLike | boolean;
  additionalProperties?: SchemaLike | boolean;
  anyOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  allOf?: SchemaLike[];
}

const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);

const asSchema = (s: unknown): SchemaLike | undefined =>
  s !== null && typeof s === 'object' ? (s as SchemaLike) : undefined;

/**
 * The branches a value may be described by: the schema itself and, for a union such as
 * anyOf [object, null] or an allOf, each of its parts.
 */
function branches(schema: SchemaLike | undefined): SchemaLike[] {
  if (!schema) return [];
  const parts = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  return [schema, ...parts.flatMap((part) => branches(asSchema(part)))];
}

/** Whether any branch of the schema requires `key`. */
const requires = (schema: SchemaLike | undefined, key: string) =>
  branches(schema).some((b) => b.required?.includes(key));

/**
 * Whether the schema describes a record: an object with no named properties whose keys are
 * data, such as listHeartbeats' monitor IDs. Its entries are kept even when empty, as a
 * monitor with no beats is still an answer. An object with named properties that also allows
 * others (a monitor with its type-specific fields) is not a record.
 */
const isRecord = (schema: SchemaLike | undefined) =>
  branches(schema).some((b) => !b.properties && asSchema(b.additionalProperties) !== undefined);

/** The schema for property `key`, from whichever branch describes it. */
function propertySchema(schema: SchemaLike | undefined, key: string): SchemaLike | undefined {
  for (const b of branches(schema)) {
    if (b.properties && key in b.properties) return asSchema(b.properties[key]);
  }
  for (const b of branches(schema)) {
    const extra = asSchema(b.additionalProperties);
    if (extra) return extra;
  }
  return undefined;
}

function itemSchema(schema: SchemaLike | undefined): SchemaLike | undefined {
  for (const b of branches(schema)) {
    const items = asSchema(b.items);
    if (items) return items;
  }
  return undefined;
}

/**
 * Returns a copy of `value` without object properties that are null or empty, at every depth,
 * including properties left empty once their own contents are trimmed. A property that
 * `schema` requires is kept, and so is every entry of a record. Array elements are trimmed
 * inside but never removed, as their position can matter. The root value is returned even
 * when it is itself empty.
 */
export function omitEmpty(value: unknown, schema?: SchemaLike): unknown {
  if (Array.isArray(value)) {
    const items = itemSchema(schema);
    return value.map((element) => omitEmpty(element, items));
  }
  if (value !== null && typeof value === 'object') {
    const record = isRecord(schema);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const trimmed = omitEmpty(val, propertySchema(schema, key));
      if (record || !isEmpty(trimmed) || requires(schema, key)) out[key] = trimmed;
    }
    return out;
  }
  return value;
}

interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * A text block's JSON, trimmed; prose is returned unchanged. The text is usually the
 * serialized structuredContent or one of its top-level values (getMonitor's text is the
 * monitor), so it is matched against those to find its schema.
 */
function leanText(text: string, structured: unknown, schema: SchemaLike | undefined): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  let textSchema: SchemaLike | undefined;
  if (structured !== null && typeof structured === 'object') {
    if (JSON.stringify(structured) === text) {
      textSchema = schema;
    } else {
      const key = Object.keys(structured).find(
        (k) => JSON.stringify((structured as Record<string, unknown>)[k]) === text
      );
      if (key !== undefined) textSchema = propertySchema(schema, key);
    }
  }
  // Text that matches neither is trimmed with no schema to keep fields by. It is the model's
  // copy only; structuredContent, which clients validate, always has its schema.
  return JSON.stringify(omitEmpty(parsed, textSchema));
}

/**
 * Trims a tool result: JSON text blocks, and every value below the top level of
 * structuredContent. The top-level keys are each tool's output contract (monitors, count,
 * monitor, ...), so they stay even when empty. `outputSchema` is the tool's advertised output
 * JSON Schema, whose required fields are kept. Error results are returned as they are.
 */
export function leanToolResult<T extends ToolResultLike>(result: T, outputSchema?: SchemaLike): T {
  if (!result || result.isError) return result;
  const out: ToolResultLike = { ...result };
  const structured = result.structuredContent;
  if (Array.isArray(result.content)) {
    out.content = result.content.map((block: unknown) => {
      const b = block as { type?: unknown; text?: unknown };
      return b && b.type === 'text' && typeof b.text === 'string'
        ? { ...b, text: leanText(b.text, structured, outputSchema) }
        : block;
    });
  }
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    out.structuredContent = Object.fromEntries(
      Object.entries(structured as Record<string, unknown>).map(([key, val]) => [
        key,
        omitEmpty(val, propertySchema(outputSchema, key)),
      ])
    );
  }
  return out as T;
}
