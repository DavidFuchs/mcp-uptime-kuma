import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}No errors on homepage`;

export default defineScenario({
  id: 'create-keyword-monitor',
  description: 'Create an inverted keyword monitor from a plain-language "alert if it contains" request',
  tags: ['monitors'],
  prompt: `Monitor https://example.com and alert if the page ever contains the word "Error". Name it "${NAME}".`,
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is keyword', m.type === 'keyword', `type=${m.type}`),
      expectThat('url is https://example.com', String(m.url ?? '').replace(/\/$/, '') === 'https://example.com', `url=${m.url}`),
      expectThat('keyword is Error', m.keyword === 'Error', `keyword=${m.keyword}`),
      expectThat('keyword is inverted', m.invertKeyword === true, `invertKeyword=${m.invertKeyword}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
