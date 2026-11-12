import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor, getMonitor } from '../kuma.js';

const NAME = `${PREFIX}Ops hook`;
const URL = 'https://example.com/hook';

export default defineScenario({
  id: 'notification-attach',
  description: 'Create a webhook notification and attach it to an existing monitor',
  tags: ['notifications'],
  async setup(ctx) {
    return { checkout: await createMonitor(ctx, { name: `${PREFIX}Checkout`, type: 'http', url: 'https://example.com/checkout' }) };
  },
  prompt: `Create a webhook notification called "${NAME}" that POSTs JSON to ${URL}, and make the Checkout monitor use it.`,
  async check(ctx, seed) {
    const { notifications = [] } = await call(ctx, 'listNotifications', { includeSecrets: true });
    const n = (notifications as any[]).find(x => x.name === NAME);
    if (!n) return [expectThat(`notification "${NAME}" exists`, false)];
    // listNotifications returns config as an object; servers before the eval-findings fix sent a JSON string.
    const config = typeof n.config === 'string' ? JSON.parse(n.config) : (n.config ?? {});
    const m = await getMonitor(ctx, seed.checkout);
    const attached = Object.entries(m.notificationIDList ?? {}).some(([id, on]) => Number(id) === n.id && on);
    return [
      expectThat('type is webhook', config.type === 'webhook', `type=${config.type}`),
      expectThat(`webhook URL is ${URL}`, config.webhookURL === URL, `webhookURL=${config.webhookURL}`),
      expectThat('sends JSON', config.webhookContentType === 'json', `webhookContentType=${config.webhookContentType}`),
      expectThat('Checkout monitor uses it', attached, `notificationIDList=${JSON.stringify(m.notificationIDList)}`),
    ];
  },
  budget: { maxToolCalls: 8, maxToolErrors: 1 },
});
