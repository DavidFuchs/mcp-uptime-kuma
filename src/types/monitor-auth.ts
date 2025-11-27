import { z } from 'zod';

/**
 * Zod schema for OAuth2 Client Credentials
 */
export const OAuth2Schema = z.object({
  oauth_client_id: z.string().optional().describe('OAuth2 client ID'),
  oauth_client_secret: z.string().optional().describe('OAuth2 client secret'),
  oauth_token_url: z.string().optional().describe('OAuth2 token URL'),
  oauth_scopes: z.string().optional().describe('OAuth2 scopes'),
  oauth_audience: z.string().optional().describe('OAuth2 audience'),
  oauth_auth_method: z.enum(['client_secret_basic', 'client_secret_post']).optional().describe('OAuth2 auth method'),
});

/**
 * Zod schema for Kafka Producer SASL Options
 */
export const KafkaProducerSaslOptionsSchema = z.object({
  mechanism: z.string().describe('SASL mechanism (None, plain, scram-sha-256, etc.)'),
  username: z.string().optional().describe('SASL username'),
  password: z.string().optional().describe('SASL password'),
});
