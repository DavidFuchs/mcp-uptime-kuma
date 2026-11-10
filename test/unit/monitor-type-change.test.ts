import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';

/**
 * Issue #110 / PR #100: changing a monitor's type in place.
 *
 * Uptime Kuma's Monitor.validate() has no per-type required fields, and the fix-ups its web UI
 * applies on a type change (push token, DNS defaults) happen in the browser. So a type change
 * through updateMonitor has to pass the same rules createMonitor applies, or it saves a
 * monitor that can never report.
 */

process.setMaxListeners(50);

const HTTP_MONITOR = {
  id: 7,
  name: 'Existing',
  type: 'http',
  url: 'https://example.com',
  hostname: null,
  port: null,
  interval: 60,
  retryInterval: 60,
  timeout: 48,
  accepted_statuscodes: ['200-299'],
};

// What a ping monitor made in the web UI looks like: the form's "https://" placeholder is
// stored in url even though the type never uses it.
const PING_MONITOR = {
  ...HTTP_MONITOR,
  type: 'ping',
  url: 'https://',
  hostname: 'app.example.com',
};

async function connectServer(url = 'http://localhost:3001') {
  const { server } = await createServer({
    url,
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });

  const client = new Client({ name: 'type-change-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('monitor type rules shared by createMonitor and updateMonitor', () => {
  let getMonitor: ReturnType<typeof vi.spyOn>;
  let createMonitor: ReturnType<typeof vi.spyOn>;
  let updateMonitor: ReturnType<typeof vi.spyOn>;
  let lastWrite: Record<string, unknown>;

  const existingIs = (monitor: Record<string, unknown>) => getMonitor.mockReturnValue({ ...monitor } as never);

  const update = async (args: Record<string, unknown>) => {
    const { client } = await connectServer();
    return client.callTool({ name: 'updateMonitor', arguments: { monitorID: 7, ...args } });
  };

  const create = async (args: Record<string, unknown>) => {
    const { client } = await connectServer();
    return client.callTool({ name: 'createMonitor', arguments: { name: 'New', ...args } });
  };

  beforeEach(() => {
    lastWrite = {};
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    getMonitor = vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({ ...HTTP_MONITOR } as never);
    createMonitor = vi.spyOn(UptimeKumaClient.prototype, 'createMonitor').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      lastWrite = data;
      return { ok: true, msg: 'Added Successfully.', monitorID: 7 };
    }) as never);
    updateMonitor = vi.spyOn(UptimeKumaClient.prototype, 'updateMonitor').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      lastWrite = data;
      return { ok: true, msg: 'Saved.', monitorID: 7 };
    }) as never);
    // By default the server stores exactly what it was sent.
    vi.spyOn(UptimeKumaClient.prototype, 'fetchMonitor').mockImplementation((async () => ({ ...lastWrite })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateMonitor: required fields of the new type', () => {
    it('refuses ping -> http when no url is passed and only the UI placeholder is stored', async () => {
      existingIs(PING_MONITOR);

      const result = await update({ type: 'http' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('url');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('converts ping -> http when the url comes with it', async () => {
      existingIs(PING_MONITOR);

      const result = await update({ type: 'http', url: 'https://app.example.com/ping' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ id: 7, type: 'http', url: 'https://app.example.com/ping' });
    });

    it('refuses http -> ping without a hostname', async () => {
      const result = await update({ type: 'ping' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('hostname');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('refuses http -> json-query without the query fields', async () => {
      const result = await update({ type: 'json-query' });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('jsonPath');
      expect(text).toContain('expectedValue');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('refuses http -> postgres without a connection string', async () => {
      const result = await update({ type: 'postgres' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('databaseConnectionString');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('refuses postgres -> mongodb while the stored query is still SQL', async () => {
      existingIs({
        ...HTTP_MONITOR,
        type: 'postgres',
        databaseConnectionString: 'postgres://kuma:pw@pg.internal:5432/app',
        databaseQuery: 'SELECT 1',
      });

      const result = await update({ type: 'mongodb' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('JSON command');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('accepts the snake_case aliases as satisfying the new type', async () => {
      const result = await update({
        type: 'json-query',
        json_path: 'status',
        json_path_operator: '==',
        expected_value: 'healthy',
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({
        type: 'json-query',
        jsonPath: 'status',
        jsonPathOperator: '==',
        expectedValue: 'healthy',
      });
    });

    it('accepts a field the monitor already stores as satisfying the new type', async () => {
      existingIs({ ...PING_MONITOR, port: 443 });

      const result = await update({ type: 'port' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ type: 'port', hostname: 'app.example.com', port: 443 });
    });

    it('does not apply the rules when the type is sent back unchanged', async () => {
      // The read-edit-write loop echoes `type`. A monitor that is already incomplete must
      // still be renameable.
      existingIs({ ...HTTP_MONITOR, url: 'https://' });

      const result = await update({ type: 'http', name: 'Renamed' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ type: 'http', name: 'Renamed' });
    });
  });

  describe('updateMonitor: defaults of the new type', () => {
    it('generates a push token for http -> push and returns the ping URL', async () => {
      const result = await update({ type: 'push' });

      expect(result.isError).toBeFalsy();
      const token = lastWrite.pushToken as string;
      expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.pushToken).toBe(token);
      expect(structured.pushURL).toBe(`http://localhost:3001/api/push/${token}?status=up&msg=OK&ping=`);
    });

    it('builds the ping URL without doubling slashes when the configured URL ends in some', async () => {
      const { client } = await connectServer('http://localhost:3001///');

      const result = await client.callTool({ name: 'updateMonitor', arguments: { monitorID: 7, type: 'push' } });

      const { pushToken, pushURL } = result.structuredContent as Record<string, string>;
      expect(pushURL).toBe(`http://localhost:3001/api/push/${pushToken}?status=up&msg=OK&ping=`);
    });

    it('keeps a push token the monitor already stores', async () => {
      existingIs({ ...HTTP_MONITOR, pushToken: 'stored-token-0123456789' });

      const result = await update({ type: 'push' });

      expect(lastWrite.pushToken).toBe('stored-token-0123456789');
      expect((result.structuredContent as Record<string, unknown>).pushToken).toBe('stored-token-0123456789');
    });

    it('fails the call when the generated push token is acknowledged but not stored', async () => {
      vi.mocked(UptimeKumaClient.prototype.fetchMonitor).mockImplementation((async () => ({
        ...lastWrite,
        pushToken: null,
      })) as never);

      const result = await update({ type: 'push' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('did NOT persist');
      // The token is the only copy outside the database, so it is still returned.
      expect((result.structuredContent as Record<string, unknown>).pushToken).toBe(lastWrite.pushToken);
    });

    it('gives a monitor leaving push the default timeout instead of the stored 0', async () => {
      existingIs({ ...HTTP_MONITOR, type: 'push', url: 'https://', timeout: 0, pushToken: 'stored-token-0123456789' });

      await update({ type: 'http', url: 'https://example.com/health' });

      expect(lastWrite.timeout).toBe(48);
    });

    it('brings a carried-over timeout into the range Uptime Kuma accepts for ping', async () => {
      existingIs({ ...HTTP_MONITOR, interval: 600, timeout: 480 });

      await update({ type: 'ping', hostname: 'app.example.com' });

      expect(lastWrite.timeout).toBe(300);
    });

    it('treats a null timeout sent with a type change as not chosen', async () => {
      await update({ type: 'ping', hostname: 'app.example.com', timeout: null });

      expect(lastWrite.timeout).toBe(48);
    });

    it('leaves a timeout the caller chose alone', async () => {
      await update({ type: 'ping', hostname: 'app.example.com', timeout: 12 });

      expect(lastWrite.timeout).toBe(12);
    });

    it('fills in the resolver and record type for a monitor becoming dns', async () => {
      existingIs(PING_MONITOR);

      await update({ type: 'dns' });

      expect(lastWrite).toMatchObject({ type: 'dns', dns_resolve_server: '1.1.1.1', dns_resolve_type: 'A' });
    });
  });

  describe('updateMonitor: groups', () => {
    it('lets a group be updated with its own type sent back', async () => {
      existingIs({ ...HTTP_MONITOR, type: 'group', url: 'https://' });

      const result = await update({ type: 'group', name: 'Renamed group' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ type: 'group', name: 'Renamed group' });
    });

    it('converts a monitor into a group', async () => {
      const result = await update({ type: 'group' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ type: 'group' });
    });
  });

  describe('type names', () => {
    it('updateMonitor rejects a type Uptime Kuma does not have', async () => {
      const result = await update({ type: 'json_query' });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('json_query');
      expect(text).toContain('listMonitorTypes');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('leaves a monitor of a type this server does not list editable', async () => {
      // A newer Uptime Kuma can have types listMonitorTypes has not caught up with.
      existingIs({ ...HTTP_MONITOR, type: 'from-a-newer-kuma' });

      const result = await update({ type: 'from-a-newer-kuma', name: 'Renamed' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ type: 'from-a-newer-kuma', name: 'Renamed' });
    });

    it('createMonitor rejects a type Uptime Kuma does not have', async () => {
      const result = await create({ type: 'json_query', url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('listMonitorTypes');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('every type Uptime Kuma registers is listed and accepted', async () => {
      const { client } = await connectServer();
      const listed = await client.callTool({ name: 'listMonitorTypes', arguments: {} });
      const types = (listed.structuredContent as { types: { type: string }[] }).types.map((t) => t.type);

      // server/monitor-types/* plus the types handled inline in server/model/monitor.js.
      for (const type of [
        'http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'docker', 'push', 'group', 'steam', 'radius',
        'kafka-producer', 'gamedig', 'globalping', 'grpc-keyword', 'manual', 'mongodb', 'mqtt', 'mysql', 'ntp',
        'oracledb', 'pm2', 'postgres', 'rabbitmq', 'real-browser', 'redis', 'sftp', 'sip-options', 'smtp', 'snmp',
        'sqlserver', 'system-service', 'tailscale-ping', 'websocket-upgrade',
      ]) {
        expect(types).toContain(type);
      }
    });
  });

  describe('createMonitor: required fields', () => {
    it.each([
      ['http', ['url']],
      ['keyword', ['url', 'keyword']],
      ['json-query', ['url', 'jsonPath', 'jsonPathOperator', 'expectedValue']],
      ['port', ['hostname', 'port']],
      ['ping', ['hostname']],
      ['dns', ['hostname']],
      ['docker', ['docker_container', 'docker_host']],
      ['mysql', ['databaseConnectionString']],
      ['postgres', ['databaseConnectionString']],
      ['mongodb', ['databaseConnectionString']],
      ['redis', ['databaseConnectionString']],
      ['sqlserver', ['databaseConnectionString']],
    ])('a %s monitor is refused until it has %j', async (type, fields) => {
      const bare = await create({ type });

      expect(bare.isError).toBe(true);
      const match = /needs ([^.]+)\./.exec(JSON.stringify(bare.content));
      expect(match?.[1].split(', ')).toEqual(fields);
      expect(createMonitor).not.toHaveBeenCalled();

      const values: Record<string, unknown> = {
        url: 'https://example.com',
        keyword: 'ok',
        jsonPath: 'status',
        jsonPathOperator: '==',
        expectedValue: 'healthy',
        hostname: 'example.com',
        port: 443,
        docker_container: 'web',
        docker_host: 1,
        databaseConnectionString: 'db://user:pw@db.internal/app',
      };
      const complete = await create({ type, ...Object.fromEntries(fields.map((f) => [f, values[f]])) });

      expect(complete.isError).toBeFalsy();
      expect(createMonitor).toHaveBeenCalledTimes(1);
    });

    it('refuses an http monitor without a url', async () => {
      const result = await create({ type: 'http' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('url');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses a port monitor without hostname and port', async () => {
      const result = await create({ type: 'port' });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('hostname');
      expect(text).toContain('port');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('still defaults the timeout and DNS fields', async () => {
      await create({ type: 'dns', hostname: 'example.com' });

      expect(lastWrite).toMatchObject({ dns_resolve_server: '1.1.1.1', dns_resolve_type: 'A', timeout: 48 });
    });
  });
});
