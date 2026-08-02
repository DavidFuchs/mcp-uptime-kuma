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
}
