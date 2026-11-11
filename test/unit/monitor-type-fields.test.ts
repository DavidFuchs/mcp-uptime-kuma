import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { redactSecrets, SECRET_MARKER } from '../../src/redact.js';

/**
 * Issue #112: createMonitor and updateMonitor declared the fields of only a handful of monitor
 * types. For the rest, the fields the check depends on were rejected as unknown, so the monitor
 * could be created but not configured, and then failed every check.
 */

process.setMaxListeners(400);

/**
 * Every field Uptime Kuma 2.5.9's `editMonitor` handler reads off the payload
 * (server/server.js, the `bean.x = monitor.y` block), by the name it READS — `saveResponse`,
 * not the `save_response` it assigns to. A field missing from the write tools is one a caller
 * cannot set, which is the whole of #112.
 *
 * `id` and `accepted_statuscodes_json` are excluded: the first is `monitorID` here and the
 * second is derived from `accepted_statuscodes`.
 */
const FIELDS_EDIT_MONITOR_READS = [
  'name', 'description', 'parent', 'type', 'subtype', 'url', 'wsIgnoreSecWebsocketAcceptHeader', 'wsSubprotocol',
  'method', 'body', 'ipFamily', 'headers', 'basic_auth_user', 'basic_auth_pass', 'bearer_token', 'timeout',
  'oauth_client_id', 'oauth_client_secret', 'oauth_auth_method', 'oauth_token_url', 'oauth_scopes', 'oauth_audience',
  'tlsCa', 'tlsCert', 'tlsKey', 'interval', 'retryInterval', 'resendInterval', 'hostname', 'game', 'maxretries',
  'port', 'location', 'protocol', 'keyword', 'invertKeyword', 'ignoreTls', 'expiryNotification',
  'domainExpiryNotification', 'upsideDown', 'packetSize', 'maxredirects', 'accepted_statuscodes', 'saveResponse',
  'saveErrorResponse', 'responseMaxLength', 'dns_resolve_type', 'dns_resolve_server', 'pushToken',
  'docker_container', 'docker_host', 'proxyId', 'mqttUsername', 'mqttPassword', 'mqttTopic', 'mqttSuccessMessage',
  'mqttCheckType', 'mqttWebsocketPath', 'databaseConnectionString', 'databaseQuery', 'authMethod',
  'authWorkstation', 'authDomain', 'grpcUrl', 'grpcProtobuf', 'grpcServiceName', 'grpcMethod', 'grpcBody',
  'grpcMetadata', 'grpcEnableTls', 'radiusUsername', 'radiusPassword', 'radiusCalledStationId',
  'radiusCallingStationId', 'radiusSecret', 'httpBodyEncoding', 'expectedValue', 'jsonPath', 'kafkaProducerTopic',
  'kafkaProducerBrokers', 'kafkaProducerAllowAutoTopicCreation', 'kafkaProducerSaslOptions',
  'kafkaProducerMessage', 'cacheBust', 'kafkaProducerSsl', 'gamedigGivenPortOnly', 'gamedigToken',
  'remote_browser', 'screenshot_delay', 'smtpSecurity', 'snmpVersion', 'snmpOid', 'jsonPathOperator',
  'retryOnlyOnStatusCodeFailure', 'rabbitmqNodes', 'rabbitmqUsername', 'rabbitmqPassword', 'conditions',
  'manual_status', 'system_service_name', 'sshUsername', 'sshPassword', 'sftpPath', 'sshPrivateKey',
  'sshPassphrase', 'sshAuthMethod', 'ntpStratumThreshold', 'ntpTimeOffsetThreshold', 'ntpRootDispersionThreshold',
  'ping_numeric', 'ping_count', 'ping_per_request_timeout',
];

