import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractID, extractText } from './helpers.js';

/**
 * Integration tests for the type-specific monitor fields (issue #112).
 *
 * The unit tests prove the fields reach the socket call. These prove what only a live server
 * can: that Uptime Kuma STORES each one under the name it was sent as, and that the read-back
 * verification agrees with what was stored instead of raising a false alarm.
 *
 * Every monitor is created paused, so nothing here makes Uptime Kuma probe anything, and is
 * deleted in a finally block.
 */

const MARKER = '***';

async function call(client: any, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function readMonitor(client: any, monitorID: number, includeSecrets = true): Promise<Record<string, any>> {
  const result = await call(client, 'getMonitor', { monitorID, includeTypeSpecificFields: true, includeSecrets });
  return JSON.parse(extractText(result, 'getMonitor'));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Per type: the fields to create it with, and what a read must then report. `stored` defaults
 * to the fields themselves; it is spelled out where Uptime Kuma stores a value under another
 * name or this server fills in a default.
 */
const TYPES: Array<{ type: string; fields: Record<string, unknown>; stored?: Record<string, unknown> }> = [
  {
    type: 'mqtt',
    fields: {
      hostname: 'mqtt://broker.invalid',
      port: 1883,
      mqttTopic: 'zz/integration/#',
      mqttUsername: 'zz-user',
      mqttPassword: 'zz-mqtt-secret',
      mqttCheckType: 'keyword',
      mqttSuccessMessage: 'ok',
    },
  },
  {
    type: 'grpc-keyword',
    fields: {
      grpcUrl: 'grpc.invalid:50051',
      grpcProtobuf: 'syntax = "proto3"; message Req {} message Res {} service Health { rpc Check (Req) returns (Res); }',
      grpcServiceName: 'Health',
      grpcMethod: 'Check',
      grpcBody: '{}',
      grpcMetadata: '{"authorization":"zz-grpc-secret"}',
      grpcEnableTls: true,
      keyword: 'SERVING',
    },
  },
  {
    type: 'kafka-producer',
    fields: {
      kafkaProducerBrokers: ['kafka.invalid:9092'],
      kafkaProducerTopic: 'zz-uptime',
      kafkaProducerMessage: 'ping',
      kafkaProducerSsl: true,
    },
    stored: {
      kafkaProducerBrokers: ['kafka.invalid:9092'],
      kafkaProducerTopic: 'zz-uptime',
      kafkaProducerMessage: 'ping',
      kafkaProducerSsl: true,
      // Filled in by this server: the check dereferences it.
      kafkaProducerSaslOptions: { mechanism: 'None' },
    },
  },
  {
    type: 'radius',
    fields: {
      hostname: 'radius.invalid',
      radiusUsername: 'zz-user',
      radiusPassword: 'zz-radius-pw',
      radiusSecret: 'zz-radius-secret',
      radiusCalledStationId: 'called',
      radiusCallingStationId: 'calling',
    },
  },
  {
    type: 'rabbitmq',
    fields: {
      rabbitmqNodes: ['https://rabbit1.invalid:15672', 'https://rabbit2.invalid:15672'],
      rabbitmqUsername: 'zz-user',
      rabbitmqPassword: 'zz-rabbit-secret',
    },
  },
  { type: 'smtp', fields: { hostname: 'mail.invalid', port: 587, smtpSecurity: 'starttls' } },
  {
    type: 'snmp',
    fields: { hostname: 'switch.invalid', snmpOid: '1.3.6.1.2.1.1.3.0', snmpCommunity: 'zz-community', expectedValue: '1' },
    stored: {
      hostname: 'switch.invalid',
      snmpOid: '1.3.6.1.2.1.1.3.0',
      radiusPassword: 'zz-community',
      expectedValue: '1',
      snmpVersion: '2c',
      jsonPath: '$',
      jsonPathOperator: '==',
    },
  },
  {
    type: 'gamedig',
    fields: { hostname: 'game.invalid', port: 25565, game: 'minecraft', gamedigGivenPortOnly: false, gamedigToken: 'zz-game-token' },
  },
  { type: 'steam', fields: { hostname: 'steam.invalid', port: 27015 } },
  { type: 'real-browser', fields: { url: 'https://example.invalid', screenshot_delay: 500 } },
  {
    type: 'websocket-upgrade',
    fields: { url: 'wss://ws.invalid/socket', wsSubprotocol: 'chat', wsIgnoreSecWebsocketAcceptHeader: true },
    stored: {
      url: 'wss://ws.invalid/socket',
      wsSubprotocol: 'chat',
      wsIgnoreSecWebsocketAcceptHeader: true,
      accepted_statuscodes: ['1000'],
    },
  },
  {
    type: 'globalping',
    fields: { hostname: 'example.invalid', protocol: 'ICMP' },
    stored: { hostname: 'example.invalid', protocol: 'ICMP', subtype: 'ping', location: 'world' },
  },
  {
    type: 'sftp',
    fields: { hostname: 'sftp.invalid', sshUsername: 'zz-user', sshPassword: 'zz-ssh-secret', sftpPath: '/upload' },
    stored: { hostname: 'sftp.invalid', sshUsername: 'zz-user', sshPassword: 'zz-ssh-secret', sftpPath: '/upload', sshAuthMethod: 'password' },
  },
  {
    type: 'ntp',
    fields: { hostname: 'ntp.invalid', ntpStratumThreshold: 3, ntpTimeOffsetThreshold: 250, ntpRootDispersionThreshold: 100 },
  },
  {
    type: 'ping',
    fields: { hostname: 'ping.invalid', packetSize: 128, ping_count: 3, ping_numeric: false, ping_per_request_timeout: 4 },
  },
  { type: 'oracledb', fields: { databaseConnectionString: 'db.invalid:1521/XEPDB1', basic_auth_user: 'system', basic_auth_pass: 'zz-oracle-secret' } },
  { type: 'system-service', fields: { system_service_name: 'nginx' } },
  { type: 'manual', fields: { manual_status: 1 }, stored: {} },
  {
    type: 'dns',
    fields: {
      hostname: 'example.invalid',
      conditions: [{ type: 'expression', andOr: 'and', variable: 'record', operator: 'contains', value: '192.0.2.' }],
    },
  },
];

export const monitorTypeFieldTests: Array<{ name: string; fn: TestFn }> = [
  ...TYPES.map(({ type, fields, stored }) => ({
    name: `#112: a ${type} monitor is created with its fields and they are stored`,
    fn: (async ({ client }) => {
      const created = await call(client, 'createMonitor', {
        name: `zz-112-${type}-delete-me`,
        type,
        active: false,
        ...fields,
      });
      // extractText throws on isError, which is how a verification false alarm surfaces.
      extractText(created, 'createMonitor');
      const monitorID = extractID(created, 'createMonitor', 'monitorID');

      try {
        const monitor = await readMonitor(client, monitorID);
        for (const [field, wanted] of Object.entries(stored ?? fields)) {
          if (!same(monitor[field], wanted)) {
            throw new Error(`${field}: sent ${JSON.stringify(wanted)}, stored ${JSON.stringify(monitor[field])}`);
          }
        }

        // The merge-and-write-back path, with the same fields carried over from the stored row.
        extractText(await call(client, 'updateMonitor', { monitorID, description: 'edited' }), 'updateMonitor');
        const after = await readMonitor(client, monitorID);
        for (const [field, wanted] of Object.entries(stored ?? fields)) {
          if (!same(after[field], wanted)) {
            throw new Error(`${field} did not survive an unrelated update: ${JSON.stringify(after[field])}`);
          }
        }
        console.log(`  ✓ #112: ${type} — ${Object.keys(stored ?? fields).length} fields stored and kept`);
      } finally {
        await call(client, 'deleteMonitor', { monitorID });
      }
    }) as TestFn,
  })),
  {
    name: '#112: HTTP basic auth is stored, redacted on read, and survives a "***" round trip',
    fn: async ({ client }) => {
      const password = 'zz-integration-basic-pw';
      const created = await call(client, 'createMonitor', {
        name: 'zz-112-http-auth-delete-me',
        type: 'http',
        url: 'https://example.invalid',
        active: false,
        basic_auth_user: 'zz-user',
        basic_auth_pass: password,
        httpBodyEncoding: 'form',
        ipFamily: 'ipv4',
        cacheBust: true,
        saveResponse: true,
        saveErrorResponse: false,
        responseMaxLength: 2048,
      });
      extractText(created, 'createMonitor');
      const monitorID = extractID(created, 'createMonitor', 'monitorID');

      try {
        if ((created as any).structuredContent?.authMethod !== 'basic') {
          throw new Error('createMonitor did not report the authMethod it inferred');
        }
        const monitor = await readMonitor(client, monitorID);
        const expected = {
          authMethod: 'basic',
          basic_auth_user: 'zz-user',
          basic_auth_pass: password,
          httpBodyEncoding: 'form',
          ipFamily: 'ipv4',
          cacheBust: true,
          saveResponse: true,
          saveErrorResponse: false,
          responseMaxLength: 2048,
        };
        for (const [field, wanted] of Object.entries(expected)) {
          if (!same(monitor[field], wanted)) {
            throw new Error(`${field}: sent ${JSON.stringify(wanted)}, stored ${JSON.stringify(monitor[field])}`);
          }
        }

        const redacted = await readMonitor(client, monitorID, false);
        if (redacted.basic_auth_pass !== MARKER) throw new Error('basic_auth_pass came back in cleartext');

        // What an agent does after a redacted read: change one thing, send the rest back.
        extractText(
          await call(client, 'updateMonitor', { monitorID, basic_auth_user: 'zz-user-2', basic_auth_pass: MARKER }),
          'updateMonitor'
        );
        const after = await readMonitor(client, monitorID);
        if (after.basic_auth_user !== 'zz-user-2') throw new Error('basic_auth_user was not updated');
        if (after.basic_auth_pass !== password) throw new Error('"***" overwrote the stored basic_auth_pass');

        // Switching method stores the new one.
        extractText(
          await call(client, 'updateMonitor', { monitorID, authMethod: 'bearer', bearer_token: 'zz-integration-bearer' }),
          'updateMonitor'
        );
        const switched = await readMonitor(client, monitorID);
        if (switched.authMethod !== 'bearer' || switched.bearer_token !== 'zz-integration-bearer') {
          throw new Error(`method switch not stored: ${switched.authMethod}`);
        }
        console.log('  ✓ #112: HTTP auth stored, redacted, kept across "***", and switched');
      } finally {
        await call(client, 'deleteMonitor', { monitorID });
      }
    },
  },
  {
    name: 'credentials inline in a monitor url survive a redacted round trip, and stay on their host',
    fn: async ({ client }) => {
      const created = await call(client, 'createMonitor', {
        name: 'zz-url-creds-delete-me',
        type: 'http',
        url: 'https://zz-user:zz-url-pw@example.invalid/health',
        active: false,
      });
      const monitorID = extractID(created, 'createMonitor', 'monitorID');

      try {
        const redacted = await readMonitor(client, monitorID, false);
        if (String(redacted.url).includes('zz-url-pw')) throw new Error('the url password came back in cleartext');

        extractText(await call(client, 'updateMonitor', { monitorID, url: redacted.url }), 'updateMonitor');
        const after = await readMonitor(client, monitorID);
        if (!String(after.url).includes('zz-user:zz-url-pw@')) throw new Error(`url credentials were lost: ${redacted.url}`);

        const moved = await call(client, 'updateMonitor', { monitorID, url: 'https://***:***@elsewhere.invalid/health' });
        if (!moved.isError) throw new Error('stored credentials were restored onto a different host');
        const untouched = await readMonitor(client, monitorID);
        if (!String(untouched.url).includes('@example.invalid')) throw new Error('the refused update still changed the url');
        console.log('  ✓ url credentials kept across a redacted round trip, and refused for another host');
      } finally {
        await call(client, 'deleteMonitor', { monitorID });
      }
    },
  },
  {
    name: '#112: a type change brings the new type\'s fields with it',
    fn: async ({ client }) => {
      const created = await call(client, 'createMonitor', {
        name: 'zz-112-convert-delete-me',
        type: 'http',
        url: 'https://example.invalid',
        active: false,
      });
      const monitorID = extractID(created, 'createMonitor', 'monitorID');

      try {
        const refused = await call(client, 'updateMonitor', { monitorID, type: 'rabbitmq' });
        if (!refused.isError) throw new Error('a rabbitmq conversion without rabbitmqNodes was accepted');

        extractText(
          await call(client, 'updateMonitor', {
            monitorID,
            type: 'rabbitmq',
            rabbitmqNodes: ['https://zz-user:zz-inline-pw@rabbit.invalid:15672'],
          }),
          'updateMonitor'
        );
        const redacted = await readMonitor(client, monitorID, false);
        if (redacted.type !== 'rabbitmq') throw new Error(`type is ${redacted.type}`);
        if (JSON.stringify(redacted.rabbitmqNodes).includes('zz-inline-pw')) {
          throw new Error('a rabbitmqNodes credential came back in cleartext');
        }

        // Sending the redacted list back must restore the credentials, not store the marker.
        extractText(await call(client, 'updateMonitor', { monitorID, rabbitmqNodes: redacted.rabbitmqNodes }), 'updateMonitor');
        const after = await readMonitor(client, monitorID);
        if (!String(after.rabbitmqNodes?.[0]).includes('zz-user:zz-inline-pw@')) {
          throw new Error(`rabbitmqNodes credentials were lost: ${JSON.stringify(redacted.rabbitmqNodes)}`);
        }
        console.log('  ✓ #112: http -> rabbitmq conversion, inline node credentials kept across a redacted round trip');
      } finally {
        await call(client, 'deleteMonitor', { monitorID });
      }
    },
  },
];
