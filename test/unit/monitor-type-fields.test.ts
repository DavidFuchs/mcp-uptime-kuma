import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, MONITOR_TYPE_FIELD_NAMES, READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/server.js';
import { UptimeKumaClient } from '../../src/uptime-kuma-client.js';
import { redactSecrets, SECRET_MARKER } from '../../src/redact.js';

/**
 * Issue #112: createMonitor and updateMonitor declared the fields of only a handful of monitor
 * types. For the rest, the fields the check depends on were rejected as unknown, so the monitor
 * could be created but not configured, and then failed every check.
 */

/**
 * Every field Uptime Kuma 2.5.10's `editMonitor` handler reads off the payload
 * (server/server.js, the `bean.x = monitor.y` block), by the name it READS — `saveResponse`,
 * not the `save_response` it assigns to. A field missing from the write tools is one a caller
 * cannot set, which is the whole of #112.
 *
 * `id` and `accepted_statuscodes_json` are excluded: the first is `monitorID` here and the
 * second is derived from `accepted_statuscodes`.
 */
const FIELDS_EDIT_MONITOR_READS = [
  'name',
  'description',
  'parent',
  'type',
  'subtype',
  'url',
  'wsIgnoreSecWebsocketAcceptHeader',
  'wsSubprotocol',
  'method',
  'body',
  'ipFamily',
  'headers',
  'basic_auth_user',
  'basic_auth_pass',
  'bearer_token',
  'timeout',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_auth_method',
  'oauth_token_url',
  'oauth_scopes',
  'oauth_audience',
  'tlsCa',
  'tlsCert',
  'tlsKey',
  'interval',
  'retryInterval',
  'resendInterval',
  'hostname',
  'game',
  'maxretries',
  'port',
  'location',
  'protocol',
  'keyword',
  'invertKeyword',
  'ignoreTls',
  'expiryNotification',
  'domainExpiryNotification',
  'upsideDown',
  'packetSize',
  'maxredirects',
  'accepted_statuscodes',
  'saveResponse',
  'saveErrorResponse',
  'responseMaxLength',
  'dns_resolve_type',
  'dns_resolve_server',
  'pushToken',
  'docker_container',
  'docker_host',
  'proxyId',
  'mqttUsername',
  'mqttPassword',
  'mqttTopic',
  'mqttSuccessMessage',
  'mqttCheckType',
  'mqttWebsocketPath',
  'databaseConnectionString',
  'databaseQuery',
  'authMethod',
  'authWorkstation',
  'authDomain',
  'grpcUrl',
  'grpcProtobuf',
  'grpcServiceName',
  'grpcMethod',
  'grpcBody',
  'grpcMetadata',
  'grpcEnableTls',
  'radiusUsername',
  'radiusPassword',
  'radiusCalledStationId',
  'radiusCallingStationId',
  'radiusSecret',
  'httpBodyEncoding',
  'expectedValue',
  'jsonPath',
  'kafkaProducerTopic',
  'kafkaProducerBrokers',
  'kafkaProducerAllowAutoTopicCreation',
  'kafkaProducerSaslOptions',
  'kafkaProducerMessage',
  'cacheBust',
  'kafkaProducerSsl',
  'gamedigGivenPortOnly',
  'gamedigToken',
  'remote_browser',
  'screenshot_delay',
  'smtpSecurity',
  'snmpVersion',
  'snmpOid',
  'jsonPathOperator',
  'retryOnlyOnStatusCodeFailure',
  'rabbitmqNodes',
  'rabbitmqUsername',
  'rabbitmqPassword',
  'conditions',
  'manual_status',
  'system_service_name',
  'sshUsername',
  'sshPassword',
  'sftpPath',
  'sshPrivateKey',
  'sshPassphrase',
  'sshAuthMethod',
  'ntpStratumThreshold',
  'ntpTimeOffsetThreshold',
  'ntpRootDispersionThreshold',
  'ping_numeric',
  'ping_count',
  'ping_per_request_timeout',
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
  radius: {
    hostname: 'radius.internal',
    radiusUsername: 'probe',
    radiusPassword: 'pw',
    radiusSecret: 'shared',
    radiusCalledStationId: 'AA-BB-CC-DD-EE-FF:corp',
    radiusCallingStationId: '11-22-33-44-55-66',
  },
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

/**
 * Moves the type-specific fields of a flat argument list into `typeFields`, where the write
 * tools take them. The tests below are written flat, the way Uptime Kuma's payload and
 * getMonitor's output are; a test that cares where a field is passed builds `typeFields` itself.
 */
function nest(args: Record<string, unknown>): Record<string, unknown> {
  if ('typeFields' in args) return args;
  const out: Record<string, unknown> = {};
  const typeFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    (MONITOR_TYPE_FIELD_NAMES.includes(key) ? typeFields : out)[key] = value;
  }
  return Object.keys(typeFields).length > 0 ? { ...out, typeFields } : out;
}

