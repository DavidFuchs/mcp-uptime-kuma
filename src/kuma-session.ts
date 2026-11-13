import { McpError, ErrorCode, type LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { UptimeKumaClient } from './uptime-kuma-client.js';
import type { UptimeKumaConfig } from './types/index.js';

/** Where a KumaSession sends its log lines: one connected MCP server. */
export interface KumaLogSink {
  shouldLog: (level: LoggingLevel) => boolean;
  send: (params: { level: LoggingLevel; data: unknown }) => Promise<void>;
}

/**
 * One authenticated connection to Uptime Kuma, and the caches that fill from it.
 *
 * Separate from the MCP server so that several servers can share it. The HTTP transport needs
 * that: an McpServer can be connected to only one transport at a time, so serving overlapping
 * requests takes a server each, and they must not each open their own socket and log in.
 */
export interface KumaSession {
  client: UptimeKumaClient;
  /** Logs in if not already logged in. Safe to call from every tool handler. */
  authenticateClient: () => Promise<void>;
  /** Starts sending log lines to a server. Returns the function that stops it. */
  attachLogSink: (sink: KumaLogSink) => () => void;
}

export function createKumaSession(config: UptimeKumaConfig): KumaSession {
  const sinks = new Set<KumaLogSink>();
  // A sink that is not connected yet, or has just gone away, must not break the caller.
  const log = async (level: LoggingLevel, data: unknown): Promise<void> => {
    await Promise.all(
      [...sinks].filter((sink) => sink.shouldLog(level)).map((sink) => sink.send({ level, data }).catch(() => {}))
    );
  };

  const client = new UptimeKumaClient(
    config.url,
    { sendLoggingMessage: ({ level, data }) => log(level, data) },
    undefined,
    config.extraHeaders
  );

  let isAuthenticated = false;
  let authInFlight: Promise<void> | null = null;

  // The client reports when the authenticated session is known to be gone (socket dropped,
  // or a re-auth on reconnect was refused). Clearing the flag here is what lets the next
  // tool call transparently re-authenticate, instead of the process staying wedged.
  client.onAuthLost = (reason: string) => {
    if (!isAuthenticated) return;
    isAuthenticated = false;
    process.stderr.write(`Uptime Kuma session invalidated: ${reason}. Will re-authenticate on next call.\n`);
  };

  // UPTIME_KUMA_JWT_TOKEN must be a real JWT — Uptime Kuma verifies it with jwt.verify()
  // against its jwtSecret. Anything else (a password, an API key, a truncated paste) is
  // rejected with the opaque message "authInvalidToken", which reads exactly like an
  // expired credential and sends you looking for a token-lifetime problem that isn't there.
  // Only the credential's SHAPE is ever reported — never its value.
  const describeCredential = (): string | null => {
    const t = config.jwtToken;
    if (!t) return null;
    const segments = String(t).split('.').length;
    if (segments === 3) return null;
    return (
      `UPTIME_KUMA_JWT_TOKEN is not a JWT: it has ${segments} dot-separated segment(s), expected 3 ` +
      `(length ${String(t).length}). Uptime Kuma will always reject this with "authInvalidToken". ` +
      `Generate a real token with: mcp-uptime-kuma-get-jwt ${config.url} <username> <password>. ` +
      'Note this variable may also be set in your shell environment as well as your MCP client ' +
      'config — check both and make sure they agree.'
    );
  };

  // Function to authenticate the client (to be called after transport is connected).
  //
  // Memoised on two axes. Returning early when already authenticated makes it safe to call
  // from every tool handler; sharing one in-flight promise stops concurrent calls opening a
  // second socket.io connection during the handshake.
  const authenticateClient = async (): Promise<void> => {
    if (isAuthenticated) return;
    if (authInFlight) return authInFlight;

    authInFlight = (async () => {
      try {
        // Reuse a live socket. connect() unconditionally assigns a new one, so every retry
        // orphaned the previous socket — still holding listeners, still reconnecting.
        await client.ensureConnected();
        await client.login(config.username, config.password, config.token, config.jwtToken);

        // Logging in anonymously gives no indication that authentication failed.
        // So instead, we issue a getSettings call after login, to prove the connection is working.
        await client.getSettings();
        isAuthenticated = true;

        await log('info', 'Successfully authenticated with Uptime Kuma');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const credentialProblem = describeCredential();
        const detail = credentialProblem ? `${errorMessage}. ${credentialProblem}` : errorMessage;
        await log('error', `Failed to authenticate with Uptime Kuma: ${detail}`);
        throw new McpError(ErrorCode.InternalError, `Failed to authenticate with Uptime Kuma: ${detail}`);
      }
    })();

    try {
      return await authInFlight;
    } finally {
      // Always clear the in-flight promise once it settles. Clearing only on failure meant
      // that after the first success it stayed set forever, so once a session could be
      // invalidated, authenticateClient() would return that stale resolved promise and skip
      // re-authenticating entirely.
      authInFlight = null;
    }
  };

  // No signal handlers here. Shutting down is the entry point's job: a handler registered by
  // the session ran ahead of the entry point's own and exited the process before the HTTP
  // transport could close its listener and let requests in flight finish.

  return {
    client,
    authenticateClient,
    attachLogSink: (sink) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
  };
}
