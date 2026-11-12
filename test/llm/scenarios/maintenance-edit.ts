import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor } from '../kuma.js';

const TITLE = `${PREFIX}Network upgrade`;

export default defineScenario({
  id: 'maintenance-edit',
  description: 'Extend an existing maintenance window and add a monitor, keeping the rest',
  tags: ['maintenance'],
  async setup(ctx) {
    const router = await createMonitor(ctx, { name: `${PREFIX}Router`, type: 'ping', hostname: '10.0.0.1' });
    const vpn = await createMonitor(ctx, { name: `${PREFIX}VPN`, type: 'port', hostname: 'vpn.example.com', port: 443 });
    const { maintenanceID } = await call(ctx, 'createMaintenance', {
      title: TITLE, description: 'Core switch swap', strategy: 'single',
      dateRange: ['2027-03-01T22:00', '2027-03-01T23:00'], timezone: 'Europe/Berlin', monitorIDs: [router],
    });
    return { router, vpn, maintenanceID: Number(maintenanceID) };
  },
  prompt: 'The network upgrade maintenance will run late: make it end at midnight instead of 23:00, and also cover the VPN monitor.',
  async check(ctx, seed) {
    const { maintenanceWindows = [] } = await call(ctx, 'getMaintenanceWindows');
    const w = (maintenanceWindows as any[]).find(x => x.id === seed.maintenanceID);
    if (!w) return [expectThat('maintenance still exists', false)];
    const [start, end] = (w.dateRange ?? []).map((d: unknown) => String(d ?? ''));
    const ids: number[] = w.monitorIDs ?? [];
    return [
      expectThat('title kept', w.title === TITLE, `title=${w.title}`),
      expectThat('description kept', w.description === 'Core switch swap', `description=${w.description}`),
      expectThat('timezone kept', w.timezone === 'Europe/Berlin' || w.timezoneOption === 'Europe/Berlin', `timezone=${w.timezone}`),
      expectThat('start kept', start.includes('2027-03-01') && start.includes('22:00'), `start=${start}`),
      expectThat('ends at midnight', (end.includes('2027-03-02') && end.includes('00:00')) || (end.includes('2027-03-01') && end.includes('23:59')), `end=${end}`),
      expectThat('router still covered', ids.includes(seed.router), `monitorIDs=${JSON.stringify(ids)}`),
      expectThat('VPN now covered', ids.includes(seed.vpn), `monitorIDs=${JSON.stringify(ids)}`),
    ];
  },
  budget: { maxToolCalls: 8, maxToolErrors: 1 },
});
