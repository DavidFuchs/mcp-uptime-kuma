/**
 * How a notification row is shown to MCP clients.
 *
 * Uptime Kuma's notification table has no type column: the provider type and every
 * provider-specific setting live in `config`, a JSON string. Returned as-is, an agent has to
 * know to parse a string inside the response to learn what kind of channel it is. This lifts
 * `type` to the top level and returns `config` as an object, the same shape addNotification and
 * updateNotification take.
 *
 * Builds a new object: rows from getNotificationList() are references into the client's cache.
 * Run it after redaction; a config redaction withheld in full ("***") is left alone.
 */
export function presentNotification(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  let config: unknown = row.config;
  if (typeof config === 'string') {
    try {
      const parsed: unknown = JSON.parse(config);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch {
      // Not JSON (for example the "***" of a fully withheld config): keep it as it is.
    }
  }
  out.config = config;
  if (
    out.type === undefined &&
    config &&
    typeof config === 'object' &&
    typeof (config as Record<string, unknown>).type === 'string'
  ) {
    out.type = (config as Record<string, unknown>).type;
  }
  return out;
}
