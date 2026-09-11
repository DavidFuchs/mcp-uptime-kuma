import { z } from 'zod';

/**
 * Configuration interface for Uptime Kuma
 */
export interface UptimeKumaConfig {
  url: string;
  username: string | undefined;
  password: string | undefined;
  token: string | undefined;
  jwtToken: string | undefined;
  /**
   * Return notification and monitor credentials in full instead of "***" (issue #59).
   * Optional and defaults to false, so an existing config object stays valid and the
   * safe behaviour is the one you get by not thinking about it.
   */
  includeSecrets?: boolean;
  /**
   * Extra HTTP headers sent on every request to Uptime Kuma, for reaching it through an
   * authenticating proxy such as Cloudflare Access (issue #95). Parsed from
   * UPTIME_KUMA_HEADERS; these are credentials and must never be logged.
   */
  extraHeaders?: Record<string, string>;
}
