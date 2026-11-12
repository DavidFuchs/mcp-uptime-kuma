import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { call, createMonitor } from '../kuma.js';

const SLUG = `${PREFIX}status`;

export default defineScenario({
  id: 'status-page-groups',
  description: 'Create a status page and show two monitors in a named group',
  tags: ['status-pages'],
  async setup(ctx) {
    return {
      web: await createMonitor(ctx, { name: `${PREFIX}Website`, type: 'http', url: 'https://example.com' }),
      api: await createMonitor(ctx, { name: `${PREFIX}Public API`, type: 'http', url: 'https://example.com/api' }),
    };
  },
  prompt:
    `Make a public status page titled "Example Status" at the slug "${SLUG}". Give it a description "Live service health" ` +
    'and a section called "Core" showing the Website and Public API monitors.',
  async check(ctx, seed) {
    let page: any;
    try {
      page = await call(ctx, 'getStatusPage', { slug: SLUG });
    } catch (e) {
      return [expectThat(`status page ${SLUG} readable`, false, (e as Error).message)];
    }
    const cfg = page.config ?? page.statusPage ?? page;
    const groups: any[] = page.publicGroupList ?? [];
    const core = groups.find(g => g.name === 'Core');
    const ids = (core?.monitorList ?? []).map((m: any) => m.id);
    return [
      expectThat('title', cfg.title === 'Example Status', `title=${cfg.title}`),
      expectThat('description', cfg.description === 'Live service health', `description=${cfg.description}`),
      expectThat('has a Core group', !!core, `groups=${JSON.stringify(groups.map(g => g.name))}`),
      expectThat('Core shows Website', ids.includes(seed.web), `monitorList=${JSON.stringify(ids)}`),
      expectThat('Core shows Public API', ids.includes(seed.api), `monitorList=${JSON.stringify(ids)}`),
    ];
  },
  async teardown(ctx) {
    // The sweep cannot see this page: Uptime Kuma sends the status page list only at login, so
    // the runner's scripted client never hears of a page claude's own MCP server created.
    try {
      await call(ctx, 'deleteStatusPage', { slug: SLUG });
    } catch (e) {
      if (!/not found|no slug/i.test((e as Error).message)) throw e;
    }
  },
  budget: { maxToolCalls: 8, maxToolErrors: 1 },
});
