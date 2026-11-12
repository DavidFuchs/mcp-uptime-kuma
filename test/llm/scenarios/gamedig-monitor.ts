import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Minecraft`;

export default defineScenario({
  id: 'gamedig-monitor',
  description: 'Game server monitor',
  tags: ['monitors', 'uncommon-types'],
  prompt: `Keep an eye on our Minecraft server at mc.example.com, port 25565. Call it "${NAME}".`,
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is gamedig', m.type === 'gamedig', `type=${m.type}`),
      expectThat('game is minecraft', m.game === 'minecraft', `game=${m.game}`),
      expectThat('hostname', m.hostname === 'mc.example.com', `hostname=${m.hostname}`),
      expectThat('port', m.port === 25565, `port=${m.port}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
