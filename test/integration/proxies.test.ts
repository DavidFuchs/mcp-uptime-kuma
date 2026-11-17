import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type TestFn, type TestContext, extractText } from './helpers.js';

/**
 * Integration tests for proxies, remote browsers and API keys.
 * Covers: listProxies, createProxy, updateProxy, deleteProxy, listRemoteBrowsers,
 * testRemoteBrowser, createRemoteBrowser, updateRemoteBrowser, deleteRemoteBrowser,
 * listAPIKeys, createAPIKey, setAPIKeyActive, deleteAPIKey
 */

type Structured = Record<string, any>;

/** Calls a tool and returns its structured result, throwing on a tool error. */
const caller =
  ({ client }: TestContext) =>
  async (name: string, args: Record<string, unknown> = {}): Promise<Structured> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult & {
      structuredContent: Structured;
    };
    if (result.isError) throw new Error(`${name} failed: ${extractText(result, name)}`);
    return result.structuredContent;
  };

export const proxyTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'proxy lifecycle: create with a login → "***" keeps the password → clear the login → delete detaches monitors',
    fn: async (ctx) => {
      const call = caller(ctx);
      const created = await call('createProxy', {
        protocol: 'http',
        host: '127.0.0.1',
        port: 3128,
        username: 'proxyuser',
        password: 'proxy-secret',
      });
      const proxyID = created.proxyID as number;
      if (!proxyID) throw new Error('createProxy returned no proxyID');
      let monitorID: number | undefined;
      try {
        const stored = async () =>
          ((await call('listProxies', { includeSecrets: true })).proxies as Structured[]).find((p) => p.id === proxyID);

        let proxy = await stored();
        if (!proxy?.auth || proxy.password !== 'proxy-secret')
          throw new Error(`create did not store the login: ${JSON.stringify(proxy)}`);
        const redacted = ((await call('listProxies')).proxies as Structured[]).find((p) => p.id === proxyID);
        if (redacted?.password === 'proxy-secret') throw new Error('listProxies returned the password unredacted');

        await call('updateProxy', { proxyID, port: 8080, password: '***' });
        proxy = await stored();
        if (proxy?.port !== 8080 || proxy.password !== 'proxy-secret' || proxy.username !== 'proxyuser') {
          throw new Error(`update did not keep the login: ${JSON.stringify(proxy)}`);
        }

        await call('updateProxy', { proxyID, username: '' });
        proxy = await stored();
        if (proxy?.auth !== false)
          throw new Error(`clearing the username should turn auth off: ${JSON.stringify(proxy)}`);

        monitorID = (
          await call('createMonitor', {
            name: 'zz-proxy-delete-me',
            type: 'http',
            url: 'http://127.0.0.1:3001',
            active: false,
            typeFields: { proxyId: proxyID },
          })
        ).monitorID as number;

        await call('deleteProxy', { proxyID });
        if (await stored()) throw new Error('deleted proxy is still listed');
        const monitor = (await call('getMonitor', { monitorID, includeTypeSpecificFields: true }))
          .monitor as Structured;
        if (monitor.proxyId != null)
          throw new Error(`the monitor still points at the deleted proxy: ${monitor.proxyId}`);

        console.log(`  ✓ proxy ${proxyID}: login kept on "***", cleared, deleted; monitor ${monitorID} detached`);
      } finally {
        await ctx.client.callTool({ name: 'deleteProxy', arguments: { proxyID } }).catch(() => {});
        if (monitorID !== undefined) await ctx.client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: 'remote browser lifecycle: token redacted, name updated keeping the URL, test reaches Uptime Kuma',
    fn: async (ctx) => {
      const call = caller(ctx);
      const url = 'ws://127.0.0.1:1?token=rb-secret';
      const remoteBrowserID = (await call('createRemoteBrowser', { name: 'zz-remote-browser', url }))
        .remoteBrowserID as number;
      if (!remoteBrowserID) throw new Error('createRemoteBrowser returned no remoteBrowserID');
      try {
        const listed = ((await call('listRemoteBrowsers')).remoteBrowsers as Structured[]).find(
          (rb) => rb.id === remoteBrowserID
        );
        if (listed?.url !== 'ws://127.0.0.1:1?token=***') throw new Error(`token not redacted: ${listed?.url}`);

        await call('updateRemoteBrowser', { remoteBrowserID, name: 'zz-remote-browser-renamed' });
        const after = (
          (await call('listRemoteBrowsers', { includeSecrets: true })).remoteBrowsers as Structured[]
        ).find((rb) => rb.id === remoteBrowserID);
        if (after?.name !== 'zz-remote-browser-renamed' || after.url !== url) {
          throw new Error(`rename did not keep the URL: ${JSON.stringify(after)}`);
        }

        // Nothing listens on port 1: the test must come back as a failure from Uptime Kuma.
        const test = (await ctx.client.callTool({
          name: 'testRemoteBrowser',
          arguments: { remoteBrowserID },
        })) as CallToolResult;
        if (!test.isError) throw new Error('testing an unreachable browser should fail');

        console.log(`  ✓ remote browser ${remoteBrowserID}: token redacted, renamed, unreachable test reported`);
      } finally {
        await ctx.client.callTool({ name: 'deleteRemoteBrowser', arguments: { remoteBrowserID } });
      }
    },
  },
  {
    name: 'API key opens /metrics, and is refused once switched off',
    fn: async (ctx) => {
      const call = caller(ctx);
      const created = await call('createAPIKey', { name: 'zz-integration-key' });
      const keyID = created.keyID as number;
      const key = created.key as string;
      if (!keyID || !/^uk\d+_/.test(key ?? '')) throw new Error(`unexpected key: ${JSON.stringify(created)}`);
      try {
        const metrics = async () =>
          (
            await fetch(`${ctx.config.url.replace(/\/$/, '')}/metrics`, {
              headers: { Authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` },
            })
          ).status;

        const listed = ((await call('listAPIKeys')).apiKeys as Structured[]).find((k) => k.id === keyID);
        if (listed?.status !== 'active') throw new Error(`new key should be active: ${JSON.stringify(listed)}`);
        if (JSON.stringify(listed).includes(key)) throw new Error('listAPIKeys returned the key itself');

        const open = await metrics();
        if (open !== 200) throw new Error(`/metrics with the new key answered ${open}, expected 200`);

        await call('setAPIKeyActive', { keyID, active: false });
        const closed = await metrics();
        if (closed !== 401) throw new Error(`/metrics with the disabled key answered ${closed}, expected 401`);

        console.log(`  ✓ API key ${keyID}: /metrics 200 while active, 401 once disabled`);
      } finally {
        await ctx.client.callTool({ name: 'deleteAPIKey', arguments: { keyID } });
      }
    },
  },
];
