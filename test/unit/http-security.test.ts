import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  parseAllowedOrigins,
  createOriginMiddleware,
  createAuthMiddleware,
} from '../../src/http-security.js';

/**
 * The middleware under test only ever reads two headers and, on rejection, writes a
 * status/header/body. Stubbing that surface keeps these tests on the guard logic itself
 * rather than on Express's routing, and means no socket is ever opened.
 */
interface StubResult {
  req: Request;
  res: Response;
  nextCalls: number;
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
  next: () => void;
}

function stub(headers: Record<string, string> = {}): StubResult {
  const result: Partial<StubResult> & { nextCalls: number; headers: Record<string, string> } = {
    nextCalls: 0,
    headers: {},
  };

  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    set(name: string, value: string) {
      result.headers[name] = value;
      return res;
    },
    json(payload: unknown) {
      result.body = payload;
      return res;
    },
  } as unknown as Response;

  result.req = { headers } as unknown as Request;
  result.res = res;
  result.next = () => {
    result.nextCalls += 1;
  };

  return result as StubResult;
}

describe('parseAllowedOrigins', () => {
  it('defaults to the wildcard when unset, preserving existing deployments', () => {
    expect(parseAllowedOrigins(undefined)).toBe('*');
  });

  it('treats a blank value as unset rather than as an empty allowlist', () => {
    expect(parseAllowedOrigins('')).toBe('*');
    expect(parseAllowedOrigins('   ')).toBe('*');
  });

  it('recognises the explicit wildcard', () => {
    expect(parseAllowedOrigins('*')).toBe('*');
  });

  it('splits a comma-separated list', () => {
    expect(parseAllowedOrigins('https://a.example.com,https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('tolerates whitespace and empty entries around the separators', () => {
    expect(parseAllowedOrigins(' https://a.example.com , , https://b.example.com ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('normalises case and a trailing slash so equality comparison is safe', () => {
    expect(parseAllowedOrigins('HTTPS://Example.COM/')).toEqual(['https://example.com']);
  });
});

describe('createOriginMiddleware', () => {
  it('allows a request with no Origin header, which is every native MCP client', () => {
    const s = stub({});
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
    expect(s.status).toBeUndefined();
  });

  it('allows any Origin when configured with the wildcard', () => {
    const s = stub({ origin: 'https://anything.example.com' });
    createOriginMiddleware('*')(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
  });

  it('allows an Origin on the allowlist', () => {
    const s = stub({ origin: 'https://example.com' });
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
  });

  it('matches scheme and host case-insensitively', () => {
    const s = stub({ origin: 'HTTPS://Example.com' });
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
  });

  it('rejects an Origin that is not on the allowlist with 403', () => {
    const s = stub({ origin: 'https://evil.example.com' });
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(s.status).toBe(403);
    expect(s.nextCalls).toBe(0);
  });

  it('rejects a suffix near-miss rather than substring-matching the allowlist', () => {
    const s = stub({ origin: 'https://evil-example.com' });
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(s.status).toBe(403);
    expect(s.nextCalls).toBe(0);
  });

  it('treats the port as significant', () => {
    const s = stub({ origin: 'http://localhost:4000' });
    createOriginMiddleware(['http://localhost:3000'])(s.req, s.res, s.next);
    expect(s.status).toBe(403);
    expect(s.nextCalls).toBe(0);
  });

  it('rejects the opaque "null" Origin a sandboxed frame sends', () => {
    const s = stub({ origin: 'null' });
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(s.status).toBe(403);
    expect(s.nextCalls).toBe(0);
  });

  it('does not echo the rejected Origin back to the caller', () => {
    const s = stub({ origin: 'https://evil.example.com' });
    createOriginMiddleware(['https://example.com'])(s.req, s.res, s.next);
    expect(JSON.stringify(s.body)).not.toContain('evil.example.com');
  });
});

describe('createAuthMiddleware', () => {
  const TOKEN = 'correct-horse-battery-staple';

  it('passes every request through when no token is configured', () => {
    const s = stub({});
    createAuthMiddleware(undefined)(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
    expect(s.status).toBeUndefined();
  });

  it('treats a blank configured token as unset rather than as a token of ""', () => {
    const s = stub({});
    createAuthMiddleware('   ')(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
  });

  it('rejects a request with no Authorization header', () => {
    const s = stub({});
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.status).toBe(401);
    expect(s.nextCalls).toBe(0);
  });

  it('rejects a non-Bearer authorization scheme', () => {
    const s = stub({ authorization: `Basic ${TOKEN}` });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.status).toBe(401);
    expect(s.nextCalls).toBe(0);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    const s = stub({ authorization: `Bearer ${wrong}` });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.status).toBe(401);
    expect(s.nextCalls).toBe(0);
  });

  it('rejects a wrong token of a different length without throwing', () => {
    const s = stub({ authorization: 'Bearer short' });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.status).toBe(401);
    expect(s.nextCalls).toBe(0);
  });

  it('rejects a token that is merely a prefix of the configured one', () => {
    const s = stub({ authorization: `Bearer ${TOKEN.slice(0, -1)}` });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.status).toBe(401);
    expect(s.nextCalls).toBe(0);
  });

  it('accepts the configured token', () => {
    const s = stub({ authorization: `Bearer ${TOKEN}` });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
    expect(s.status).toBeUndefined();
  });

  it('accepts the scheme in any case, as RFC 9110 requires', () => {
    const s = stub({ authorization: `bearer ${TOKEN}` });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
  });

  it('ignores surrounding whitespace on the configured token', () => {
    const s = stub({ authorization: `Bearer ${TOKEN}` });
    createAuthMiddleware(`  ${TOKEN}  `)(s.req, s.res, s.next);
    expect(s.nextCalls).toBe(1);
  });

  it('advertises Bearer via WWW-Authenticate when rejecting', () => {
    const s = stub({});
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(s.headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('answers a missing and an incorrect token identically, leaking no oracle', () => {
    const missing = stub({});
    createAuthMiddleware(TOKEN)(missing.req, missing.res, missing.next);

    const incorrect = stub({ authorization: 'Bearer nope' });
    createAuthMiddleware(TOKEN)(incorrect.req, incorrect.res, incorrect.next);

    expect(incorrect.status).toBe(missing.status);
    expect(incorrect.body).toEqual(missing.body);
    expect(incorrect.headers).toEqual(missing.headers);
  });

  it('never puts the configured token in the rejection response', () => {
    const s = stub({ authorization: 'Bearer wrong' });
    createAuthMiddleware(TOKEN)(s.req, s.res, s.next);
    expect(JSON.stringify({ body: s.body, headers: s.headers })).not.toContain(TOKEN);
  });
});
