import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Admin panel`;

export default defineScenario({
  id: 'http-basic-auth',
  description: 'HTTP monitor behind basic auth',
  tags: ['monitors', 'http-auth'],
  prompt: `Monitor https://example.com/admin as "${NAME}". It's behind HTTP basic auth: user "ops", password "s3cret-Pass".`,
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is http', m.type === 'http', `type=${m.type}`),
      expectThat('url is https://example.com/admin', m.url === 'https://example.com/admin', `url=${m.url}`),
      expectThat('authMethod is basic', m.authMethod === 'basic', `authMethod=${m.authMethod}`),
      expectThat('user is ops', m.basic_auth_user === 'ops', `basic_auth_user=${m.basic_auth_user}`),
      expectThat('password stored', m.basic_auth_pass === 's3cret-Pass', `basic_auth_pass=${m.basic_auth_pass}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
