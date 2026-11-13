import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Core switch uptime`;

export default defineScenario({
  id: 'snmp-monitor',
  description: 'SNMP v2c monitor with community string and expected value',
  tags: ['monitors', 'uncommon-types'],
  prompt:
    `Add an SNMP v2c monitor "${NAME}" for switch 10.20.0.1, community "netops-ro", reading OID 1.3.6.1.2.1.1.3.0. ` +
    'It is up when the value is greater than 0.',
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is snmp', m.type === 'snmp', `type=${m.type}`),
      expectThat('hostname', m.hostname === '10.20.0.1', `hostname=${m.hostname}`),
      expectThat('OID', m.snmpOid === '1.3.6.1.2.1.1.3.0', `snmpOid=${m.snmpOid}`),
      expectThat('version 2c', m.snmpVersion === '2c', `snmpVersion=${m.snmpVersion}`),
      // Uptime Kuma keeps the community string in radiusPassword.
      expectThat(
        'community stored',
        m.radiusPassword === 'netops-ro' || m.snmpCommunity === 'netops-ro',
        `radiusPassword=${m.radiusPassword}`
      ),
      expectThat('operator >', m.jsonPathOperator === '>', `jsonPathOperator=${m.jsonPathOperator}`),
      expectThat('expected value 0', String(m.expectedValue) === '0', `expectedValue=${m.expectedValue}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