async function connectServer(readOnly = false) {
  const { server } = await createServer({
    readOnly,
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
    return client.callTool({ name: 'createMonitor', arguments: nest({ name: 'M', ...args }) });
  };
  const update = async (args: Record<string, unknown>) => {
    const { client } = await connectServer();
    return client.callTool({ name: 'updateMonitor', arguments: nest({ monitorID: 7, ...args }) });
  };

  describe('schema coverage', () => {
    it.each(['createMonitor', 'updateMonitor'])(
      '%s accepts every field editMonitor reads, at the top level or in typeFields',
      async (toolName) => {
        const { client } = await connectServer();
        const { tools } = await client.listTools();
        const properties = Object.keys(
          (tools.find((t) => t.name === toolName)!.inputSchema.properties ?? {}) as Record<string, unknown>
        );

        expect(properties).toContain('typeFields');
        expect(
          FIELDS_EDIT_MONITOR_READS.filter((f) => !properties.includes(f) && !MONITOR_TYPE_FIELD_NAMES.includes(f))
        ).toEqual([]);
        // One place each: a field accepted in both would have two values to disagree.
        expect(properties.filter((p) => MONITOR_TYPE_FIELD_NAMES.includes(p))).toEqual([]);
      }
    );

    it('declares the same fields on both tools', async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      const props = (name: string) =>
        Object.keys((tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as Record<string, unknown>);
      const onlyOnUpdate = ['monitorID'];

      expect(
        props('updateMonitor')
          .filter((p) => !onlyOnUpdate.includes(p))
          .sort()
      ).toEqual(props('createMonitor').sort());
    });

    it('stores a typeFields field in the flat payload Uptime Kuma takes', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        typeFields: { cacheBust: true, proxyId: '3' },
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite).toMatchObject({ url: 'https://example.com', cacheBust: true, proxyId: 3 });
      expect(lastWrite).not.toHaveProperty('typeFields');
    });

    it('says a type-specific field passed at the top level belongs in typeFields', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        typeFields: undefined,
        bearer_token: 't',
        basicAuthUser: 'u',
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        `'bearer_token', 'basicAuthUser' are type-specific fields and go inside typeFields: {"typeFields": {"bearer_token": …, "basic_auth_user": …}}`
      );
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses an unknown name inside typeFields, and suggests the accepted spelling', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        typeFields: { bearerToken: 't', nonsense: 1 },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("'bearerToken' is not a field — did you mean 'bearer_token'?");
      expect(textOf(result)).toContain("'nonsense' is not a field of any monitor type");
      expect(textOf(result)).toContain('getMonitorTypeFields');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('says a top-level field passed inside typeFields belongs beside it', async () => {
      const result = await create({ type: 'http', typeFields: { url: 'https://example.com' } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("'url' is a top-level field — pass it beside typeFields, not inside it");
    });

    it('validates the values inside typeFields', async () => {
      const result = await create({
        type: 'ping',
        hostname: 'example.com',
        typeFields: { ping_count: 500, authMethod: 'digest' },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('typeFields.ping_count');
      expect(textOf(result)).toContain('typeFields.authMethod');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('keeps stored type-specific fields when updateMonitor is given none', async () => {
      existing = { ...existing, authMethod: 'bearer', bearer_token: 'stored' };

      await update({ name: 'Renamed' });

      expect(lastWrite).toMatchObject({ name: 'Renamed', authMethod: 'bearer', bearer_token: 'stored' });
    });

    // Tool input schemas with references are rejected by several MCP clients.
    it.each(['createMonitor', 'updateMonitor'])(
      '%s advertises no $ref, nested conditions included',
      async (toolName) => {
        const { client } = await connectServer();
        const { tools } = await client.listTools();

        expect(JSON.stringify(tools.find((t) => t.name === toolName)!.inputSchema)).not.toContain('$ref');
      }
    );

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
  });

  describe('getMonitorTypeFields', () => {
    type FieldDoc = { name: string; in: string; description: string; accepts: Record<string, unknown> };
    type TypeFields = {
      type: string;
      required: FieldDoc[];
      optional: FieldDoc[];
      notes: string[];
      commonFields: string[];
    };

    const connect = async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      const properties = (name: string) =>
        (tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      const types = (
        (await client.callTool({ name: 'listMonitorTypes', arguments: {} })).structuredContent as {
          types: Array<{ type: string }>;
        }
      ).types.map((t) => t.type);
      const describe = async (type: string) =>
        (await client.callTool({ name: 'getMonitorTypeFields', arguments: { type } })).structuredContent as TypeFields;
      return { client, tools, properties, types, describe };
    };

    it('answers for every type listMonitorTypes offers, with fields createMonitor accepts', async () => {
      const { properties, types, describe } = await connect();
      const accepted = Object.keys(properties('createMonitor'));

      for (const type of types) {
        const fields = await describe(type);
        expect(fields.type).toBe(type);
        for (const field of [...fields.required, ...fields.optional]) {
          // Each field is passed in exactly the place the tool says it is.
          expect(field.in, `${type}.${field.name}`).toBe(
            MONITOR_TYPE_FIELD_NAMES.includes(field.name) ? 'typeFields' : 'top-level'
          );
          if (field.in === 'top-level') expect(accepted, `${type}.${field.name}`).toContain(field.name);
          expect(field.description, `${type}.${field.name}`).not.toBe('');
          expect(Object.keys(field.accepts).length, `${type}.${field.name}`).toBeGreaterThan(0);
        }
        for (const field of fields.commonFields) expect(accepted).toContain(field);
      }
    });

    // The refusal and the documentation come from one table; this is what holds them together.
    it.each(Object.entries(MINIMAL))(
      'lists as required for %s exactly what a create is refused without',
      async (type, fields) => {
        const { describe } = await connect();
        const required = (await describe(type)).required.map((f) => f.name);

        // globalping has none that hold for every subtype; its requirement is in the notes.
        for (const field of required) expect(Object.keys(fields), `${type} required ${field}`).toContain(field);
        // Whatever MINIMAL passes beyond that is a conditional requirement, and must be in the notes.
        const conditional = Object.keys(fields).filter((f) => !required.includes(f));
        const notes = (await describe(type)).notes.join(' ');
        for (const field of conditional) expect(notes, `${type} note about ${field}`).toContain(field);
      }
    );

    it('explains every type-specific field under at least one type', async () => {
      const { properties, types, describe } = await connect();
      const described = new Set<string>();
      for (const type of types) {
        const fields = await describe(type);
        for (const field of [
          ...fields.required,
          ...fields.optional,
          ...fields.commonFields.map((name) => ({ name })),
        ]) {
          described.add(field.name);
        }
      }
      // Fields that exist for one tool's bookkeeping or as another spelling of a described field.
      const notPerType = ['type', 'typeFields', 'monitorID'];
      const undescribed = [
        ...Object.entries(properties('updateMonitor'))
          .filter(([name, schema]) => !notPerType.includes(name) && !/^Alias for /.test(schema.description ?? ''))
          .map(([name]) => name),
        ...MONITOR_TYPE_FIELD_NAMES,
      ].filter((name) => !described.has(name));

      expect(undescribed).toEqual([]);
    });

    it('gives the allowed values and the auth requirements of an HTTP monitor', async () => {
      const { describe } = await connect();
      const http = await describe('http');

      expect(http.required.map((f) => f.name)).toEqual(['url']);
      expect(JSON.stringify(http.optional.find((f) => f.name === 'authMethod')!.accepts)).toContain('"oauth2-cc"');
      expect(http.notes.join(' ')).toContain('"bearer" requires bearer_token');
      // globalping cannot do ntlm or mtls, so it must not be told it can.
      expect((await describe('globalping')).notes.join(' ')).not.toContain('mtls');
    });

    it('says what the caller should pass for the snmp community, not where it is stored', async () => {
      const { describe } = await connect();

      expect((await describe('snmp')).required.map((f) => f.name)).toEqual([
        'hostname',
        'snmpOid',
        'snmpCommunity',
        'expectedValue',
      ]);
    });

    // Uptime Kuma 2.5.10, src/util.ts TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD: the types whose
    // domain DomainExpiry.checkSupport() can read. Every other type refuses domain expiry.
    const DOMAIN_EXPIRY_TYPES = [
      'http',
      'keyword',
      'json-query',
      'real-browser',
      'websocket-upgrade',
      'port',
      'ping',
      'grpc-keyword',
      'dns',
      'smtp',
      'snmp',
      'gamedig',
      'steam',
      'mqtt',
      'radius',
      'tailscale-ping',
      'sip-options',
    ];
    // The certificate check runs from handleTlsInfo() in the http/keyword/json-query branch of
    // server/model/monitor.js, and from globalping.js. No other type reads expiryNotification.
    const CERT_EXPIRY_TYPES = ['http', 'keyword', 'json-query', 'globalping'];

    it.each(['domainExpiryNotification', 'expiryNotification'])(
      'lists %s for exactly the types that check it',
      async (field) => {
        const { types, describe } = await connect();
        const expected = field === 'domainExpiryNotification' ? DOMAIN_EXPIRY_TYPES : CERT_EXPIRY_TYPES;
        const listing: string[] = [];
        for (const type of types) {
          const fields = await describe(type);
          if ([...fields.required, ...fields.optional].some((f) => f.name === field)) listing.push(type);
        }

        expect(listing.sort()).toEqual([...expected].sort());
      }
    );

    // Each one read off the check in Uptime Kuma 2.5.10 (server/monitor-types/*.js and the
    // per-type branches of server/model/monitor.js).
    it.each([
      ['mongodb', ['jsonPath', 'expectedValue'], []],
      ['steam', ['packetSize'], []],
      ['docker', ['ignoreTls'], []],
      ['real-browser', [], ['accepted_statuscodes', 'ignoreTls']],
      ['port', [], ['ipFamily', 'proxyId']],
    ])('lists for %s the fields its check reads, and only those', async (type, present, absent) => {
      const { describe } = await connect();
      const fields = await describe(type);
      const names = [...fields.required, ...fields.optional].map((f) => f.name);

      for (const field of present) expect(names, `${type} lists ${field}`).toContain(field);
      for (const field of absent) expect(names, `${type} does not list ${field}`).not.toContain(field);
    });

    it('refuses an unknown type', async () => {
      const { client } = await connect();
      const result = await client.callTool({ name: 'getMonitorTypeFields', arguments: { type: 'nope' } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Unknown monitor type 'nope'");
    });

    it('names the valid types in the refusal, so a guess like "minecraft" is put right in one step', async () => {
      // Found by the LLM eval: models asked for type "minecraft" and needed another call to find gamedig.
      const { client } = await connect();
      for (const tool of ['getMonitorTypeFields', 'createMonitor']) {
        const args =
          tool === 'createMonitor'
            ? { name: 'MC', type: 'minecraft', hostname: 'mc.example.com' }
            : { type: 'minecraft' };
        const result = await client.callTool({ name: tool, arguments: args });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('gamedig');
        expect(textOf(result)).toMatch(/game server/i);
        expect(textOf(result)).toContain('mqtt');
      }
    });

    it('is where a refused create sends the caller', async () => {
      const result = await create({ type: 'mqtt', hostname: 'mqtt://broker.internal' });

      expect(textOf(result)).toContain('getMonitorTypeFields {"type": "mqtt"}');
    });
  });

  describe('context cost of the write tools', () => {
    // Tool definitions are loaded into every session. With every type-specific field declared
    // and described on both tools they were 23.7 KB and 23.0 KB, against about 7 KB each before
    // #112. Those fields now go in typeFields and are described by getMonitorTypeFields. If this
    // fails, the new field belongs in typeFields rather than the cap being raised.
    //
    // The annotations are left out of the measurement: they are the same few hints on every
    // tool, read by the client rather than added per field, so they are not what the cap guards.
    it.each([
      ['createMonitor', 8500],
      ['updateMonitor', 7500],
    ])('%s stays under %d bytes', async (toolName, cap) => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      const { annotations: _annotations, ...tool } = tools.find((t) => t.name === toolName)!;
      expect(JSON.stringify(tool).length).toBeLessThan(cap);
    });

    it('advertises no safe-integer bounds, and keeps the ones a field declares', async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      expect(JSON.stringify(tools)).not.toContain('9007199254740991');
      const properties = tools.find((t) => t.name === 'createMonitor')!.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(properties.interval).toMatchObject({ minimum: 1 });
    });
  });

  describe('read-only mode (UPTIME_KUMA_READ_ONLY)', () => {
    it('classifies every tool as read-only or not', async () => {
      const { client } = await connectServer();
      const names = (await client.listTools()).tools.map((t) => t.name);

      expect(names.filter((n) => !READ_ONLY_TOOLS.has(n) && !WRITE_TOOLS.has(n))).toEqual([]);
      expect([...READ_ONLY_TOOLS].filter((n) => WRITE_TOOLS.has(n))).toEqual([]);
      expect([...READ_ONLY_TOOLS, ...WRITE_TOOLS].filter((n) => !names.includes(n))).toEqual([]);
    });

    it('registers only the tools that report', async () => {
      const { client } = await connectServer(true);
      const names = (await client.listTools()).tools.map((t) => t.name);

      expect(names.sort()).toEqual([...READ_ONLY_TOOLS].sort());
      for (const verb of ['create', 'update', 'delete', 'add', 'pause', 'resume', 'test']) {
        expect(
          names.filter((n) => n.startsWith(verb)),
          verb
        ).toEqual([]);
      }
    });

    it('cannot be made to write by calling a tool it does not list', async () => {
      const { client } = await connectServer(true);

      const result = await client
        .callTool({ name: 'deleteMonitor', arguments: { monitorID: 7 } })
        .catch((error: Error) => ({
          isError: true,
          content: [{ text: error.message }],
        }));

      expect(result.isError).toBe(true);
      expect(createMonitor).not.toHaveBeenCalled();
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('still reads, and tells the model it has no write tools', async () => {
      const { client } = await connectServer(true);

      expect((await client.callTool({ name: 'getMonitor', arguments: { monitorID: 7 } })).isError).toBeFalsy();
      expect(client.getInstructions()).toContain('READ-ONLY');
      expect(client.getInstructions()).not.toContain('createMonitor');
    });

    it('leaves the instructions and tools alone otherwise', async () => {
      const { client } = await connectServer();

      expect(client.getInstructions()).toContain("'createMonitor' / 'updateMonitor' / 'deleteMonitor'");
      expect(client.getInstructions()).not.toContain('READ-ONLY');
    });
  });

  describe('reading the monitor back', () => {
    // Both failed output validation, so the monitor could be created and then not read.
    it.each([
      'steam',
      'globalping',
      'ntp',
      'websocket-upgrade',
      'sftp',
      'sip-options',
      'oracledb',
      'system-service',
      'pm2',
    ])('getMonitor returns a %s monitor', async (type) => {
      existing = { id: 7, name: 'M', type, interval: 60, retryInterval: 60, maxretries: 0, resendInterval: 0 };
      const { client } = await connectServer();

      const result = await client.callTool({ name: 'getMonitor', arguments: { monitorID: 7 } });

      expect(textOf(result)).not.toContain('Output validation error');
      expect(result.isError).toBeFalsy();
    });

    // Uptime Kuma's floor is 1 second (MIN_INTERVAL_SECOND); the read schema used to demand 20.
    it('getMonitor returns a monitor checked every second', async () => {
      existing = { id: 7, name: 'M', type: 'http', url: 'https://example.com', interval: 1, retryInterval: 1 };
      const { client } = await connectServer();

      const result = await client.callTool({ name: 'getMonitor', arguments: { monitorID: 7 } });

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result)).interval).toBe(1);
    });

    it('accepts a 1 second interval on write and refuses anything shorter', async () => {
      expect(
        (await create({ type: 'http', url: 'https://example.com', interval: 1, retryInterval: 1 })).isError
      ).toBeFalsy();
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
          {
            type: 'group',
            andOr: 'or',
            children: [{ type: 'expression', variable: 'record', operator: 'equals', value: 'x' }],
          },
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

      await create({
        type: 'keyword',
        url: 'https://example.com',
        keyword: 'ok',
        basic_auth_user: 'u',
        basic_auth_pass: 'p',
        authDomain: 'CORP',
      });
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

    // Uptime Kuma's oauth_auth_method column has no default, and its `authMethod =
    // "client_secret_basic"` parameter default does not apply to a stored null, which
    // openid-client 5.7 then refuses with "missing, or unsupported, token_endpoint_auth_method"
    // on every check. Only the web form, which always sends one, avoids it.
    it('stores client_secret_basic for an oauth2-cc monitor that does not say how to authenticate', async () => {
      const oauth = {
        type: 'http',
        url: 'https://example.com',
        oauth_token_url: 'https://idp.internal/token',
        oauth_client_id: 'id',
        oauth_client_secret: 'secret',
      };

      await create(oauth);
      expect(lastWrite.oauth_auth_method).toBe('client_secret_basic');

      await create({ ...oauth, oauth_auth_method: 'client_secret_post' });
      expect(lastWrite.oauth_auth_method).toBe('client_secret_post');

      existing = { ...EXISTING_HTTP_MONITOR, oauth_auth_method: null };
      await update({
        authMethod: 'oauth2-cc',
        oauth_token_url: 'https://idp.internal/token',
        oauth_client_id: 'id',
        oauth_client_secret: 'secret',
      });
      expect(lastWrite.oauth_auth_method).toBe('client_secret_basic');
    });

    it('does not report an authMethod the caller chose themselves', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        authMethod: 'bearer',
        bearer_token: 'tok',
      });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.authMethod).toBe('bearer');
      expect(result.structuredContent as Record<string, unknown>).not.toHaveProperty('authMethod');
    });

    it('refuses credentials of two methods without an authMethod to choose between them', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        basic_auth_user: 'u',
        bearer_token: 'tok',
      });

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
      expect(lastWrite).toMatchObject({
        type: 'http',
        url: 'https://api.internal/health',
        authMethod: 'bearer',
        bearer_token: 'tok',
      });
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

    it("leaves an unrelated edit alone on a monitor holding another method's leftovers", async () => {
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
      expect(textOf(await create({ type: 'rabbitmq', rabbitmqNodes: [] }))).toContain(
        'A rabbitmq monitor needs rabbitmqNodes'
      );
      expect(
        textOf(
          await create({
            type: 'kafka-producer',
            kafkaProducerBrokers: [],
            kafkaProducerTopic: 't',
            kafkaProducerMessage: 'm',
          })
        )
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

    // Uptime Kuma 2.5.10 offers different record types for the two (EditMonitor.vue
    // dnsresolvetypeOptions / globalpingdnsresolvetypeoptions): a dns monitor passes the type to
    // Node's resolver, globalping to the Globalping API. Neither list contains the other.
    it('accepts the record types globalping offers that a dns monitor does not', async () => {
      for (const recordType of ['ANY', 'DNSKEY', 'DS', 'HTTPS', 'NSEC', 'RRSIG', 'SVCB']) {
        const result = await create({
          type: 'globalping',
          subtype: 'dns',
          hostname: 'example.com',
          dns_resolve_type: recordType,
        });
        expect(result.isError, recordType).toBeFalsy();
        expect(lastWrite.dns_resolve_type).toBe(recordType);
      }
    });

    // What the web form starts a new monitor with (EditMonitor.vue monitorDefaults and its
    // "monitor.type" watcher), where Uptime Kuma's column defaults differ: interval 20,
    // retry_interval 0, and a timeout of 0 that its runtime fallback turns into ~13 hours.
    it.each([
      ['port', { hostname: 'db.internal', port: 5432 }, { interval: 60, retryInterval: 60, timeout: 48 }],
      ['ping', { hostname: 'db.internal' }, { interval: 60, retryInterval: 60, timeout: 10 }],
      ['snmp', MINIMAL.snmp, { timeout: 5 }],
      ['kafka-producer', MINIMAL['kafka-producer'], { timeout: 1 }],
      ['ntp', MINIMAL.ntp, { interval: 300, retryInterval: 300, timeout: 48 }],
    ])('gives a new %s monitor the web form defaults', async (type, fields, expected) => {
      await create({ type, ...fields });

      expect(lastWrite).toMatchObject(expected);
    });

    it('holds the default timeout to 80% of a short interval, and follows the interval with the retry interval', async () => {
      await create({ type: 'http', url: 'https://example.com', interval: 20 });
      expect(lastWrite).toMatchObject({ interval: 20, retryInterval: 20, timeout: 16 });

      await create({ type: 'http', url: 'https://example.com', interval: 300, retryInterval: 30 });
      expect(lastWrite).toMatchObject({ interval: 300, retryInterval: 30, timeout: 48 });
    });

    it('queries A records when a globalping dns measurement names no record type', async () => {
      await create({ type: 'globalping', subtype: 'dns', hostname: 'example.com' });
      expect(lastWrite.dns_resolve_type).toBe('A');

      await create({ type: 'globalping', subtype: 'ping', hostname: 'example.com' });
      expect(lastWrite).not.toHaveProperty('dns_resolve_type');
    });

    it.each([
      ['dns', 'DNSKEY'],
      ['globalping', 'CAA'],
    ])('refuses a record type a %s monitor cannot query (%s)', async (type, recordType) => {
      const result = await create({
        type,
        subtype: type === 'globalping' ? 'dns' : undefined,
        hostname: 'example.com',
        dns_resolve_type: recordType,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`cannot query ${recordType} records`);
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('refuses on update a record type the stored type cannot query', async () => {
      existing = {
        id: 7,
        name: 'D',
        type: 'dns',
        hostname: 'example.com',
        interval: 60,
        retryInterval: 60,
        timeout: 48,
      };

      const result = await update({ dns_resolve_type: 'HTTPS' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('cannot query HTTPS records');
      expect(updateMonitor).not.toHaveBeenCalled();
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

      await create({
        type: 'websocket-upgrade',
        url: 'wss://ws.internal/socket',
        accepted_statuscodes: ['1000', '1001'],
      });
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

  describe('names', () => {
    // Uptime Kuma reads one name per field. A second spelling is not accepted under it; the
    // refusal names the one that is.
    it('refuses a snake_case spelling of a camelCase field and names the accepted one', async () => {
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        typeFields: { save_response: true, auth_method: 'bearer' },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("'save_response' is not a field — did you mean 'saveResponse'?");
      expect(textOf(result)).toContain("'auth_method' is not a field — did you mean 'authMethod'?");
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it.each(['parentID', 'parent_id'])('refuses %s on updateMonitor and names parent', async (name) => {
      const result = await update({ [name]: 3 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`Did you mean 'parent' for '${name}'?`);
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('advertises no field described as an alias of another spelling', async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      for (const toolName of ['createMonitor', 'updateMonitor']) {
        const properties = tools.find((t) => t.name === toolName)!.inputSchema.properties as Record<
          string,
          { description?: string }
        >;
        expect(
          Object.entries(properties)
            .filter(([, p]) => /^Alias for /.test(p.description ?? ''))
            .map(([n]) => n)
        ).toEqual([]);
      }
    });

    // Not a spelling: Uptime Kuma keeps the SNMP community string in the radiusPassword column.
    it('refuses a community string that disagrees with radiusPassword', async () => {
      const result = await create({ type: 'snmp', ...MINIMAL.snmp, radiusPassword: 'other' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Conflicting values for radiusPassword');
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
        kafkaProducerSaslOptions: {
          mechanism: 'aws',
          accessKeyId: 'AKIA',
          secretAccessKey: 'p',
          sessionToken: 'q',
          password: 'r',
        },
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
      const result = await create({
        type: 'http',
        url: 'https://example.com',
        basic_auth_user: 'u',
        basic_auth_pass: SECRET_MARKER,
      });

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
      expect(lastWrite.kafkaProducerSaslOptions).toEqual({
        mechanism: 'scram-sha-256',
        username: 'probe',
        password: 'stored-pw',
      });
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

      it("restores each node's own credentials, whatever order they come back in", async () => {
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

  describe('credentials inline in a url', () => {
    beforeEach(() => {
      existing = { ...existing, url: 'https://probe:stored-pw@api.internal/health' };
    });

    it('restores them when a redacted url is written back', async () => {
      const result = await update({ url: 'https://***:***@api.internal/v2/health' });

      expect(result.isError).toBeFalsy();
      expect(lastWrite.url).toBe('https://probe:stored-pw@api.internal/v2/health');
      expect(textOf(result)).toContain('Kept the existing value for the credentials in url');
      expect(textOf(result)).not.toContain('stored-pw');
    });

    it.each(['https://***:***@other.internal/health', 'https://***:***@api.internal:8443/health'])(
      'does not send them to a different host or port (%s)',
      async (url) => {
        const result = await update({ url });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('belong to a different host or port');
        expect(textOf(result)).not.toContain('stored-pw');
        expect(updateMonitor).not.toHaveBeenCalled();
      }
    );

    it('refuses the marker when the stored url has no credentials', async () => {
      existing = { ...existing, url: 'https://api.internal/health' };

      const result = await update({ url: 'https://***:***@api.internal/health' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('redaction marker');
      expect(updateMonitor).not.toHaveBeenCalled();
    });

    it('refuses the marker on create', async () => {
      const result = await create({ type: 'http', url: 'https://***:***@api.internal/health' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('redaction marker');
      expect(createMonitor).not.toHaveBeenCalled();
    });

    it('leaves a url with real or no credentials alone', async () => {
      await update({ url: 'https://new:creds@other.internal/health' });
      expect(lastWrite.url).toBe('https://new:creds@other.internal/health');

      await update({ url: 'https://other.internal/health' });
      expect(lastWrite.url).toBe('https://other.internal/health');
    });
  });

  describe('updateDockerHost', () => {
    let addDockerHost: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.spyOn(UptimeKumaClient.prototype, 'getDockerHostList').mockReturnValue([
        { id: 3, name: 'remote', dockerType: 'tcp', dockerDaemon: 'http://admin:stored-pw@dockerd.internal:2375' },
      ] as never);
      addDockerHost = vi
        .spyOn(UptimeKumaClient.prototype, 'addDockerHost')
        .mockResolvedValue({ ok: true, id: 3, msg: 'Saved.' } as never);
    });

    const updateHost = async (dockerDaemon: string) => {
      const { client } = await connectServer();
      return client.callTool({ name: 'updateDockerHost', arguments: { dockerHostID: 3, dockerDaemon } });
    };

    it('restores the stored credentials onto the same host', async () => {
      const result = await updateHost('https://***:***@dockerd.internal:2375');

      expect(result.isError).toBeFalsy();
      expect(addDockerHost.mock.calls[0][0]).toMatchObject({
        dockerDaemon: 'https://admin:stored-pw@dockerd.internal:2375/',
      });
    });

    it.each(['http://***:***@elsewhere.internal:2375', 'http://***:***@dockerd.internal:2376'])(
      'does not send them to a different host or port (%s)',
      async (dockerDaemon) => {
        const result = await updateHost(dockerDaemon);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('belong to a different host or port');
        expect(textOf(result)).not.toContain('stored-pw');
        expect(addDockerHost).not.toHaveBeenCalled();
      }
    );

    it('still moves the host when real credentials are passed', async () => {
      const result = await updateHost('http://admin:new-pw@elsewhere.internal:2375');

      expect(result.isError).toBeFalsy();
      expect(addDockerHost.mock.calls[0][0]).toMatchObject({
        dockerDaemon: 'http://admin:new-pw@elsewhere.internal:2375',
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
      expect(textOf(result)).toContain(
        'kafkaProducerBrokers: asked for "[\\"kafka.internal:9092\\"]", server reports null'
      );
    });

    it('accepts the trimmed service name Uptime Kuma stores', async () => {
      fetchMonitor.mockImplementation((async () => ({ ...lastWrite, system_service_name: 'nginx' })) as never);

      const result = await create({ type: 'system-service', system_service_name: ' nginx ' });

      expect(result.isError).toBeFalsy();
    });
  });
});
