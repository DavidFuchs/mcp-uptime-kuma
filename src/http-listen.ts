/**
 * Where the streamable HTTP transport listens: reading the settings, and describing the
 * result to a person (the startup log) and to a probe (the container healthcheck).
 */

/** The port used when `PORT` is unset. */
export const DEFAULT_PORT = 3000;

/** Addresses that mean "every interface". A server binds to them; nothing connects to them. */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::']);

/**
 * Reads the `PORT` setting. Anything that is not a whole number from 0 to 65535 is refused
 * rather than guessed at: parseInt() read "8080abc" as 8080, and "abc" as NaN, which reached
 * listen() and came back as a stack trace. 0 asks the operating system for any free port.
 */
export function parsePort(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return Number(raw);
}

/**
 * The URL a client on this machine would use to reach `path` on a server bound to `host`.
 * A wildcard bind is shown as localhost; an IPv6 address gets its brackets.
 */
export function listenUrl(host: string, port: number, path: string): string {
  const shown = WILDCARD_HOSTS.has(host) ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${port}${path}`;
}

/**
 * What the container healthcheck should probe, or null when there is nothing to probe.
 *
 * The image runs stdio by default, and a stdio server has no port: a healthcheck that always
 * probed one would mark every such container unhealthy. So the transport is read from the
 * command line of the container's main process, and only the HTTP transport is probed.
 *
 * Always over IPv4 loopback for a wildcard bind, since that is reachable whichever of the
 * two wildcards was used.
 */
export function healthcheckTarget(cmdline: string, env: Record<string, string | undefined>): string | null {
  if (!cmdline.split(/\s+/).includes('streamable-http')) {
    return null;
  }
  const host = env.HOST?.trim() ?? '';
  return listenUrl(WILDCARD_HOSTS.has(host) ? '127.0.0.1' : host, parsePort(env.PORT), '/health');
}
