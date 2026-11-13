import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { createMonitor, getMonitor } from '../kuma.js';

export default defineScenario({
  id: 'update-without-clobber',
  description: 'Change one field of a monitor without resetting the others',
  tags: ['monitors'],
  async setup(ctx) {
    const id = await createMonitor(ctx, {
      name: `${PREFIX}API health`,
      type: 'http',
      url: 'https://example.com/health',
      interval: 60,
      maxretries: 3,
      description: 'do not touch',
    });
    return { id };
  },
  prompt: 'Change the check interval of the API health monitor to 300 seconds.',
  async check(ctx, seed) {
    const m = await getMonitor(ctx, seed.id);
    return [
      expectThat('interval is 300', m.interval === 300, `interval=${m.interval}`),
      expectThat('url unchanged', m.url === 'https://example.com/health', `url=${m.url}`),
      expectThat('maxretries unchanged', m.maxretries === 3, `maxretries=${m.maxretries}`),
      expectThat('description unchanged', m.description === 'do not touch', `description=${m.description}`),
      expectThat('type unchanged', m.type === 'http', `type=${m.type}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
