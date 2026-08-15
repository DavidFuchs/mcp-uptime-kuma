import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Gating of requests on the way IN to the streamable HTTP transport (issue #62).
 *
 * Nothing here applies to stdio. The MCP spec is explicit that a stdio server takes its
 * credentials from the environment and should not implement transport authorization —
 * there is no network listener to protect. Everything below exists only because
 * `-t streamable-http` opens a port.
 *
 * The spec's Streamable HTTP security warning names three protections, and the two we
 * can implement here pull in opposite directions, which is why both exist:
 *
 * 1. VALIDATING `Origin` IS THE MUST, AND CORS IS NOT IT. The `cors` middleware only
 *    sets response headers telling a browser whether the calling page may READ the
 *    reply; the request has already run by then. That distinction is academic for a
 *    read-only server and decisive for this one, whose tool surface includes
 *    `deleteMonitor` and `deleteNotification`. It matters most in the attack the spec
 *    actually names: under DNS rebinding the browser believes the request is
 *    same-origin, so no preflight and no `Access-Control-*` check happens at all. The
 *    only thing left that can notice is the server comparing the `Origin` header it was
 *    sent against the origins it expects.
 *
 * 2. AUTHENTICATION IS THE SHOULD, AND IT DEFENDS A DIFFERENT ATTACKER. An Origin check
 *    is worth nothing against a caller that is not a browser and simply omits the
 *    header — which is every native MCP client, and therefore also every attacker who
 *    can reach the port directly.
 *
 * Both default to permissive so that upgrading does not silently break a working
 * deployment; `index.ts` warns loudly at startup in that state.
 */

/**
 * `*` means "no Origin restriction". An allowlist is held normalised (see
 * `normaliseOrigin`) so that comparison at request time is a plain equality check —
 * substring or suffix matching is how `https://evil-example.com` ends up passing a check
 * meant for `https://example.com`.
 */
export type AllowedOrigins = '*' | string[];

/**
 * An origin is `scheme://host[:port]` with no path, so lowercasing the whole string is
 * equivalent to the case-insensitive scheme/host comparison RFC 6454 calls for, and
 * cannot smudge a path the way it would on a full URL. The port is left significant:
 * `http://localhost:3000` and `http://localhost:4000` are different origins.
 */
const normaliseOrigin = (origin: string): string => origin.trim().toLowerCase().replace(/\/$/, '');

/**
 * Reads the `ALLOWED_ORIGIN` setting. Unset, blank, or `*` all mean the wildcard: this
 * is the pre-existing default and changing it would break browser-based clients of
 * deployments that never opted in.
 */
export function parseAllowedOrigins(value: string | undefined): AllowedOrigins {
  const raw = value?.trim();
  if (!raw || raw === '*') {
    return '*';
  }

  return raw
    .split(',')
    .map(normaliseOrigin)
    .filter((origin) => origin.length > 0);
}

/**
 * Rejects a cross-origin caller before it reaches the MCP handler.
 *
 * A request with NO `Origin` header is allowed through. That is not a loophole being
 * left open, it is the common case: native clients (Claude Code, Claude Desktop, Cursor,
 * VS Code) are not browsers and never send one. This check exists to constrain browsers,
 * which always send it, and which are the only agent DNS rebinding can weaponise.
 */
export function createOriginMiddleware(allowed: AllowedOrigins): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (typeof origin !== 'string' || allowed === '*') {
      next();
      return;
    }

    if (allowed.includes(normaliseOrigin(origin))) {
      next();
      return;
    }

    // The rejected origin is deliberately absent from the response: echoing attacker
    // -controlled input back into a body is how a diagnostic becomes a reflection bug.
    res.status(403).json({ error: 'origin_not_allowed' });
  };
}

/**
 * Requires a shared secret in `Authorization: Bearer <token>` once `MCP_AUTH_TOKEN` is
 * set. An unset (or blank) token disables the check entirely, which is what an existing
 * deployment gets on upgrade.
 */
export function createAuthMiddleware(token: string | undefined): RequestHandler {
  const expected = token?.trim();

  if (!expected) {
    return (_req, _res, next) => next();
  }

  // Compare SHA-256 digests rather than the tokens themselves. `timingSafeEqual` throws
  // on length-mismatched inputs, so a direct comparison needs a length guard in front of
  // it — and that guard is itself a side channel that hands an attacker the token's
  // length for free. Digests are always 32 bytes, so one constant-time comparison covers
  // every case and no branch depends on the presented value.
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();

  return (req, res, next) => {
    const header = req.headers.authorization;
    const presented = typeof header === 'string' && /^bearer /i.test(header)
      ? header.slice('bearer '.length)
      : '';

    const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();

    if (timingSafeEqual(expectedDigest, presentedDigest)) {
      next();
      return;
    }

    // A missing, malformed, and merely wrong credential all land here with byte-identical
    // responses. Distinguishing them would tell a caller probing the endpoint which half
    // of the guess to keep.
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
  };
}
