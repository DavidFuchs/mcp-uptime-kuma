import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor, getMonitor } from '../kuma.js';

const TAG = `${PREFIX}prod`;

export default defineScenario({
  id: 'pause-and-tag',
  description: 'Find a monitor by loose name among similar ones, pause it and tag it',
  tags: ['monitors', 'tags'],
  async setup(ctx) {
    const billing = await createMonitor(ctx, {
      name: `${PREFIX}Billing API`,
      type: 'http',
      url: 'https://example.com/billing',
    });
    const marketing = await createMonitor(ctx, {
      name: `${PREFIX}Marketing Site`,
      type: 'http',
      url: 'https://example.com',
    });
    await call(ctx, 'addTag', { name: TAG, color: '#2563eb' });
    return { billing, marketing };
  },
  prompt: `Pause the billing API monitor and tag it "${TAG}".`,
  async check(ctx, seed) {
    const billing = await getMonitor(ctx, seed.billing);
    const marketing = await getMonitor(ctx, seed.marketing);
    const hasTag = (m: any) => (m.tags ?? []).some((t: any) => t.name === TAG);
    return [
      expectThat('billing monitor is paused', billing.active === false, `active=${billing.active}`),
      expectThat(`billing monitor has tag ${TAG}`, hasTag(billing)),
      expectThat('marketing monitor still active', marketing.active === true),
      expectThat('marketing monitor not tagged', !hasTag(marketing)),
    ];
  },
  budget: { maxToolCalls: 8, maxToolErrors: 1 },
});
