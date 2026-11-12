import { z } from 'zod';

/**
 * Converts a string that really is a number, and passes everything else through untouched.
 *
 * This replaces `z.coerce.number()`, which is the root cause of #65. Coercion runs `Number()`
 * over whatever arrives, unconditionally, and that costs twice:
 *
 *   - An ABSENT field becomes NaN, so the caller is told "expected number, received nan" —
 *     a type complaint about a field they never wrote, rather than "this field is missing".
 *     That is what made a misspelled `monitorId` so confusing to diagnose: the unknown key is
 *     rejected, the declared key is then absent, and the absence was reported as a bad number.
 *   - `Number(null)`, `Number('')` and `Number([])` are all 0, and `Number(true)` is 1, so
 *     junk silently became a plausible value. `getMonitor {monitorID: null}` read monitor 0,
 *     and on the write tools it was worse: `timeout: ''` stored a 0, and a stored 0 makes
 *     Uptime Kuma compute a ~13 hour timeout (see the field's own description), so the monitor
 *     can never report DOWN against a host that accepts the connection and never answers.
 *     A silently disabled monitor is the worst failure an uptime tool has.
 *
 * Dropping coercion entirely would fix both but break clients that stringify their arguments,
 * which is why it was there. So the conversion is made CONDITIONAL: only strings that parse to
 * a finite number are converted, and anything else reaches the validator unchanged, to be
 * reported as what it actually was. `''` is excluded explicitly — `Number('')` is 0, and that
 * single conversion is responsible for most of the damage above.
 */
export function numericString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Wraps a number schema so it accepts numeric strings without accepting junk.
 *
 * Takes the inner schema rather than returning a chainable one, because the call sites need
 * their own constraints (`.int()`, `.positive()`, `.max(100)`) applied to the NUMBER, and those
 * cannot be chained onto the effect wrapper this returns. `.optional()` and `.nullable()` are
 * chained on the outside as usual, and still short-circuit before the conversion runs — so a
 * field declared `.nullable()` keeps accepting null.
 */
export function numeric<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(numericString, schema);
}

/**
 * A required Uptime Kuma record ID (monitorID, notificationID, dockerHostID, tagID).
 *
 * The `error` function is what turns an absent field back into "this field is required" rather
 * than the NaN complaint of #65. It answers only for an absent value, so a malformed one keeps
 * Zod's own description of what was wrong with it.
 */
export function requiredId(description: string) {
  return numeric(
    z.number({
      error: (issue) =>
        issue.input === undefined ? `${description} — this field is required and was not provided` : undefined,
    })
      .int()
      .nonnegative()
  ).describe(description);
}
