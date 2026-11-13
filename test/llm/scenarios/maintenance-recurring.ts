import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor } from '../kuma.js';

const TITLE = `${PREFIX}Weekly patching`;

export default defineScenario({
  id: 'maintenance-recurring',
  description: 'Recurring weekly maintenance in a named time zone',
  tags: ['maintenance'],
  async setup(ctx) {
    return {
      app: await createMonitor(ctx, { name: `${PREFIX}App servers`, type: 'http', url: 'https://example.com/app' }),
    };
  },
  prompt: `Set up a recurring maintenance window "${TITLE}" for the App servers monitor every Sunday from 1am to 3am Toronto time.`,
  async check(ctx, seed) {
    const { maintenanceWindows = [] } = await call(ctx, 'getMaintenanceWindows');
    const w = (maintenanceWindows as any[]).find((x) => x.title === TITLE);
    if (!w) return [expectThat(`maintenance "${TITLE}" exists`, false)];
    const [from, to] = w.timeRange ?? [];
    return [
      expectThat('strategy recurring-weekday', w.strategy === 'recurring-weekday', `strategy=${w.strategy}`),
      expectThat('Sundays only', JSON.stringify(w.weekdays) === '[0]', `weekdays=${JSON.stringify(w.weekdays)}`),
      expectThat('from 01:00', from?.hours === 1 && from?.minutes === 0, `timeRange=${JSON.stringify(w.timeRange)}`),
      expectThat('to 03:00', to?.hours === 3 && to?.minutes === 0, `timeRange=${JSON.stringify(w.timeRange)}`),
      expectThat(
        'timezone America/Toronto',
        w.timezone === 'America/Toronto' || w.timezoneOption === 'America/Toronto',
        `timezone=${w.timezone}`
      ),
      expectThat('active', w.active === true, `active=${w.active}`),
      expectThat(
        'App servers covered',
        (w.monitorIDs ?? []).includes(seed.app),
        `monitorIDs=${JSON.stringify(w.monitorIDs)}`
      ),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
