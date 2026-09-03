/**
 * Uptime Kuma sends `msg` as a string in most cases, but some monitor types (e.g. push
 * monitors with no message) or intermediate socket.io payloads can carry it as a number
 * or an array of strings instead. Coerce those into the plain string shape callers expect.
 */
export function normaliseMsg(value: unknown): unknown {
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.join(', ');
  return value;
}