/** A working minimum for each type #112 added required fields to. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  mqtt: { hostname: 'mqtt://broker.internal', port: 1883, mqttTopic: 'sensors/#' },
  'grpc-keyword': {
    grpcUrl: 'grpc.internal:50051',
    grpcProtobuf: 'syntax = "proto3"; service Health { rpc Check (Req) returns (Res); }',
    grpcServiceName: 'Health',
    grpcMethod: 'Check',
    keyword: 'SERVING',
  },
  'kafka-producer': {
    kafkaProducerBrokers: ['kafka.internal:9092'],
    kafkaProducerTopic: 'uptime',
    kafkaProducerMessage: 'ping',
  },
  radius: { hostname: 'radius.internal', radiusUsername: 'probe', radiusPassword: 'pw', radiusSecret: 'shared' },
  rabbitmq: { rabbitmqNodes: ['https://rabbit.internal:15672'] },
  smtp: { hostname: 'mail.internal' },
  snmp: { hostname: 'switch.internal', snmpOid: '1.3.6.1.2.1.1.3.0', snmpCommunity: 'public', expectedValue: '1' },
  gamedig: { hostname: 'mc.internal', port: 25565, game: 'minecraft' },
  steam: { hostname: 'cs.internal', port: 27015 },
  'real-browser': { url: 'https://example.com' },
  'websocket-upgrade': { url: 'wss://ws.internal/socket' },
  sftp: { hostname: 'sftp.internal', sshUsername: 'probe', sshPassword: 'pw' },
  ntp: { hostname: 'pool.ntp.org' },
  'sip-options': { hostname: 'sip.internal', port: 5060 },
  'tailscale-ping': { hostname: 'node.tailnet.ts.net' },
  oracledb: { databaseConnectionString: 'db.internal:1521/XEPDB1' },
  'system-service': { system_service_name: 'nginx' },
  pm2: { system_service_name: 'api' },
  globalping: { hostname: 'example.com' },
};

const EXISTING_HTTP_MONITOR: Record<string, unknown> = {
  id: 7,
  name: 'Existing HTTP',
  type: 'http',
  url: 'https://api.internal/health',
  interval: 60,
  retryInterval: 60,
  timeout: 48,
  accepted_statuscodes: ['200-299'],
  authMethod: null,
  basic_auth_user: null,
  basic_auth_pass: null,
  bearer_token: null,
};

async function connectServer() {
  const { server } = await createServer({
    url: 'http://localhost:3001',
    username: undefined,
    password: undefined,
    token: undefined,
    jwtToken: undefined,
  });
  const client = new Client({ name: 'type-fields-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

describe('type-specific monitor fields (#112)', () => {
  let createMonitor: ReturnType<typeof vi.spyOn>;
  let updateMonitor: ReturnType<typeof vi.spyOn>;
  let fetchMonitor: ReturnType<typeof vi.spyOn>;
  let existing: Record<string, unknown>;
  let lastWrite: Record<string, unknown>;

  beforeEach(() => {
    lastWrite = {};
    existing = { ...EXISTING_HTTP_MONITOR };
    vi.spyOn(UptimeKumaClient.prototype, 'ensureConnected').mockResolvedValue(undefined as never);
    vi.spyOn(UptimeKumaClient.prototype, 'login').mockResolvedValue({ ok: true } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getSettings').mockResolvedValue({ ok: true, data: {} } as never);
    vi.spyOn(UptimeKumaClient.prototype, 'getMonitor').mockImplementation((() => ({ ...existing })) as never);
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
    fetchMonitor = vi
      .spyOn(UptimeKumaClient.prototype, 'fetchMonitor')
      .mockImplementation((async () => ({ ...lastWrite })) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const create = async (args: Record<string, unknown>) => {
    const { client } = await connectServer();
    return client.callTool({ name: 'createMonitor', arguments: { name: 'M', ...args } });
  };
  const update = async (args: Record<string, unknown>) => {
    const { client } = await connectServer();
    return client.callTool({ name: 'updateMonitor', arguments: { monitorID: 7, ...args } });
  };

  describe('schema coverage', () => {
    it.each(['createMonitor', 'updateMonitor'])('%s accepts every field editMonitor reads', async (toolName) => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      const properties = Object.keys(
        (tools.find((t) => t.name === toolName)!.inputSchema.properties ?? {}) as Record<string, unknown>
      );

      expect(FIELDS_EDIT_MONITOR_READS.filter((f) => !properties.includes(f))).toEqual([]);
    });

    it('declares the same type-specific fields on both tools', async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      const props = (name: string) =>
        Object.keys((tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as Record<string, unknown>);
      const onlyOnUpdate = ['monitorID', 'parentID', 'parent_id'];

      expect(props('updateMonitor').filter((p) => !onlyOnUpdate.includes(p)).sort()).toEqual(props('createMonitor').sort());
    });

    // Tool input schemas with references are rejected by several MCP clients.
    it.each(['createMonitor', 'updateMonitor'])('%s advertises no $ref, nested conditions included', async (toolName) => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      expect(JSON.stringify(tools.find((t) => t.name === toolName)!.inputSchema)).not.toContain('$ref');
    });

    it('passes nested condition groups through intact', async () => {
      const conditions = [
        { type: 'expression', andOr: 'and', variable: 'record', operator: 'contains', value: '192.0.2.' },
        {
          type: 'group',
          andOr: 'or',
          children: [
            { type: 'expression', variable: 'record', operator: 'equals', value: 'a' },
            { type: 'group', children: [{ type: 'expression', variable: 'record', operator: 'equals', value: 'b' }] },
          ],
        },
      ];

      const result = await create({ type: 'dns', hostname: 'example.com', conditions });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.conditions).toEqual(conditions);
    });

    it('suggests the accepted spelling for a camelCase or snake_case guess', async () => {
      const result = await create({ type: 'http', url: 'https://example.com', basicAuthUser: 'u', bearerToken: 't' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Did you mean 'basic_auth_user' for 'basicAuthUser', 'bearer_token' for 'bearerToken'?");
      expect(createMonitor).not.toHaveBeenCalled();
    });
  });

  describe('reading the monitor back', () => {
    // Both failed output validation, so the monitor could be created and then not read.
    it.each(['steam', 'globalping', 'ntp', 'websocket-upgrade', 'sftp', 'sip-options', 'oracledb', 'system-service', 'pm2'])(
      'getMonitor returns a %s monitor',
      async (type) => {
        existing = { id: 7, name: 'M', type, interval: 60, retryInterval: 60, maxretries: 0, resendInterval: 0 };
        const { client } = await connectServer();

        const result = await client.callTool({ name: 'getMonitor', arguments: { monitorID: 7 } });

        expect(textOf(result)).not.toContain('Output validation error');
        expect(result.isError).toBeFalsy();
      }
    );

    // Uptime Kuma's floor is 1 second (MIN_INTERVAL_SECOND); the read schema used to demand 20.
    it('getMonitor returns a monitor checked every second', async () => {
      existing = { id: 7, name: 'M', type: 'http', url: 'https://example.com', interval: 1, retryInterval: 1 };
      const { client } = await connectServer();

      const result = await client.callTool({ name: 'getMonitor', arguments: { monitorID: 7 } });

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result)).interval).toBe(1);
    });

    it('accepts a 1 second interval on write and refuses anything shorter', async () => {
      expect((await create({ type: 'http', url: 'https://example.com', interval: 1, retryInterval: 1 })).isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ interval: 1, retryInterval: 1 });

      for (const field of ['interval', 'retryInterval']) {
        const result = await create({ type: 'http', url: 'https://example.com', [field]: 0 });
        expect(result.isError, field).toBe(true);
        expect(textOf(result)).toContain(field);
      }
      expect((await update({ interval: 0.5 })).isError).toBe(true);
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('getMonitor returns a monitor with a condition set', async () => {
      existing = {
        id: 7,
        name: 'M',
        type: 'dns',
        interval: 60,
        retryInterval: 60,
        conditions: [
          { type: 'expression', andOr: 'and', variable: 'record', operator: 'contains', value: '192.0.2.' },
          { type: 'group', andOr: 'or', children: [{ type: 'expression', variable: 'record', operator: 'equals', value: 'x' }] },
        ],
      };
      const { client } = await connectServer();

      const result = await client.callTool({
        name: 'getMonitor',
        arguments: { monitorID: 7, includeTypeSpecificFields: true },
      });

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result)).conditions).toHaveLength(2);
    });
  });

  describe('HTTP authentication', () => {
    it('stores basic auth credentials and sets authMethod to match', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        basic_auth_user: 'probe',
        basic_auth_pass: 'hunter2',
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ authMethod: 'basic', basic_auth_user: 'probe', basic_auth_pass: 'hunter2' });
      expect((result.structuredContent as Record<string, unknown>).authMethod).toBe('basic');
      expect(textOf(result)).toContain("Set authMethod to 'basic'");
      // The password is the caller's own input, but it has no business in the reply.
      expect(textOf(result)).not.toContain('hunter2');
    });

    it('infers bearer from a token, ntlm from a domain, oauth2-cc and mtls from theirs', async () => {
      await create({ type: 'http', url: 'https://example.com', bearer_token: 'tok' });
      expect(lastWrite.authMethod).toBe('bearer');

      await create({ type: 'keyword', url: 'https://example.com', keyword: 'ok', basic_auth_user: 'u', basic_auth_pass: 'p', authDomain: 'CORP' });
      expect(lastWrite.authMethod).toBe('ntlm');

      await create({
        type: 'http',
        url: 'https://example.com',
        oauth_token_url: 'https://idp.internal/token',
        oauth_client_id: 'id',
        oauth_client_secret: 'secret',
      });
      expect(lastWrite.authMethod).toBe('oauth2-cc');

      await create({ type: 'http', url: 'https://example.com', tlsCert: 'CERT', tlsKey: 'KEY' });
      expect(lastWrite.authMethod).toBe('mtls');
    });

    it('does not report an authMethod the caller chose themselves', async () => {
      const result = await create({ type: 'http', url: 'https://example.com', authMethod: 'bearer', bearer_token: 'tok' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.authMethod).toBe('bearer');
      expect(result.structuredContent as Record<string, unknown>).not.toHaveProperty('authMethod');
    });

    it('refuses credentials of two methods without an authMethod to choose between them', async () => {
      const result = await create({ type: 'http', url: 'https://example.com', basic_auth_user: 'u', bearer_token: 'tok' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('different authentication methods (basic, bearer)');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses an authMethod whose credentials are missing', async () => {
      const result = await create({ type: 'http', url: 'https://example.com', authMethod: 'bearer' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("authMethod 'bearer' needs bearer_token");
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses credentials the chosen authMethod would never send', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        authMethod: 'basic',
        basic_auth_user: 'u',
        bearer_token: 'tok',
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("authMethod is 'basic', which does not send bearer_token");
    });

    it('sets authMethod when a credential is added to an existing monitor', async () => {
      const result = await update({ bearer_token: 'tok' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ type: 'http', url: 'https://api.internal/health', authMethod: 'bearer', bearer_token: 'tok' });
      expect(textOf(result)).toContain("Set authMethod to 'bearer'");
    });

    it('refuses a credential the stored authMethod would never send', async () => {
      existing = { ...existing, authMethod: 'basic', basic_auth_user: 'u', basic_auth_pass: 'p' };

      const result = await update({ bearer_token: 'tok' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("authMethod is 'basic', which does not send bearer_token");
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('switches method when authMethod is passed with the new credentials', async () => {
      existing = { ...existing, authMethod: 'basic', basic_auth_user: 'u', basic_auth_pass: 'p' };

      const result = await update({ authMethod: 'bearer', bearer_token: 'tok' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ authMethod: 'bearer', bearer_token: 'tok' });
    });

    it('turns authentication off with authMethod null', async () => {
      existing = { ...existing, authMethod: 'basic', basic_auth_user: 'u', basic_auth_pass: 'p' };

      const result = await update({ authMethod: null });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.authMethod).toBeNull();
    });

    it('leaves an unrelated edit alone on a monitor holding another method\'s leftovers', async () => {
      // What the web form leaves behind when it switches from bearer to basic.
      existing = { ...existing, authMethod: 'basic', basic_auth_user: 'u', basic_auth_pass: 'p', bearer_token: 'old' };

      expect((await update({ name: 'Renamed' })).isError).toBeFalsy();
      // Echoed back from a redacted read: restored to the stored value, so not a change.
      expect((await update({ name: 'Renamed', bearer_token: SECRET_MARKER })).isError).toBeFalsy();
      expect(lastWrite.bearer_token).toBe('old');
    });

    it('takes basic_auth_user on an oracledb monitor as its login, with no authMethod', async () => {
      const result = await create({
        type: 'oracledb',
        databaseConnectionString: 'db.internal:1521/XEPDB1',
        basic_auth_user: 'system',
        basic_auth_pass: 'oracle',
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ basic_auth_user: 'system', basic_auth_pass: 'oracle' });
      expect(lastWrite).not.toHaveProperty('authMethod');
    });
  });

  describe('required fields', () => {
    it.each(Object.entries(MINIMAL))('creates a %s monitor from its required fields', async (type, fields) => {
      const result = await create({ type, ...fields });

      expect(textOf(result)).not.toContain('needs');
      expect(result.isError).toBeFalsy();
      expect(lastWrite.type).toBe(type);
    });

    it.each(Object.entries(MINIMAL))('refuses a %s monitor missing any one of them', async (type, fields) => {
      for (const omitted of Object.keys(fields)) {
        const { [omitted]: _dropped, ...rest } = fields;
        const result = await create({ type, ...rest });

        expect(result.isError, `${type} without ${omitted}`).toBe(true);
        expect(textOf(result)).toContain(`A ${type} monitor needs`);
        expect(textOf(result)).toContain(omitted);
      }
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses a type change that leaves the new type unconfigured', async () => {
      const result = await update({ type: 'mqtt', hostname: 'mqtt://broker.internal' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('A mqtt monitor needs port, mqttTopic');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('treats an empty broker or node list as missing', async () => {
      expect(textOf(await create({ type: 'rabbitmq', rabbitmqNodes: [] }))).toContain('A rabbitmq monitor needs rabbitmqNodes');
      expect(
        textOf(await create({ type: 'kafka-producer', kafkaProducerBrokers: [], kafkaProducerTopic: 't', kafkaProducerMessage: 'm' }))
      ).toContain('A kafka-producer monitor needs kafkaProducerBrokers');
    });

    it('needs a private key for an sftp monitor that logs in with one', async () => {
      const base = { type: 'sftp', hostname: 'sftp.internal', sshUsername: 'probe', sshAuthMethod: 'privateKey' };

      expect(textOf(await create({ ...base, sshPassword: 'pw' }))).toContain('A sftp monitor needs sshPrivateKey');
      expect((await create({ ...base, sshPrivateKey: 'KEY' })).isError).toBeFalsy();
    });

    it('needs a url rather than a hostname for a globalping http measurement', async () => {
      expect(textOf(await create({ type: 'globalping', subtype: 'http', hostname: 'example.com' }))).toContain(
        'A globalping monitor needs url'
      );
      expect((await create({ type: 'globalping', subtype: 'http', url: 'https://example.com' })).isError).toBeFalsy();
    });

    it('refuses an http:// url for a websocket-upgrade monitor', async () => {
      const result = await create({ type: 'websocket-upgrade', url: 'https://ws.internal/socket' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('ws:// or wss://');
    });

    it('refuses a rabbitmq node that is not an http(s) URL', async () => {
      const result = await create({ type: 'rabbitmq', rabbitmqNodes: ['amqp://rabbit.internal:5672'] });

      expect(result.isError).toBe(true);
      expect(createMonitor).not.toHaveBeenCalled();
    });
  });

  describe('defaults Uptime Kuma only applies in its web form', () => {
    it('gives a kafka-producer monitor SASL options, which its check dereferences', async () => {
      await create({ type: 'kafka-producer', ...MINIMAL['kafka-producer'] });

      expect(lastWrite.kafkaProducerSaslOptions).toEqual({ mechanism: 'None' });
    });

    it('keeps SASL options the caller passed', async () => {
      const sasl = { mechanism: 'scram-sha-256', username: 'probe', password: 'pw' };
      await create({ type: 'kafka-producer', ...MINIMAL['kafka-producer'], kafkaProducerSaslOptions: sasl });

      expect(lastWrite.kafkaProducerSaslOptions).toEqual(sasl);
    });

    it('swaps the HTTP status range for close code 1000 on a websocket-upgrade monitor', async () => {
      await create({ type: 'websocket-upgrade', url: 'wss://ws.internal/socket' });
      expect(lastWrite.accepted_statuscodes).toEqual(['1000']);

      await create({ type: 'websocket-upgrade', url: 'wss://ws.internal/socket', accepted_statuscodes: ['1000', '1001'] });
      expect(lastWrite.accepted_statuscodes).toEqual(['1000', '1001']);

      // An http monitor converted in place still holds the HTTP default.
      await update({ type: 'websocket-upgrade', url: 'wss://ws.internal/socket' });
      expect(lastWrite.accepted_statuscodes).toEqual(['1000']);
    });

    it('fills in the snmp comparison and stores the community string as radiusPassword', async () => {
      await create({ type: 'snmp', ...MINIMAL.snmp });

      expect(lastWrite).toMatchObject({
        snmpVersion: '2c',
        jsonPath: '$',
        jsonPathOperator: '==',
        expectedValue: '1',
        radiusPassword: 'public',
      });
      expect(lastWrite).not.toHaveProperty('snmpCommunity');
    });

    it('defaults a globalping monitor to a ping from anywhere', async () => {
      await create({ type: 'globalping', hostname: 'example.com' });

      expect(lastWrite).toMatchObject({ subtype: 'ping', location: 'world' });
    });
  });

  describe('aliases', () => {
    it('folds the snake_case column names onto the names editMonitor reads', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        auth_method: 'bearer',
        bearer_token: 'tok',
        proxy_id: '3',
        save_response: true,
        save_error_response: false,
        response_max_length: 2048,
        retry_only_on_status_code_failure: true,
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({
        authMethod: 'bearer',
        proxyId: 3,
        saveResponse: true,
        saveErrorResponse: false,
        responseMaxLength: 2048,
        retryOnlyOnStatusCodeFailure: true,
      });
      for (const alias of ['auth_method', 'proxy_id', 'save_response', 'save_error_response', 'response_max_length']) {
        expect(lastWrite).not.toHaveProperty(alias);
      }
    });

    it('refuses an alias that disagrees with the field it stands for', async () => {
      const result = await create({ type: 'http', url: 'https://example.com', saveResponse: true, save_response: false });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Conflicting values for saveResponse');
    });
  });

  describe('credentials', () => {
    const SECRETS = {
      basic_auth_pass: 'a',
      bearer_token: 'b',
      oauth_client_secret: 'c',
      tlsCert: 'd',
      tlsKey: 'e',
      tlsCa: 'f',
      mqttPassword: 'g',
      grpcMetadata: '{"authorization":"h"}',
      radiusSecret: 'i',
      radiusPassword: 'j',
      rabbitmqPassword: 'k',
      gamedigToken: 'l',
      sshPassword: 'm',
      sshPrivateKey: 'n',
      sshPassphrase: 'o',
    };

    it('redacts every credential these fields can hold on read', () => {
      const redacted = redactSecrets({
        ...SECRETS,
        kafkaProducerSaslOptions: { mechanism: 'aws', accessKeyId: 'AKIA', secretAccessKey: 'p', sessionToken: 'q', password: 'r' },
        rabbitmqNodes: ['https://user:pw@rabbit.internal:15672'],
      }) as Record<string, unknown>;

      for (const field of Object.keys(SECRETS)) expect(redacted[field], field).toBe(SECRET_MARKER);
      expect(redacted.kafkaProducerSaslOptions).toEqual({
        mechanism: 'aws',
        accessKeyId: 'AKIA',
        secretAccessKey: SECRET_MARKER,
        sessionToken: SECRET_MARKER,
        password: SECRET_MARKER,
      });
      expect(redacted.rabbitmqNodes).toEqual(['https://***:***@rabbit.internal:15672']);
    });

    it('refuses the redaction marker on create', async () => {
      const result = await create({ type: 'http', url: 'https://example.com', basic_auth_user: 'u', basic_auth_pass: SECRET_MARKER });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('redaction marker');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('keeps the stored value when a credential is sent back as the marker', async () => {
      existing = { ...existing, authMethod: 'basic', basic_auth_user: 'u', basic_auth_pass: 'stored-pw' };

      const result = await update({ basic_auth_user: 'u2', basic_auth_pass: SECRET_MARKER });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ basic_auth_user: 'u2', basic_auth_pass: 'stored-pw' });
      expect(textOf(result)).toContain('Kept the existing value for basic_auth_pass');
      expect(textOf(result)).not.toContain('stored-pw');
    });

    it('keeps a stored SASL password inside kafkaProducerSaslOptions', async () => {
      existing = {
        id: 7,
        name: 'Kafka',
        type: 'kafka-producer',
        interval: 60,
        retryInterval: 60,
        accepted_statuscodes: ['200-299'],
        ...MINIMAL['kafka-producer'],
        kafkaProducerSaslOptions: { mechanism: 'plain', username: 'probe', password: 'stored-pw' },
      };

      const result = await update({
        kafkaProducerSaslOptions: { mechanism: 'scram-sha-256', username: 'probe', password: SECRET_MARKER },
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.kafkaProducerSaslOptions).toEqual({ mechanism: 'scram-sha-256', username: 'probe', password: 'stored-pw' });
    });

    describe('inline in rabbitmqNodes', () => {
      beforeEach(() => {
        existing = {
          id: 7,
          name: 'Rabbit',
          type: 'rabbitmq',
          interval: 60,
          retryInterval: 60,
          accepted_statuscodes: ['200-299'],
          rabbitmqNodes: ['https://admin:pw-one@rabbit1.internal:15672', 'https://admin:pw-two@rabbit2.internal:15672'],
        };
      });

      it('restores each node\'s own credentials, whatever order they come back in', async () => {
        const result = await update({
          rabbitmqNodes: [
            'https://***:***@rabbit2.internal:15672',
            'https://***:***@rabbit1.internal:15672',
            'https://rabbit3.internal:15672',
          ],
        });

        expect(result.isError).toBeFalsy();
        expect(lastWrite.rabbitmqNodes).toEqual([
          'https://admin:pw-two@rabbit2.internal:15672/',
          'https://admin:pw-one@rabbit1.internal:15672/',
          'https://rabbit3.internal:15672',
        ]);
      });

      it('refuses a marker on a node that has nothing stored', async () => {
        const result = await update({ rabbitmqNodes: ['https://***:***@rabbit9.internal:15672'] });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('redaction marker');
        expect(textOf(result)).not.toContain('pw-one');
        expect(updateMonitor).not.toHaveBeenCalled();
      });

      it('refuses a marker on create', async () => {
        const result = await create({ type: 'rabbitmq', rabbitmqNodes: ['https://***:***@rabbit1.internal:15672'] });

        expect(result.isError).toBe(true);
        expect(createMonitor).not.toHaveBeenCalled();
      });
    });
  });

  describe('read-back verification', () => {
    it('reports a credential that did not persist without printing it', async () => {
      fetchMonitor.mockImplementation((async () => ({ ...lastWrite, bearer_token: null })) as never);

      const result = await create({ type: 'http', url: 'https://example.com', bearer_token: 'super-secret-token' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('bearer_token: sent a 18-character value, server reports nothing stored');
      expect(textOf(result)).not.toContain('super-secret-token');
      // The monitor exists, so the caller still needs its ID.
      expect((result.structuredContent as Record<string, unknown>).monitorID).toBe(7);
    });

    it('reports an inferred authMethod that did not persist', async () => {
      fetchMonitor.mockImplementation((async () => ({ ...lastWrite, authMethod: null })) as never);

      const result = await update({ bearer_token: 'tok' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('authMethod: asked for "bearer", server reports null');
    });

    it('reports a broker list that did not persist', async () => {
      fetchMonitor.mockImplementation((async () => ({ ...lastWrite, kafkaProducerBrokers: null })) as never);

      const result = await create({ type: 'kafka-producer', ...MINIMAL['kafka-producer'] });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('kafkaProducerBrokers: asked for "[\\"kafka.internal:9092\\"]", server reports null');
    });

    it('accepts the trimmed service name Uptime Kuma stores', async () => {
      fetchMonitor.mockImplementation((async () => ({ ...lastWrite, system_service_name: 'nginx' })) as never);

      const result = await create({ type: 'system-service', system_service_name: ' nginx ' });

      expect(result.isError).toBeFalsy();
    });
  });
});
