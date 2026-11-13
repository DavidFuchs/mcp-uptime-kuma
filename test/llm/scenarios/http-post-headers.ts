import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Webhook receiver`;

const parse = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

export default defineScenario({
  id: 'http-post-headers',
  description: 'HTTP POST with a JSON body, a custom header and extra accepted status codes',
  tags: ['monitors', 'http-options'],
  prompt:
    `Create a monitor "${NAME}" that POSTs {"ping": true} as JSON to https://example.com/hooks/health with the header ` +
    'X-Api-Key: k-42. Treat any 2xx response and also 418 as up.',
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    const headers = parse(m.headers) as Record<string, unknown> | undefined;
    const body = parse(m.body) as Record<string, unknown> | undefined;
    const codes: string[] = Array.isArray(m.accepted_statuscodes)
      ? m.accepted_statuscodes
      : (parse(m.accepted_statuscodes) ?? []);
    return [
      expectThat('method is POST', m.method === 'POST', `method=${m.method}`),
      expectThat('body is {"ping": true}', body?.ping === true, `body=${m.body}`),
      expectThat(
        'body encoding is JSON',
        String(m.httpBodyEncoding ?? 'json').toLowerCase() === 'json',
        `httpBodyEncoding=${m.httpBodyEncoding}`
      ),
      expectThat('X-Api-Key header set', headers?.['X-Api-Key'] === 'k-42', `headers=${m.headers}`),
      expectThat('2xx accepted', codes.includes('200-299'), `accepted_statuscodes=${JSON.stringify(codes)}`),
      expectThat('418 accepted', codes.includes('418'), `accepted_statuscodes=${JSON.stringify(codes)}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
