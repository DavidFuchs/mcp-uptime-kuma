import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { redactSecrets, SECRET_MARKER } from '../../src/redact.js';

/**
 * Issue #106: database monitors (mysql, postgres, mongodb, redis, sqlserver) could be read
 * and redacted, but createMonitor/updateMonitor did not declare databaseConnectionString or
 * databaseQuery, so the SDK stripped them and Uptime Kuma answered "Saved." for a monitor
 * with nothing to connect to.
 */

process.setMaxListeners(50);

const CONNECTION_STRING = 'mysql://monitor:s3cret-pw@db.internal:3306/app';

const EXISTING_DB_MONITOR = {
  id: 9,
  name: 'Existing DB',
  type: 'postgres',
  interval: 60,
  retryInterval: 60,
  databaseConnectionString: 'postgres://kuma:stored-pw@pg.internal:5432/app',
  databaseQuery: 'SELECT 1',
};

async function connectServer() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });

  const client = new Client({ name: 'db-fields-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('database monitor fields (#106)', () => {
  let createMonitor: ReturnType<typeof vi.spyOn>;
  let updateMonitor: ReturnType<typeof vi.spyOn>;
  let fetchMonitor: ReturnType<typeof vi.spyOn>;
  let lastWrite: Record<string, unknown>;

  beforeEach(() => {
    lastWrite = {};
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({ ...EXISTING_DB_MONITOR } as never);
    createMonitor = vi.spyOn(UptimeKumaClient.prototype, 'createMonitor').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      lastWrite = data;
      return { ok: true, msg: 'Added Successfully.', monitorID: 9 };
    }) as never);
    updateMonitor = vi.spyOn(UptimeKumaClient.prototype, 'updateMonitor').mockImplementation((async (
      data: Record<string, unknown>
    ) => {
      lastWrite = data;
      return { ok: true, msg: 'Saved.', monitorID: 9 };
    }) as never);
    // By default the server stores exactly what it was sent.
    fetchMonitor = vi
      .spyOn(UptimeKumaClient.prototype, 'fetchMonitor')
      .mockImplementation((async () => ({ ...lastWrite })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createMonitor', () => {
    it('passes the connection string, query and MySQL password through to Uptime Kuma', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'MySQL',
          type: 'mysql',
          databaseConnectionString: CONNECTION_STRING,
          databaseQuery: 'SELECT COUNT(*) FROM users',
          databasePassword: 'separate-pw',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(createMonitor).toHaveBeenCalledTimes(1);
      expect(lastWrite.databaseConnectionString).toBe(CONNECTION_STRING);
      expect(lastWrite.databaseQuery).toBe('SELECT COUNT(*) FROM users');
      // Uptime Kuma's mysql monitor reads its password from radiusPassword.
      expect(lastWrite.radiusPassword).toBe('separate-pw');
      expect(lastWrite).not.toHaveProperty('databasePassword');
    });

    it('accepts the snake_case column names as aliases', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'PG',
          type: 'postgres',
          database_connection_string: CONNECTION_STRING,
          database_query: 'SELECT 1',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.databaseConnectionString).toBe(CONNECTION_STRING);
      expect(lastWrite.databaseQuery).toBe('SELECT 1');
      expect(lastWrite).not.toHaveProperty('database_connection_string');
      expect(lastWrite).not.toHaveProperty('database_query');
    });

    it.each(['mysql', 'postgres', 'mongodb', 'redis', 'sqlserver'])(
      'refuses a %s monitor with no connection string',
      async (type) => {
        const { client } = await connectServer();

        const result = await client.callTool({ name: 'createMonitor', arguments: { name: 'DB', type } });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('databaseConnectionString');
        expect(createMonitor).not.toHaveBeenCalled();
      }
    );

    it('refuses the redaction marker as a connection string', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'Copy', type: 'postgres', databaseConnectionString: SECRET_MARKER },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('databaseConnectionString');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses a mongodb databaseQuery that is not a JSON command', async () => {
      // Uptime Kuma JSON.parses it on every check, so a bad one fails every beat.
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Mongo',
          type: 'mongodb',
          databaseConnectionString: 'mongodb://db.internal:27017',
          databaseQuery: 'db.ping()',
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('JSON');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('accepts a mongodb databaseQuery that is a JSON command', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Mongo',
          type: 'mongodb',
          databaseConnectionString: 'mongodb://db.internal:27017',
          databaseQuery: '{"ping": 1}',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.databaseQuery).toBe('{"ping": 1}');
    });

    it('fails without echoing the connection string when it did not persist', async () => {
      fetchMonitor.mockImplementation((async () => ({ ...lastWrite, databaseConnectionString: null })) as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'PG', type: 'postgres', databaseConnectionString: CONNECTION_STRING },
      });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('databaseConnectionString');
      expect(text).toContain('did NOT persist');
      expect(text).not.toContain('s3cret-pw');
    });
  });

  describe('updateMonitor', () => {
    it('sets the connection string and query on an existing monitor', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMonitor',
        arguments: {
          monitorID: 9,
          databaseConnectionString: 'postgres://kuma:new-pw@pg.internal:5432/app',
          databaseQuery: 'SELECT now()',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(updateMonitor).toHaveBeenCalledTimes(1);
      expect(lastWrite.databaseConnectionString).toBe('postgres://kuma:new-pw@pg.internal:5432/app');
      expect(lastWrite.databaseQuery).toBe('SELECT now()');
    });

    it('keeps the stored connection string when the redaction marker is sent back', async () => {
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMonitor',
        arguments: { monitorID: 9, databaseConnectionString: SECRET_MARKER, databaseQuery: 'SELECT 2' },
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.databaseConnectionString).toBe(EXISTING_DB_MONITOR.databaseConnectionString);
      expect(lastWrite.databaseQuery).toBe('SELECT 2');
      expect(JSON.stringify(result.content)).toContain('Kept the existing value for databaseConnectionString');
    });

    it('validates a mongodb databaseQuery against the stored type', async () => {
      vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockReturnValue({
        ...EXISTING_DB_MONITOR,
        type: 'mongodb',
      } as never);
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'updateMonitor',
        arguments: { monitorID: 9, databaseQuery: 'not json' },
      });

      expect(result.isError).toBe(true);
      expect(updateMonitor).not.toHaveBeenCalled();
    });
  });

  it('read tools mask the connection string and the MySQL password', () => {
    const out = redactSecrets({
      type: 'mysql',
      databaseConnectionString: CONNECTION_STRING,
      radiusPassword: 'separate-pw',
      databaseQuery: 'SELECT 1',
    });

    expect(out.databaseConnectionString).toBe(SECRET_MARKER);
    expect(out.radiusPassword).toBe(SECRET_MARKER);
    expect(out.databaseQuery).toBe('SELECT 1');
  });
});
