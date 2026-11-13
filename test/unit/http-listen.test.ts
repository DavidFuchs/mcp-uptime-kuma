import { describe, it, expect } from 'vitest';
import { parsePort, listenUrl, healthcheckTarget, DEFAULT_PORT } from '../../src/http-listen.js';

describe('parsePort', () => {
  it.each([undefined, '', '   '])('falls back to the default for %j', (value) => {
    expect(parsePort(value)).toBe(DEFAULT_PORT);
  });

  it.each([
    ['3000', 3000],
    [' 8080 ', 8080],
    ['0', 0],
    ['65535', 65535],
  ])('reads %j', (value, expected) => {
    expect(parsePort(value)).toBe(expected);
  });

  // parseInt() read "8080abc" as 8080 and "abc" as NaN, which reached listen() and came back
  // as a stack trace.
  it.each(['abc', '8080abc', '80.5', '-1', '65536', '1e3', '0x50'])('refuses %j and names the setting', (value) => {
    expect(() => parsePort(value)).toThrow(/PORT must be a whole number from 0 to 65535/);
    expect(() => parsePort(value)).toThrow(JSON.stringify(value));
  });
});

describe('listenUrl', () => {
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:3000/mcp'],
    ['192.168.1.20', 'http://192.168.1.20:3000/mcp'],
    ['mcp.internal', 'http://mcp.internal:3000/mcp'],
    ['::1', 'http://[::1]:3000/mcp'],
  ])('names the address the server is bound to: %s', (host, expected) => {
    expect(listenUrl(host, 3000, '/mcp')).toBe(expected);
  });

  // Nothing can connect TO the wildcard address; on this machine it is reached as localhost.
  it.each(['0.0.0.0', '::'])('shows localhost for the wildcard %s', (host) => {
    expect(listenUrl(host, 8080, '/health')).toBe('http://localhost:8080/health');
  });
});

describe('healthcheckTarget', () => {
  it.each([
    'node dist/index.js -t stdio',
    'node dist/index.js',
    'node dist/get-jwt.js http://kuma:3001 admin secret',
    '',
  ])('has nothing to probe when the transport is not HTTP: %j', (cmdline) => {
    expect(healthcheckTarget(cmdline, {})).toBeNull();
  });

  it.each([
    'node dist/index.js -t streamable-http',
    'node dist/index.js --transport streamable-http',
    '/sbin/docker-init -- ./docker-entrypoint.sh -t streamable-http',
  ])('probes /health for %j', (cmdline) => {
    expect(healthcheckTarget(cmdline, {})).toBe('http://127.0.0.1:3000/health');
  });

  it('follows PORT and a specific HOST', () => {
    const cmdline = 'node dist/index.js -t streamable-http';
    expect(healthcheckTarget(cmdline, { PORT: '8080' })).toBe('http://127.0.0.1:8080/health');
    expect(healthcheckTarget(cmdline, { PORT: '8080', HOST: '0.0.0.0' })).toBe('http://127.0.0.1:8080/health');
    expect(healthcheckTarget(cmdline, { HOST: '10.0.0.5' })).toBe('http://10.0.0.5:3000/health');
    expect(healthcheckTarget(cmdline, { HOST: '::' })).toBe('http://127.0.0.1:3000/health');
  });
});
