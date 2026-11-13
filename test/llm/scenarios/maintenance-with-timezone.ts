import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor } from '../kuma.js';

const TITLE = `${PREFIX}DB upgrade`;

export default defineScenario({
  id: 'maintenance-with-timezone',
  description: 'Schedule a one-off maintenance window in a named time zone for one monitor',
  tags: ['maintenance'],
  async setup(ctx) {
    return {
      payments: await createMonitor(ctx, { name: `${PREFIX}Payments`, type: 'http', url: 'https://example.com/pay' }),
    };
  },
  prompt: `Schedule a one-off maintenance window called "${TITLE}" for the Payments monitor, from 2027-01-15 02:00 to 04:00 Toronto time.`,
  async check(ctx, seed) {
    const { maintenanceWindows = [] } = await call(ctx, 'getMaintenanceWindows');
    const w = (maintenanceWindows as any[]).find((x) => x.title === TITLE);
    if (!w) return [expectThat(`maintenance "${TITLE}" exists`, false)];
    const [start, end] = (w.dateRange ?? []).map((d: unknown) => String(d ?? ''));
    return [
      expectThat('strategy is single (one-off)', w.strategy === 'single', `strategy=${w.strategy}`),
      expectThat(
        'timezone is America/Toronto',
        w.timezone === 'America/Toronto' || w.timezoneOption === 'America/Toronto',
        `timezone=${w.timezone} option=${w.timezoneOption}`
      ),
      expectThat('starts 2027-01-15 02:00', start.includes('2027-01-15') && start.includes('02:00'), `start=${start}`),
      expectThat('ends 2027-01-15 04:00', end.includes('2027-01-15') && end.includes('04:00'), `end=${end}`),
      expectThat(
        'Payments monitor attached',
        (w.monitorIDs ?? []).includes(seed.payments),
        `monitorIDs=${JSON.stringify(w.monitorIDs)}`
      ),
    ];
  },
  budget: { maxToolCalls: 8, maxToolErrors: 1 },
});
