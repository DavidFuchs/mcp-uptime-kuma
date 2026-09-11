/**
 * Extra HTTP headers sent on every request to Uptime Kuma (issue #95).
 *
 * Needed when Uptime Kuma sits behind an authenticating proxy — Cloudflare Access service
 * tokens (CF-Access-Client-Id / CF-Access-Client-Secret), oauth2-proxy, an API gateway —
 * that rejects the Socket.IO handshake before it ever reaches Kuma.
 *
 * The format is a JSON object rather than a delimited list so that values containing
 * commas, equals signs or colons (cookies, URLs, base64) need no escaping.
 *
 * These headers are credentials. Errors name the offending header but never echo a value
 * or the raw input, because startup errors land in MCP client logs and container output.
 */

// RFC 9110 token: the characters a header field name may contain.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// CR/LF would split the request into extra header lines; NUL is rejected by every HTTP stack.
// Caught here so the failure is a clear startup error rather than an opaque one from ws.
const FORBIDDEN_VALUE_CHARS = /[\r\n\0]/;

export function parseExtraHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse's own message quotes a slice of the input, which may be the secret.
    throw new Error(
      'UPTIME_KUMA_HEADERS is not valid JSON. Expected an object such as '
      + '{"CF-Access-Client-Id":"<id>","CF-Access-Client-Secret":"<secret>"}.'
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UPTIME_KUMA_HEADERS must be a JSON object mapping header names to string values.');
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`UPTIME_KUMA_HEADERS contains an invalid header name: ${JSON.stringify(name)}.`);
    }
    if (typeof value !== 'string') {
      throw new Error(`UPTIME_KUMA_HEADERS: the value of "${name}" must be a string.`);
    }
    if (FORBIDDEN_VALUE_CHARS.test(value)) {
      throw new Error(`UPTIME_KUMA_HEADERS: the value of "${name}" contains a line break or NUL character.`);
    }
    headers[name] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
