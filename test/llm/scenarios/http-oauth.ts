import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Partner API`;

export default defineScenario({
  id: 'http-oauth',
  description: 'HTTP monitor using OAuth2 client credentials',
  tags: ['monitors', 'http-auth'],
  prompt:
    `Monitor https://api.example.com/v1/health as "${NAME}". It needs an OAuth2 client-credentials token from ` +
    'https://auth.example.com/oauth/token with client ID "kuma-probe", client secret "cs-0123456789", and scope "health:read".',
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('authMethod is oauth2-cc', m.authMethod === 'oauth2-cc', `authMethod=${m.authMethod}`),
      expectThat('token URL stored', m.oauth_token_url === 'https://auth.example.com/oauth/token', `oauth_token_url=${m.oauth_token_url}`),
      expectThat('client ID stored', m.oauth_client_id === 'kuma-probe', `oauth_client_id=${m.oauth_client_id}`),
      expectThat('client secret stored', m.oauth_client_secret === 'cs-0123456789', `oauth_client_secret=${m.oauth_client_secret}`),
      expectThat('scope stored', String(m.oauth_scopes ?? '').includes('health:read'), `oauth_scopes=${m.oauth_scopes}`),
      expectThat('oauth_auth_method set', typeof m.oauth_auth_method === 'string' && m.oauth_auth_method.length > 0, `oauth_auth_method=${m.oauth_auth_method}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
