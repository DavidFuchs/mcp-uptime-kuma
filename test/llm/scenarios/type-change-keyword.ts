import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { createMonitor, getMonitor } from '../kuma.js';

export default defineScenario({
  id: 'type-change-keyword',
  description: 'Turn an HTTP monitor into a keyword monitor in place',
  tags: ['monitors', 'type-change'],
  async setup(ctx) {
    return {
      id: await createMonitor(ctx, {
        name: `${PREFIX}Status page check`,
        type: 'http',
        url: 'https://example.com/status',
        interval: 120,
      }),
    };
  },
  prompt: 'The status page check should also make sure the page says "All systems operational". Change it to do that.',
  async check(ctx, seed) {
    const m = await getMonitor(ctx, seed.id);
    return [
      expectThat('same monitor is now keyword', m.type === 'keyword', `type=${m.type}`),
      expectThat('keyword set', m.keyword === 'All systems operational', `keyword=${m.keyword}`),
      expectThat('not inverted', m.invertKeyword === false, `invertKeyword=${m.invertKeyword}`),
      expectThat('url kept', m.url === 'https://example.com/status', `url=${m.url}`),
      expectThat('interval kept', m.interval === 120, `interval=${m.interval}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
