import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { createMonitor, getMonitor } from '../kuma.js';

const TAG = `${PREFIX}env`;

export default defineScenario({
  id: 'tag-with-value',
  description: 'Tag a monitor with a name=value tag, keeping its existing tag',
  tags: ['tags'],
  async setup(ctx) {
    return {
      id: await createMonitor(ctx, {
        name: `${PREFIX}Search`, type: 'http', url: 'https://example.com/search',
        tags: [{ name: `${PREFIX}team`, value: 'discovery' }],
      }),
    };
  },
  prompt: `Tag the search monitor ${TAG}=prod.`,
  async check(ctx, seed) {
    const m = await getMonitor(ctx, seed.id);
    const tags: any[] = m.tags ?? [];
    return [
      expectThat(`has ${TAG} with value prod`, tags.some(t => t.name === TAG && t.value === 'prod'), `tags=${JSON.stringify(tags.map(t => `${t.name}=${t.value}`))}`),
      expectThat('kept team=discovery', tags.some(t => t.name === `${PREFIX}team` && t.value === 'discovery'), `tags=${JSON.stringify(tags.map(t => `${t.name}=${t.value}`))}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
