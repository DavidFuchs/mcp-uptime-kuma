import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Nightly backup`;

export default defineScenario({
  id: 'create-push-monitor',
  description: 'Create a push monitor and hand back the URL the job should call',
  tags: ['monitors'],
  prompt: `Set up a push monitor named "${NAME}" that expects a heartbeat every 86400 seconds, and tell me the URL my backup job should call.`,
  async check(ctx, _seed, trace) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    const token = typeof m.pushToken === 'string' ? m.pushToken : '';
    return [
      expectThat('type is push', m.type === 'push', `type=${m.type}`),
      expectThat('interval is 86400', m.interval === 86400, `interval=${m.interval}`),
      expectThat('has a push token', token.length > 0),
      // Returning the URL is the task here, so this is the one scenario that reads the reply.
      expectThat('reply contains the push token', token.length > 0 && trace.finalText.includes(token)),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
