import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Edge IPs`;

export default defineScenario({
  id: 'dns-condition',
  description: 'DNS monitor with a condition on the resolved record',
  tags: ['monitors', 'conditions'],
  prompt: `Create a DNS monitor "${NAME}" for edge.example.com that is only up when the A record contains "192.0.2.".`,
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    const conditions = typeof m.conditions === 'string' ? JSON.parse(m.conditions || '[]') : (m.conditions ?? []);
    const flat = (cs: any[]): any[] => cs.flatMap(c => [c, ...flat(c.children ?? [])]);
    const match = flat(conditions).find(c => c.type === 'expression' && c.variable === 'record' && c.operator === 'contains' && c.value === '192.0.2.');
    return [
      expectThat('type is dns', m.type === 'dns', `type=${m.type}`),
      expectThat('record type A', m.dns_resolve_type === 'A', `dns_resolve_type=${m.dns_resolve_type}`),
      expectThat('condition: record contains 192.0.2.', !!match, `conditions=${JSON.stringify(conditions)}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
