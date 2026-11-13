import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}RADIUS auth`;

export default defineScenario({
  id: 'radius-monitor',
  description: 'RADIUS monitor with secret, user and called-station ID',
  tags: ['monitors', 'uncommon-types'],
  prompt:
    `Monitor our RADIUS server radius.example.com as "${NAME}": authenticate as "healthcheck" with password ` +
    '"rad-Pass9", shared secret "shh-secret", called-station ID "AA-BB-CC-DD-EE-FF:corp" and calling-station ID ' +
    '"11-22-33-44-55-66".',
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is radius', m.type === 'radius', `type=${m.type}`),
      expectThat('hostname', m.hostname === 'radius.example.com', `hostname=${m.hostname}`),
      expectThat('username', m.radiusUsername === 'healthcheck', `radiusUsername=${m.radiusUsername}`),
      expectThat('password', m.radiusPassword === 'rad-Pass9', `radiusPassword=${m.radiusPassword}`),
      expectThat('secret', m.radiusSecret === 'shh-secret', `radiusSecret=${m.radiusSecret}`),
      expectThat(
        'called-station ID',
        m.radiusCalledStationId === 'AA-BB-CC-DD-EE-FF:corp',
        `radiusCalledStationId=${m.radiusCalledStationId}`
      ),
      expectThat(
        'calling-station ID',
        m.radiusCallingStationId === '11-22-33-44-55-66',
        `radiusCallingStationId=${m.radiusCallingStationId}`
      ),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
