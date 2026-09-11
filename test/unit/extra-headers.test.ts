import { describe, it, expect } from 'vitest';
import { parseExtraHeaders } from '../../src/extra-headers.js';

// A value that must never surface in an error message. These headers carry credentials
// (Cloudflare Access service-token secrets, gateway API keys), and startup errors land in
// MCP client logs and container output.
const SECRET = 'cf-secret-8f3a1c9e';

function errorOf(raw: string): Error {
  try {
    parseExtraHeaders(raw);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected parseExtraHeaders to throw for ${JSON.stringify(raw)}`);
}

describe('parseExtraHeaders', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['an empty object', '{}'],
  ])('returns undefined when %s', (_label, raw) => {
    expect(parseExtraHeaders(raw)).toBeUndefined();
  });

  it('returns the configured headers', () => {
    expect(
      parseExtraHeaders('{"CF-Access-Client-Id":"abc.access","CF-Access-Client-Secret":"s3cr3t"}')
    ).toEqual({
      'CF-Access-Client-Id': 'abc.access',
      'CF-Access-Client-Secret': 's3cr3t',
    });
  });

  it('keeps commas, equals signs and colons inside values intact', () => {
    expect(parseExtraHeaders('{"Cookie":"a=1, b=2","X-Url":"https://x:1/y"}')).toEqual({
      Cookie: 'a=1, b=2',
      'X-Url': 'https://x:1/y',
    });
  });

  it.each([
    ['not JSON', `CF-Access-Client-Secret=${SECRET}`],
    ['a JSON array', `["${SECRET}"]`],
    ['a JSON string', `"${SECRET}"`],
    ['JSON null', 'null'],
  ])('rejects %s without echoing the input', (_label, raw) => {
    const error = errorOf(raw);
    expect(error.message).toMatch(/UPTIME_KUMA_HEADERS/);
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ['a number', `{"X-Key": 42}`],
    ['a nested object', `{"X-Key": {"v":"${SECRET}"}}`],
    ['null', `{"X-Key": null}`],
  ])('rejects a header whose value is %s, naming the header but not the value', (_label, raw) => {
    const error = errorOf(raw);
    expect(error.message).toContain('X-Key');
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ['CR', `{"X-Key":"${SECRET}\\rInjected: 1"}`],
    ['LF', `{"X-Key":"${SECRET}\\nInjected: 1"}`],
    ['NUL', `{"X-Key":"${SECRET}\\u0000"}`],
  ])('rejects a value containing %s, naming the header but not the value', (_label, raw) => {
    const error = errorOf(raw);
    expect(error.message).toContain('X-Key');
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ['a space', 'X Key'],
    ['a colon', 'X-Key:'],
    ['a newline', 'X-Key\\n'],
    ['nothing', ''],
  ])('rejects a header name containing %s', (_label, name) => {
    const error = errorOf(`{"${name}":"${SECRET}"}`);
    expect(error.message).toMatch(/header name/i);
    expect(error.message).not.toContain(SECRET);
  });
});
