import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, findMonitor } from '../kuma.js';

const HOST = `${PREFIX}build-box`;
const NAME = `${PREFIX}web container`;

export default defineScenario({
  id: 'docker-container',
  description: 'Add a TCP Docker host and a container monitor on it',
  tags: ['docker'],
  prompt:
    `Our build box runs Docker with the API exposed on tcp://10.0.0.9:2375. Add it as a Docker host called "${HOST}" ` +
    `and monitor its container named "web" as "${NAME}". Don't worry if the host can't be reached from here.`,
  async check(ctx) {
    const { dockerHosts = [] } = await call(ctx, 'listDockerHosts', { includeSecrets: true });
    const host = (dockerHosts as any[]).find(h => h.name === HOST);
    const m = await findMonitor(ctx, NAME);
    return [
      expectThat(`docker host "${HOST}" exists`, !!host),
      expectThat('host type tcp', host?.dockerType === 'tcp', `dockerType=${host?.dockerType}`),
      expectThat('daemon address', String(host?.dockerDaemon ?? '').includes('10.0.0.9:2375'), `dockerDaemon=${host?.dockerDaemon}`),
      expectThat(`monitor "${NAME}" exists`, !!m),
      expectThat('type docker', m?.type === 'docker', `type=${m?.type}`),
      expectThat('container web', m?.docker_container === 'web', `docker_container=${m?.docker_container}`),
      expectThat('on that host', !!host && m?.docker_host === host.id, `docker_host=${m?.docker_host}`),
    ];
  },
  budget: { maxToolCalls: 8, maxToolErrors: 1 },
});
