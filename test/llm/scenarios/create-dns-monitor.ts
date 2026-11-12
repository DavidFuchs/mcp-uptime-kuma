import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}DNS example`;

export default defineScenario({
  id: 'create-dns-monitor',
  description: 'Create a DNS monitor with record type, resolver and interval',
  tags: ['monitors'],
  prompt: `Create a DNS monitor called "${NAME}" that checks the MX record of example.com using the 1.1.1.1 resolver every 120 seconds.`,
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is dns', m.type === 'dns', `type=${m.type}`),
      expectThat('hostname is example.com', m.hostname === 'example.com', `hostname=${m.hostname}`),
      expectThat('record type is MX', m.dns_resolve_type === 'MX', `dns_resolve_type=${m.dns_resolve_type}`),
      expectThat('resolver includes 1.1.1.1', String(m.dns_resolve_server ?? '').includes('1.1.1.1'), `dns_resolve_server=${m.dns_resolve_server}`),
      expectThat('interval is 120', m.interval === 120, `interval=${m.interval}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
