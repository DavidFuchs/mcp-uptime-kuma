import { z } from 'zod';

/**
 * The `fields` argument of the read tools whose records are wide: the caller names the fields it
 * needs and gets only those, plus `id`. Every result stays in the model's context for the rest of
 * the session, so a listMonitors call that only needs names and URLs should not carry the rest.
 *
 * A comma-separated string, like the other filters (type, tags, status), and matched
 * case-insensitively: Uptime Kuma mixes retryInterval with accepted_statuscodes, and a caller
 * that guesses the casing wrong should still get the field. A name no record has is not an
 * error, because type-specific fields exist on some monitors and not others.
 */
export function fieldsParam(description: string) {
  return z.string().optional().describe(description);
}

/** The requested field names, lowercased with `id` added; undefined when every field is wanted. */
export function parseFields(fields: string | undefined): ReadonlySet<string> | undefined {
  if (fields === undefined) return undefined;
  const names = fields
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 0);
  if (names.length === 0) return undefined;
  return new Set(['id', ...names]);
}

/** Whether the selection asks for this field. No selection asks for every field. */
export function wantsField(selection: ReadonlySet<string> | undefined, name: string): boolean {
  return selection === undefined || selection.has(name.toLowerCase());
}

/** A copy of the record with only the selected fields; the record itself when there is no selection. */
export function pickFields<T extends object>(record: T, selection: ReadonlySet<string> | undefined): Partial<T> {
  if (selection === undefined) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => selection.has(key.toLowerCase()))) as Partial<T>;
}
