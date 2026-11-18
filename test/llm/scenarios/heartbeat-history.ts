import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { createMonitor, getMonitor } from '../kuma.js';

const NAME = `${PREFIX}Backup job`;
const ERROR = 'Disk full on /var/backups';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default defineScenario({
  id: 'heartbeat-history',
  description: 'Read a monitor’s recent history: whether it went down, why, and whether it is back',
  tags: ['heartbeats'],
  async setup(ctx) {
    // A push monitor records a beat for every push, so the history is exactly what is pushed
    // here: three up, two down with the same error, then two up again. The interval is long
    // enough that no missed-push beat lands in between.
    const monitorID = await createMonitor(ctx, { name: NAME, type: 'push', interval: 3600 });
    const { pushToken } = await getMonitor(ctx, monitorID);
    const push = async (status: 'up' | 'down', msg: string, ping?: number) => {
      const url = new URL(`/api/push/${pushToken}`, ctx.config.url);
      url.searchParams.set('status', status);
      url.searchParams.set('msg', msg);
      if (ping !== undefined) url.searchParams.set('ping', String(ping));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`push ${status} returned HTTP ${res.status}`);
      // Distinct timestamps, so the order of the beats is not left to a tie-break.
      await sleep(300);
    };
    for (const ping of [40, 42, 38]) await push('up', 'OK', ping);
    await push('down', ERROR);
    await push('down', ERROR);
    for (const ping of [55, 61]) await push('up', 'OK', ping);
    return { monitorID };
  },
  prompt: `Look at the recent check history of the "${NAME}" monitor. Did it go down, and if so, what was the error and is it back up now?`,
  async check(_ctx, _seed, trace) {
    // Answering is the task, so this scenario reads the reply.
    const reply = trace.finalText.toLowerCase();
    return [
      expectThat('reply names the error', reply.includes('disk full'), trace.finalText.slice(0, 300)),
      expectThat('reply says it is back up', /\b(back up|up again|recovered|is up|currently up)\b/.test(reply)),
    ];
  },
  budget: { maxToolCalls: 4, maxToolErrors: 0 },
});
