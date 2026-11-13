import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor, getMonitor } from '../kuma.js';

export default defineScenario({
  id: 'groups-nested',
  description: 'Create a group with a sub-group and move existing monitors into them',
  tags: ['monitors', 'groups'],
  async setup(ctx) {
    return {
      checkout: await createMonitor(ctx, {
        name: `${PREFIX}Checkout API`,
        type: 'http',
        url: 'https://example.com/checkout',
      }),
      refunds: await createMonitor(ctx, {
        name: `${PREFIX}Refunds API`,
        type: 'http',
        url: 'https://example.com/refunds',
      }),
      ledger: await createMonitor(ctx, {
        name: `${PREFIX}Ledger DB`,
        type: 'port',
        hostname: 'db.example.com',
        port: 5432,
      }),
    };
  },
  prompt:
    `Create a monitor group "${PREFIX}Payments" and put the Checkout API and Refunds API monitors in it. Inside it, ` +
    `create a sub-group "${PREFIX}Payments data" and put the Ledger DB monitor there.`,
  async check(ctx, seed) {
    const { monitors = [] } = await call(ctx, 'listMonitors');
    const top = (monitors as any[]).find((m) => m.name === `${PREFIX}Payments`);
    const sub = (monitors as any[]).find((m) => m.name === `${PREFIX}Payments data`);
    const [checkout, refunds, ledger] = await Promise.all(
      [seed.checkout, seed.refunds, seed.ledger].map((id) => getMonitor(ctx, id))
    );
    return [
      expectThat('Payments is a group', top?.type === 'group', `type=${top?.type}`),
      expectThat('Payments data is a group', sub?.type === 'group', `type=${sub?.type}`),
      expectThat('Payments data is inside Payments', !!top && sub?.parent === top.id, `parent=${sub?.parent}`),
      expectThat('Checkout API in Payments', !!top && checkout.parent === top.id, `parent=${checkout.parent}`),
      expectThat('Refunds API in Payments', !!top && refunds.parent === top.id, `parent=${refunds.parent}`),
      expectThat('Ledger DB in Payments data', !!sub && ledger.parent === sub.id, `parent=${ledger.parent}`),
      expectThat('Checkout API url kept', checkout.url === 'https://example.com/checkout', `url=${checkout.url}`),
    ];
  },
  budget: { maxToolCalls: 10, maxToolErrors: 1 },
});
