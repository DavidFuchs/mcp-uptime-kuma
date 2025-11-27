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
}
