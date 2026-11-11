import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode, SetLevelRequestSchema, ListToolsRequestSchema, LoggingLevelSchema, type LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomBytes, randomInt } from 'node:crypto';
import { UptimeKumaClient } from './uptime-kuma-client.js';
import { HeartbeatSchema, MonitorBaseSchema, MonitorSummarySchema, SettingsSchema, NotificationSchema, MaintenanceSchema, StatusPageSchema, DockerHostSchema } from './types/index.js';
import type { UptimeKumaConfig } from './types/index.js';
import {
  INCLUDE_SECRETS_DESCRIPTION,
  redactHeartbeat,
  redactNotifications,
  redactSecrets,
  rehydrateSecrets,
  rehydrateUrlCredentials,
} from './redact.js';
import { VERSION } from './version.js';

/**
 * Converts a string that really is a number, and passes everything else through untouched.
 *
 * This replaces `z.coerce.number()`, which is the root cause of #65. Coercion runs `Number()`
 * over whatever arrives, unconditionally, and that costs twice:
 *
 *   - An ABSENT field becomes NaN, so the caller is told "expected number, received nan" —
 *     a type complaint about a field they never wrote, rather than "this field is missing".
 *     That is what made a misspelled `monitorId` so confusing to diagnose: the unknown key is
 *     rejected, the declared key is then absent, and the absence was reported as a bad number.
 *   - `Number(null)`, `Number('')` and `Number([])` are all 0, and `Number(true)` is 1, so
 *     junk silently became a plausible value. `getMonitor {monitorID: null}` read monitor 0,
 *     and on the write tools it was worse: `timeout: ''` stored a 0, and a stored 0 makes
 *     Uptime Kuma compute a ~13 hour timeout (see the field's own description), so the monitor
 *     can never report DOWN against a host that accepts the connection and never answers.
 *     A silently disabled monitor is the worst failure an uptime tool has.
 *
 * Dropping coercion entirely would fix both but break clients that stringify their arguments,
 * which is why it was there. So the conversion is made CONDITIONAL: only strings that parse to
 * a finite number are converted, and anything else reaches the validator unchanged, to be
 * reported as what it actually was. `''` is excluded explicitly — `Number('')` is 0, and that
 * single conversion is responsible for most of the damage above.
 */
function numericString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Wraps a number schema so it accepts numeric strings without accepting junk.
 *
 * Takes the inner schema rather than returning a chainable one, because the call sites need
 * their own constraints (`.int()`, `.positive()`, `.max(100)`) applied to the NUMBER, and those
 * cannot be chained onto the effect wrapper this returns. `.optional()` and `.nullable()` are
 * chained on the outside as usual, and still short-circuit before the conversion runs — so a
 * field declared `.nullable()` keeps accepting null.
 */
function numeric<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(numericString, schema);
}

/**
 * A required Uptime Kuma record ID (monitorID, notificationID, dockerHostID, tagID).
 *
 * The `error` function is what turns an absent field back into "this field is required" rather
 * than the NaN complaint of #65. It answers only for an absent value, so a malformed one keeps
 * Zod's own description of what was wrong with it.
 */
function requiredId(description: string) {
  return numeric(
    z.number({
      error: (issue) =>
        issue.input === undefined ? `${description} — this field is required and was not provided` : undefined,
    })
      .int()
      .nonnegative()
  ).describe(description);
}

/**
 * The refusal for a redacted URL sent back pointing at a different host. Stored credentials
 * are only ever restored onto the host they were stored for — see rehydrateUrlCredentials.
 */
const HOST_CHANGED_MARKER_ERROR = (field: string, howToRead: string): string =>
  `"***" in ${field} is the redaction marker, and the stored credentials belong to a different host or port, ` +
  'so they were not restored — that would send a credential you were not shown to a new address. ' +
  `Pass the real credentials for the new address, or ${howToRead} to read the current ones.`;

/** A credential field's shared wording, so every one of them describes the round trip. */
const SECRET_NOTE = 'A credential: read tools return "***", and on updateMonitor sending "***" back keeps the stored value.';

/**
 * One entry of a monitor's `conditions`, as Uptime Kuma's condition editor builds it
 * (server/monitor-conditions/expression.js).
 *
 * Conditions nest, but this is deliberately NOT a recursive schema: z.lazy() is advertised as
 * a `$ref` into `definitions`, and tool input schemas with references are rejected by several
 * MCP clients (the class of problem behind #55 and #83). The top level is spelled out and the
 * children of a group are passed through as given, which also keeps the advertised schema small.
 */
const conditionFields = <T extends z.ZodTypeAny>(children: T) => ({
  type: z.enum(['expression', 'group']),
  andOr: z.enum(['and', 'or']).optional(),
  variable: z.string().optional(),
  operator: z.string().optional(),
  value: z.string().optional(),
  children: z.array(children).optional(),
});
const MonitorConditionInputSchema = z.object(conditionFields(z.record(z.string(), z.unknown())));

/**
 * The type-specific fields createMonitor and updateMonitor share (#112).
 *
 * Every key is the name Uptime Kuma's `editMonitor` handler READS (server/server.js), which is
 * also the name `toJSON()` returns it under — so a value read from getMonitor can be written
 * straight back. Before this, these fields were rejected as unknown, so the monitor types that
 * depend on them could be created but not configured, and then failed every check.
 *
 * One shape for both tools: the two schemas had already drifted apart once (#63).
 *
 * NO DESCRIPTIONS HERE, ON PURPOSE. Tool definitions are loaded into every session whether or
 * not the caller ever touches a monitor, and describing ~85 fields on two tools cost 32 KB of
 * every context window. Each field is advertised with a few words naming the types it belongs
 * to (see `advertisedMonitorFields`), and what it means lives in MONITOR_FIELD_DOCS, which
 * getMonitorTypeFields serves one type at a time.
 */
const TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS = {
  // ── HTTP authentication (http, keyword, json-query, websocket-upgrade, globalping) ──
  authMethod: z.enum(['basic', 'bearer', 'oauth2-cc', 'ntlm', 'mtls']).nullable().optional(),
  auth_method: z.enum(['basic', 'bearer', 'oauth2-cc', 'ntlm', 'mtls']).nullable().optional(),
  basic_auth_user: z.string().optional(),
  basic_auth_pass: z.string().optional(),
  bearer_token: z.string().optional(),
  authDomain: z.string().optional(),
  authWorkstation: z.string().optional(),
  oauth_token_url: z.string().optional(),
  oauth_client_id: z.string().optional(),
  oauth_client_secret: z.string().optional(),
  oauth_scopes: z.string().optional(),
  oauth_audience: z.string().optional(),
  oauth_auth_method: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
  tlsCert: z.string().optional(),
  tlsKey: z.string().optional(),
  tlsCa: z.string().optional(),

  // ── HTTP options ──
  httpBodyEncoding: z.enum(['json', 'form', 'xml']).optional(),
  ipFamily: z.enum(['ipv4', 'ipv6']).nullable().optional(),
  cacheBust: z.boolean().optional(),
  proxyId: numeric(z.number().int()).nullable().optional(),
  proxy_id: numeric(z.number().int()).nullable().optional(),
  saveResponse: z.boolean().optional(),
  save_response: z.boolean().optional(),
  saveErrorResponse: z.boolean().optional(),
  save_error_response: z.boolean().optional(),
  responseMaxLength: numeric(z.number().int().min(0).max(1048576)).optional(),
  response_max_length: numeric(z.number().int().min(0).max(1048576)).optional(),
  retryOnlyOnStatusCodeFailure: z.boolean().optional(),
  retry_only_on_status_code_failure: z.boolean().optional(),

  // ── websocket-upgrade ──
  wsSubprotocol: z.string().optional(),
  wsIgnoreSecWebsocketAcceptHeader: z.boolean().optional(),

  // ── mqtt (hostname takes the broker, e.g. mqtt://broker.example.com; port is required) ──
  mqttTopic: z.string().optional(),
  mqttUsername: z.string().optional(),
  mqttPassword: z.string().optional(),
  mqttCheckType: z.enum(['keyword', 'json-query']).optional(),
  mqttSuccessMessage: z.string().optional(),
  mqttWebsocketPath: z.string().regex(/^\/[A-Za-z0-9\-_&()*+]*$/, 'must start with "/" and contain only letters, digits and -_&()*+').optional(),

  // ── grpc-keyword ──
  grpcUrl: z.string().optional(),
  grpcProtobuf: z.string().optional(),
  grpcServiceName: z.string().optional(),
  grpcMethod: z.string().optional(),
  grpcBody: z.string().optional(),
  grpcMetadata: z.string().optional(),
  grpcEnableTls: z.boolean().optional(),

  // ── kafka-producer ──
  kafkaProducerBrokers: z.array(z.string()).optional(),
  kafkaProducerTopic: z.string().optional(),
  kafkaProducerMessage: z.string().optional(),
  kafkaProducerSsl: z.boolean().optional(),
  kafkaProducerAllowAutoTopicCreation: z.boolean().optional(),
  kafkaProducerSaslOptions: z.object({
    mechanism: z.enum(['None', 'plain', 'scram-sha-256', 'scram-sha-512', 'aws']),
    username: z.string().optional(),
    password: z.string().optional(),
    authorizationIdentity: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
  }).optional(),

  // ── radius (radiusPassword is declared by each tool) ──
  radiusUsername: z.string().optional(),
  radiusSecret: z.string().optional(),
  radiusCalledStationId: z.string().optional(),
  radiusCallingStationId: z.string().optional(),

  // ── rabbitmq ──
  rabbitmqNodes: z.array(z.string().regex(/^https?:\/\//i, 'must start with http:// or https://')).optional(),
  rabbitmqUsername: z.string().optional(),
  rabbitmqPassword: z.string().optional(),

  // ── snmp (compares the OID's value using jsonPath / jsonPathOperator / expectedValue) ──
  snmpOid: z.string().optional(),
  snmpVersion: z.enum(['1', '2c']).optional(),
  snmpCommunity: z.string().optional(),

  // ── smtp ──
  smtpSecurity: z.enum(['secure', 'nostarttls', 'starttls']).optional(),

  // ── gamedig ──
  game: z.string().optional(),
  gamedigGivenPortOnly: z.boolean().optional(),
  gamedigToken: z.string().optional(),

  // ── real-browser ──
  remote_browser: numeric(z.number().int()).nullable().optional(),
  screenshot_delay: numeric(z.number().min(0)).optional(),

  // ── globalping ──
  subtype: z.enum(['ping', 'http', 'dns']).optional(),
  location: z.string().optional(),
  protocol: z.enum(['ICMP', 'TCP', 'UDP', 'HTTP2']).nullable().optional(),

  // ── sftp ──
  sshUsername: z.string().optional(),
  sshAuthMethod: z.enum(['password', 'privateKey']).optional(),
  sshPassword: z.string().optional(),
  sshPrivateKey: z.string().optional(),
  sshPassphrase: z.string().optional(),
  sftpPath: z.string().optional(),

  // ── ping ──
  packetSize: numeric(z.number().int().min(1).max(65500)).optional(),
  ping_count: numeric(z.number().int().min(1).max(100)).optional(),
  ping_numeric: z.boolean().optional(),
  ping_per_request_timeout: numeric(z.number().int().min(1).max(60)).optional(),

  // ── ntp ──
  ntpStratumThreshold: numeric(z.number().int().min(1).max(16)).optional(),
  ntpTimeOffsetThreshold: numeric(z.number().min(0)).optional(),
  ntpRootDispersionThreshold: numeric(z.number().min(0)).optional(),

  // ── system-service, pm2 ──
  system_service_name: z.string().optional(),

  // ── manual ──
  manual_status: numeric(z.number().int().min(0).max(1)).nullable().optional(),

  // ── conditions (dns, mqtt, and the database types) ──
  conditions: z.array(MonitorConditionInputSchema).optional(),
};

/**
 * What each type-specific field means, served by getMonitorTypeFields. Kept beside the schemas
 * above and checked against them by a test, so a field cannot be added without being explained.
 */
const MONITOR_FIELD_DOCS: Record<keyof typeof TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS, string> = {
  // ── HTTP authentication (http, keyword, json-query, websocket-upgrade, globalping) ──
  authMethod: 'HTTP authentication method. Uptime Kuma only sends the credentials of the method named here, so it is inferred when you pass one kind of credential without it. null turns authentication off.',
  auth_method: 'Alias for authMethod (the database column name). Prefer authMethod.',
  basic_auth_user: 'Username for authMethod "basic" or "ntlm". Also the username of an oracledb monitor.',
  basic_auth_pass: `Password for authMethod "basic" or "ntlm". Also the password of an oracledb monitor. ${SECRET_NOTE}`,
  bearer_token: `Token for authMethod "bearer", sent as "Authorization: Bearer <token>". ${SECRET_NOTE}`,
  authDomain: 'NTLM domain (authMethod "ntlm")',
  authWorkstation: 'NTLM workstation (authMethod "ntlm")',
  oauth_token_url: 'OAuth2 token endpoint (authMethod "oauth2-cc", client credentials flow)',
  oauth_client_id: `OAuth2 client ID (authMethod "oauth2-cc"). ${SECRET_NOTE}`,
  oauth_client_secret: `OAuth2 client secret (authMethod "oauth2-cc"). ${SECRET_NOTE}`,
  oauth_scopes: 'OAuth2 scopes, space-separated (optional)',
  oauth_audience: 'OAuth2 audience (optional)',
  oauth_auth_method: 'How the client authenticates to the token endpoint (default: client_secret_basic)',
  tlsCert: `PEM client certificate for authMethod "mtls". ${SECRET_NOTE}`,
  tlsKey: `PEM private key for authMethod "mtls". ${SECRET_NOTE}`,
  tlsCa: `PEM CA certificate for authMethod "mtls" (optional). ${SECRET_NOTE}`,

  // ── HTTP options ──
  httpBodyEncoding: 'How the request body is encoded, which sets its Content-Type (default: json)',
  ipFamily: 'Force IPv4 or IPv6. null lets Uptime Kuma choose.',
  cacheBust: 'Append a random query parameter to each request to defeat caches',
  proxyId: 'ID of a proxy configured in Uptime Kuma to send requests through. null for none.',
  proxy_id: 'Alias for proxyId (the database column name). Prefer proxyId.',
  saveResponse: 'Store the response body with every heartbeat',
  save_response: 'Alias for saveResponse (the database column name). Prefer saveResponse.',
  saveErrorResponse: 'Store the response body with failing heartbeats',
  save_error_response: 'Alias for saveErrorResponse (the database column name). Prefer saveErrorResponse.',
  responseMaxLength: 'Maximum bytes of response body stored (default: 1024, max: 1048576)',
  response_max_length: 'Alias for responseMaxLength (the database column name). Prefer responseMaxLength.',
  retryOnlyOnStatusCodeFailure: 'json-query only: retry when the status code is wrong, but go DOWN at once when the JSON query fails',
  retry_only_on_status_code_failure: 'Alias for retryOnlyOnStatusCodeFailure (the database column name). Prefer retryOnlyOnStatusCodeFailure.',

  // ── websocket-upgrade ──
  wsSubprotocol: 'websocket-upgrade: Sec-WebSocket-Protocol to request, comma-separated for several',
  wsIgnoreSecWebsocketAcceptHeader: 'websocket-upgrade: do not validate the Sec-WebSocket-Accept header of the handshake',

  // ── mqtt (hostname takes the broker, e.g. mqtt://broker.example.com; port is required) ──
  mqttTopic: 'MQTT topic to subscribe to (required for mqtt)',
  mqttUsername: 'MQTT username',
  mqttPassword: `MQTT password. ${SECRET_NOTE}`,
  mqttCheckType: 'How the received message is judged: "keyword" looks for mqttSuccessMessage, "json-query" applies jsonPath / jsonPathOperator / expectedValue (default: keyword)',
  mqttSuccessMessage: 'Text the received message must contain, for mqttCheckType "keyword". Empty accepts any message.',
  mqttWebsocketPath: 'Path for MQTT over WebSocket (ws:// or wss:// hostname), e.g. /mqtt',

  // ── grpc-keyword ──
  grpcUrl: 'gRPC server as host:port (required for grpc-keyword)',
  grpcProtobuf: 'The .proto definition text describing the service (required for grpc-keyword)',
  grpcServiceName: 'Service name from the proto (required for grpc-keyword)',
  grpcMethod: 'Method to call on the service (required for grpc-keyword)',
  grpcBody: 'Request message as a JSON string',
  grpcMetadata: `Request metadata as a JSON string. Usually carries credentials. ${SECRET_NOTE}`,
  grpcEnableTls: 'Connect to the gRPC server over TLS',

  // ── kafka-producer ──
  kafkaProducerBrokers: 'Kafka brokers as host:port (required for kafka-producer)',
  kafkaProducerTopic: 'Topic the test message is produced to (required for kafka-producer)',
  kafkaProducerMessage: 'Message produced on every check (required for kafka-producer)',
  kafkaProducerSsl: 'Connect to the brokers over TLS',
  kafkaProducerAllowAutoTopicCreation: 'Let the broker create the topic if it does not exist',
  kafkaProducerSaslOptions: 'Kafka SASL authentication: { mechanism, ... }. mechanism "None" disables SASL; "plain", "scram-sha-256" and "scram-sha-512" take username and password; "aws" takes authorizationIdentity, accessKeyId, secretAccessKey and optionally sessionToken. Replaced as a whole object. password, secretAccessKey and sessionToken are credentials: read tools return "***", and on updateMonitor sending "***" back keeps the stored value.',

  // ── radius (radiusPassword is declared by each tool) ──
  radiusUsername: 'RADIUS username (required for radius)',
  radiusSecret: `RADIUS shared secret (required for radius). ${SECRET_NOTE}`,
  radiusCalledStationId: 'RADIUS Called-Station-Id attribute',
  radiusCallingStationId: 'RADIUS Calling-Station-Id attribute',

  // ── rabbitmq ──
  rabbitmqNodes: 'RabbitMQ management API URLs, e.g. ["https://rabbit1.example.com:15672"] (required for rabbitmq)',
  rabbitmqUsername: 'RabbitMQ management username',
  rabbitmqPassword: `RabbitMQ management password. ${SECRET_NOTE}`,

  // ── snmp (compares the OID's value using jsonPath / jsonPathOperator / expectedValue) ──
  snmpOid: 'OID to query, e.g. 1.3.6.1.2.1.1.3.0 (required for snmp)',
  snmpVersion: 'SNMP version (default: 2c). SNMPv3 cannot be set here: Uptime Kuma\'s edit handler does not save the v3 username.',
  snmpCommunity: `SNMP community string, e.g. "public" (required for snmp). Stored by Uptime Kuma as radiusPassword. ${SECRET_NOTE}`,

  // ── smtp ──
  smtpSecurity: 'smtp: "secure" for SMTPS, "starttls" to require STARTTLS, "nostarttls" to never use it. Omit to use STARTTLS when offered.',

  // ── gamedig ──
  game: 'GameDig game ID, e.g. "minecraft" (required for gamedig)',
  gamedigGivenPortOnly: 'Query only the given port instead of also trying the game\'s default ports (default: true)',
  gamedigToken: `Token for games whose query needs one. ${SECRET_NOTE}`,

  // ── real-browser ──
  remote_browser: 'ID of a remote browser configured in Uptime Kuma. null uses the built-in Chromium.',
  screenshot_delay: 'Milliseconds to wait after page load before the screenshot. Must be under 0.5 x interval.',

  // ── globalping ──
  subtype: 'globalping: the kind of measurement (default: ping). ping and dns need hostname; http needs url.',
  location: 'globalping: where the probe runs — a continent, country, city, ASN or cloud region, e.g. "world", "DE", "aws-us-east-1" (default: world). One location only, no commas.',
  protocol: 'globalping: ICMP or TCP for ping, UDP or TCP for dns, HTTP2 for http. null lets Globalping choose.',

  // ── sftp ──
  sshUsername: 'SSH username (required for sftp)',
  sshAuthMethod: 'How the sftp monitor logs in (default: password)',
  sshPassword: `SSH password, for sshAuthMethod "password". ${SECRET_NOTE}`,
  sshPrivateKey: `PEM private key, for sshAuthMethod "privateKey". ${SECRET_NOTE}`,
  sshPassphrase: `Passphrase of sshPrivateKey, if it has one. ${SECRET_NOTE}`,
  sftpPath: 'Remote path that must exist for the sftp monitor to be UP (optional)',

  // ── ping ──
  packetSize: 'Ping packet size in bytes (default: 56). Also used by steam.',
  ping_count: 'Echo requests sent per check (default: 1)',
  ping_numeric: 'Skip reverse DNS lookups in ping output (default: true)',
  ping_per_request_timeout: 'Seconds to wait for each echo reply (default: 2). Must not exceed timeout.',

  // ── ntp ──
  ntpStratumThreshold: 'ntp: DOWN when the server\'s stratum is above this (default: 5)',
  ntpTimeOffsetThreshold: 'ntp: DOWN when the clock offset exceeds this many milliseconds (default: 1000)',
  ntpRootDispersionThreshold: 'ntp: DOWN when root dispersion exceeds this many milliseconds (default: 500)',

  // ── system-service, pm2 ──
  system_service_name: 'Service name for system-service (the systemd unit or Windows service name, no spaces) or the process name for pm2. Required for both.',

  // ── manual ──
  manual_status: 'manual: the status to report — 1 = UP, 0 = DOWN, null = PENDING. Uptime Kuma does not return this field, so it cannot be read back.',

  // ── conditions (dns, mqtt, and the database types) ──
  conditions: 'Conditions the result must meet: a list of { type, andOr, variable, operator, value, children }. type is "expression" (compares one variable) or "group" (nests children of the same shape). andOr is "and" (default) or "or" and says how the entry combines with the one before it. variable is "record" for dns; "topic", "message" or "json_value" for mqtt; "result" for mysql, sqlserver and oracledb. operator is one of equals, not_equals, contains, not_contains, starts_with, not_starts_with, ends_with, not_ends_with, and for numeric variables num_equals, num_not_equals, lt, gt, lte, gte. value is a string. When set on mqtt they replace mqttCheckType. Replaced as a whole; pass [] to clear.',
};


const HTTP_AUTH_FIELDS = [
  'authMethod', 'basic_auth_user', 'basic_auth_pass', 'bearer_token',
  'oauth_token_url', 'oauth_client_id', 'oauth_client_secret', 'oauth_scopes', 'oauth_audience', 'oauth_auth_method',
];
const HTTP_REQUEST_FIELDS = [
  'url', 'method', 'headers', 'body', 'httpBodyEncoding', 'accepted_statuscodes', 'maxredirects', 'ignoreTls',
  'expiryNotification', 'domainExpiryNotification', 'ipFamily', 'cacheBust', 'proxyId',
  'saveResponse', 'saveErrorResponse', 'responseMaxLength',
  ...HTTP_AUTH_FIELDS, 'authDomain', 'authWorkstation', 'tlsCert', 'tlsKey', 'tlsCa',
];
const DATABASE_FIELDS = ['databaseConnectionString', 'databaseQuery'];

/**
 * The fields each monitor type uses, beyond the ones every type shares (COMMON_MONITOR_FIELDS).
 *
 * Read off what each type's check dereferences (server/monitor-types/*.js and the per-type
 * branches of server/model/monitor.js, Uptime Kuma 2.5.9). It is what getMonitorTypeFields
 * answers from and what the terse advertised descriptions are derived from. It does NOT gate
 * writes: Uptime Kuma stores any field on any type, and refusing one here because this table
 * is behind upstream would be a worse failure than accepting it.
 */
const MONITOR_TYPE_FIELDS: Record<string, string[]> = {
  http: HTTP_REQUEST_FIELDS,
  keyword: [...HTTP_REQUEST_FIELDS, 'keyword', 'invertKeyword'],
  'json-query': [...HTTP_REQUEST_FIELDS, 'jsonPath', 'jsonPathOperator', 'expectedValue', 'retryOnlyOnStatusCodeFailure'],
  port: ['hostname', 'port'],
  ping: ['hostname', 'packetSize', 'ping_count', 'ping_numeric', 'ping_per_request_timeout'],
  dns: ['hostname', 'port', 'dns_resolve_server', 'dns_resolve_type', 'conditions'],
  docker: ['docker_container', 'docker_host'],
  mqtt: [
    'hostname', 'port', 'mqttTopic', 'mqttUsername', 'mqttPassword', 'mqttCheckType', 'mqttSuccessMessage',
    'mqttWebsocketPath', 'jsonPath', 'expectedValue', 'conditions',
  ],
  mongodb: DATABASE_FIELDS,
  redis: ['databaseConnectionString', 'ignoreTls'],
  sqlserver: [...DATABASE_FIELDS, 'conditions'],
  postgres: DATABASE_FIELDS,
  mysql: [...DATABASE_FIELDS, 'databasePassword', 'conditions'],
  oracledb: [...DATABASE_FIELDS, 'basic_auth_user', 'basic_auth_pass', 'conditions'],
  'grpc-keyword': [
    'grpcUrl', 'grpcProtobuf', 'grpcServiceName', 'grpcMethod', 'grpcBody', 'grpcMetadata', 'grpcEnableTls',
    'keyword', 'invertKeyword',
  ],
  'kafka-producer': [
    'kafkaProducerBrokers', 'kafkaProducerTopic', 'kafkaProducerMessage', 'kafkaProducerSsl',
    'kafkaProducerAllowAutoTopicCreation', 'kafkaProducerSaslOptions',
  ],
  radius: [
    'hostname', 'port', 'radiusUsername', 'radiusPassword', 'radiusSecret', 'radiusCalledStationId',
    'radiusCallingStationId',
  ],
  rabbitmq: ['rabbitmqNodes', 'rabbitmqUsername', 'rabbitmqPassword'],
  smtp: ['hostname', 'port', 'smtpSecurity'],
  snmp: ['hostname', 'port', 'snmpOid', 'snmpVersion', 'snmpCommunity', 'jsonPath', 'jsonPathOperator', 'expectedValue'],
  'real-browser': ['url', 'remote_browser', 'screenshot_delay', 'accepted_statuscodes', 'ignoreTls'],
  gamedig: ['hostname', 'port', 'game', 'gamedigGivenPortOnly', 'gamedigToken'],
  steam: ['hostname', 'port'],
  push: ['pushToken'],
  group: [],
  'tailscale-ping': ['hostname'],
  manual: ['manual_status'],
  globalping: [
    'subtype', 'location', 'protocol', 'hostname', 'url', 'port', 'ping_count', 'dns_resolve_server',
    'dns_resolve_type', 'method', 'headers', 'accepted_statuscodes', 'ignoreTls', 'expiryNotification', 'ipFamily',
    'cacheBust', 'keyword', 'invertKeyword', 'jsonPath', 'jsonPathOperator', 'expectedValue', ...HTTP_AUTH_FIELDS,
  ],
  ntp: ['hostname', 'port', 'ntpStratumThreshold', 'ntpTimeOffsetThreshold', 'ntpRootDispersionThreshold'],
  'websocket-upgrade': [
    'url', 'wsSubprotocol', 'wsIgnoreSecWebsocketAcceptHeader', 'accepted_statuscodes', 'headers', 'ignoreTls',
    ...HTTP_AUTH_FIELDS, 'tlsCert', 'tlsKey', 'tlsCa',
  ],
  sftp: ['hostname', 'port', 'sshUsername', 'sshAuthMethod', 'sshPassword', 'sshPrivateKey', 'sshPassphrase', 'sftpPath'],
  'sip-options': ['hostname', 'port'],
  'system-service': ['system_service_name'],
  pm2: ['system_service_name'],
};

/** Accepted by every monitor type, so not repeated per type. */
const COMMON_MONITOR_FIELDS = [
  'name', 'description', 'active', 'parent', 'interval', 'retryInterval', 'maxretries', 'resendInterval', 'timeout',
  'upsideDown', 'notificationIDList', 'tags',
];

/**
 * The tools that remain when UPTIME_KUMA_READ_ONLY is set: the ones that only report.
 *
 * An allowlist, so a tool added later is left out of read-only mode until someone decides it
 * belongs — the safe way to be wrong. A test fails if a registered tool is in neither this set
 * nor WRITE_TOOLS, so that decision cannot be skipped.
 *
 * testDockerHost changes nothing but makes Uptime Kuma connect to an address of the caller's
 * choosing, and getMonitorTypeFields only serves the write tools, so neither is here.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'getMonitor', 'listMonitors', 'listMonitorTypes', 'getMonitorSummary', 'getHeartbeats', 'listHeartbeats',
  'getSettings', 'listNotifications', 'listDockerHosts', 'listTags', 'getMaintenanceWindows', 'listStatusPages',
  'getStatusPage',
]);

/** Every other tool. Left out of read-only mode. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'getMonitorTypeFields', 'createMonitor', 'updateMonitor', 'deleteMonitor', 'pauseMonitor', 'resumeMonitor',
  'addNotification', 'updateNotification', 'deleteNotification',
  'addDockerHost', 'updateDockerHost', 'deleteDockerHost', 'testDockerHost',
  'addTag', 'deleteTag',
  'createMaintenance', 'updateMaintenance', 'deleteMaintenance', 'pauseMaintenance', 'resumeMaintenance',
  'createStatusPage', 'updateStatusPage', 'deleteStatusPage',
]);

/** The names accepted inside `typeFields`, for tests and tooling. */
export const MONITOR_TYPE_FIELD_NAMES: readonly string[] = Object.keys(TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS);

/**
 * Validates `typeFields` against the schemas above, as strictly as a top-level field would be.
 *
 * `typeFields` is advertised as a free-form object so the ~85 fields in it cost nothing in the
 * tool list; this is where the checking the advertised schema no longer does happens. An
 * unknown key is refused by name rather than dropped, for the reason every other tool here is
 * strict: a dropped field is refilled with its old value and Uptime Kuma answers "Saved.".
 *
 * `topLevel` is the tool's own field names, to say so when one of them was nested by mistake.
 */
const TypeFieldsSchema = z.strictObject(TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS);
const looseFieldName = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');
function parseTypeFields(raw: unknown, topLevel: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  const parsed = TypeFieldsSchema.safeParse(raw);
  if (parsed.success) {
    return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  }
  const problems = parsed.error.issues.flatMap((issue) => {
    if (issue.code !== 'unrecognized_keys') {
      return [`typeFields.${issue.path.join('.')}: ${issue.message}`];
    }
    return issue.keys.map((key) => {
      if (topLevel.includes(key)) return `'${key}' is a top-level field — pass it beside typeFields, not inside it`;
      const match = [...MONITOR_TYPE_FIELD_NAMES, ...topLevel].find((name) => looseFieldName(name) === looseFieldName(key));
      return match
        ? `'${key}' is not a field — did you mean '${match}'?`
        : `'${key}' is not a field of any monitor type`;
    });
  });
  throw new Error(
    `Invalid typeFields: ${problems.join('; ')}. getMonitorTypeFields lists the fields a monitor type accepts and what each takes.`
  );
}

const TYPE_FIELDS_DESCRIPTION =
  'Fields specific to the monitor type, e.g. {"mqttTopic": "sensors/#"} for mqtt or {"bearer_token": "…"} for an HTTP monitor behind authentication. ' +
  'Call getMonitorTypeFields with the type for the names, meanings and allowed values — they are validated, and an unknown name is refused. ' +
  'getMonitor returns these fields at the top level of the monitor; to change one, pass it here.';

const DRAFT_07_DIALECT = 'http://json-schema.org/draft-07/schema#';
const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

// Keywords whose value is a map of schemas keyed by arbitrary names, not by JSON Schema
// keywords. Descending into one has to stop treating its keys as keywords.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']);

// Keywords whose value is instance data rather than a schema. Nothing inside them is a schema,
// so they are passed through untouched.
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);

const isEmptySchema = (value: unknown): value is Record<string, never> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;

/**
 * Normalizes the JSON Schema the SDK advertises from tools/list.
 *
 * Issue #83: the SDK converts every tool's input/output Zod schema to JSON Schema via
 * zod-to-json-schema without setting a `target`, so each one is stamped
 * "$schema": "http://json-schema.org/draft-07/schema#" — verified against both the SDK
 * version this project pins (^1.22.0) and the current latest (1.30.0); the behavior is
 * unchanged between them. Clients whose validator only accepts the MCP spec's default
 * dialect (2020-12, per SEP-1613) reject every tool outright before ever calling it
 * (see modelcontextprotocol/typescript-sdk#745, still open upstream).
 *
 * None of the schemas advertised here use anything that differs between the two drafts (no
 * `dependencies`, no positional tuple items), so relabeling the declared dialect is safe —
 * only the version stamp was wrong, not the shape.
 *
 * Issue #55: Home Assistant rejects the valid empty-schema form Zod emits for
 * z.record(..., z.unknown()), so `additionalProperties: {}` is rewritten to the equivalent
 * boolean form.
 *
 * Integer bounds: Zod stamps every `.int()` with `minimum: -9007199254740991` and
 * `maximum: 9007199254740991`, the safe-integer range. They constrain nothing a JSON number
 * could violate in practice and cost about 60 bytes per integer field in every session's
 * tool list, so they are dropped. A bound the schema actually declares is a different number
 * and is kept.
 */
export function normalizeAdvertisedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAdvertisedSchema);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'additionalProperties' && isEmptySchema(val)) {
        out[key] = true;
      } else if (key === '$schema' && val === DRAFT_07_DIALECT) {
        out[key] = DIALECT_2020_12;
      } else if (
        (key === 'minimum' && val === Number.MIN_SAFE_INTEGER) ||
        (key === 'maximum' && val === Number.MAX_SAFE_INTEGER)
      ) {
        // Dropped: see the note on integer bounds above.
      } else if (DATA_KEYWORDS.has(key)) {
        out[key] = val;
      } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
        out[key] = normalizeSchemaMap(val);
      } else {
        out[key] = normalizeAdvertisedSchema(val);
      }
    }
    return out;
  }
  return value;
}

/**
 * Normalizes a map whose keys are names rather than JSON Schema keywords — the members of
 * `properties`, `$defs`, and friends. Each value is a schema, but the keys are arbitrary, so a
 * tool declaring a field called `additionalProperties` must not have it mistaken for the
 * keyword one level up.
 */
function normalizeSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalizeAdvertisedSchema(value);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = normalizeAdvertisedSchema(val);
  }
  return out;
}

/**
 * Creates and configures the MCP server with tools, resources, and prompts
 * Note: Authentication must be done separately after connecting the transport
 */
export async function createServer(config: UptimeKumaConfig): Promise<{ server: McpServer; client: UptimeKumaClient; authenticateClient: () => Promise<void> }> {
  // Track current logging level (default: info)
  let currentLogLevel: LoggingLevel = 'info';

  // UPTIME_KUMA_READ_ONLY: the write tools are not registered (see the registerTool wrapper
  // below), so the instructions must not send a model looking for them.
  const readOnlyMode = config.readOnly === true;
  const writeInstructions = readOnlyMode
    ? `        This server is running READ-ONLY (UPTIME_KUMA_READ_ONLY): it has no tools that create,
        change, pause or delete anything. Say so if asked to make a change.
`
    : `        WRITE operations:
        - Use 'createMonitor' / 'updateMonitor' / 'deleteMonitor' to manage monitors.
        - Call 'getMonitorTypeFields' before creating or reconfiguring a monitor: it names the fields a type needs. Type-specific fields go in the typeFields argument.
        - Use 'addNotification' / 'updateNotification' / 'deleteNotification' to manage notification channels.
        - Use 'addTag' / 'deleteTag' to manage tags.
        - Use 'createMaintenance' / 'updateMaintenance' / 'deleteMaintenance' to manage maintenance windows. Pass monitorIDs — a window with no monitors suppresses nothing.
        - Use 'pauseMaintenance' / 'resumeMaintenance' to switch a maintenance window off and on.
        - Use 'addDockerHost' / 'updateDockerHost' / 'deleteDockerHost' to manage docker daemon connections.
        - Use 'testDockerHost' to verify a docker daemon is reachable before saving.
        - Use 'createStatusPage' / 'updateStatusPage' / 'deleteStatusPage' to manage status pages. Creating returns an empty page — follow up with updateStatusPage to set groups and monitors.
        - Use 'pauseMonitor' / 'resumeMonitor' to temporarily stop/start checks.
`;

  const server = new McpServer(
    {
      name: 'mcp-uptime-kuma',
      version: VERSION,
    },
    {
      instructions: `
        This MCP server provides access to Uptime Kuma monitoring data and management operations.

        READ operations:
        - START with 'getMonitorSummary' for status overview ("how is everything?", "what's down?").
        - Use 'getHeartbeats' or 'listHeartbeats' for historical data (limit to 5-10 heartbeats unless user requests more).
        - Use 'listMonitors' when you need configuration details (URLs, intervals, notification settings).
        - Use 'listNotifications' to see notification channels.
        - Use 'listTags' to see available tags.
        - Use 'getMaintenanceWindows' to see maintenance windows and the monitors each one covers.
        - Use 'listStatusPages' to see status page configurations, or 'getStatusPage' for one page's full details (groups + monitors).
        - Use 'listDockerHosts' to see configured docker daemons (used by docker container monitors).

${writeInstructions}
        CREDENTIALS:
        - Read tools return "***" in place of passwords, tokens, API keys and HTTP headers.
          To attach a notification channel to a monitor you only need its id, so the common
          workflows never need the real values.
        - Pass includeSecrets: true (or set UPTIME_KUMA_INCLUDE_SECRETS=true) only when the
          value itself is needed. It will be written to this conversation's transcript.
${readOnlyMode ? '' : `        - "***" sent back to updateMonitor / updateNotification restores the stored value
          rather than overwriting it, so a read-edit-write round trip is safe.`}
      `,
      capabilities: {
        logging: {}
      }
    }
  );

  // Reject unknown keys instead of silently stripping them.
  //
  // registerTool is normally handed a raw Zod *shape*, which the SDK turns into a plain
  // z.object(shape). A plain object schema DROPS keys it doesn't know about rather than
  // erroring, and the write handlers then merge what survived over the monitor's existing
  // config — so a field this server doesn't declare is refilled with its old value and
  // Uptime Kuma answers {"ok":true,"msg":"Saved."}. A partial write reported as a complete
  // one. That is the shared mechanism behind #58, #60, #63 and #65; each was reported
  // separately because there is nothing in the response to connect them.
  //
  // getZodSchemaObject / normalizeObjectSchema both accept an already-built Zod object and
  // pass it through untouched, so upgrading every shape to .strict() here converts the whole
  // class from silent data loss into a loud error that names the offending key. It also puts
  // additionalProperties: false into the advertised JSON Schema, so callers are told up front
  // rather than discovering it from a write that didn't happen.
  //
  // Done by wrapping the method once rather than editing ~31 schemas by hand: one seam, no
  // chance of missing one, and it covers any tool added later.
  const readOnly = readOnlyMode;
  const registerToolUnstrict = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: Record<string, unknown>,
    cb: unknown
  ) => {
    // Read-only mode: a tool that is not registered cannot be called, listed, or cost context.
    if (readOnly && !READ_ONLY_TOOLS.has(name)) return undefined;
    const shape = config?.inputSchema as Record<string, unknown> | undefined;
    // Only upgrade raw shapes; anything already a Zod schema is left alone.
    if (shape && typeof shape === 'object' && !('_def' in shape) && !('_zod' in shape)) {
      config = { ...config, inputSchema: strictInputSchema(name, shape as z.ZodRawShape) };
    }
    return (registerToolUnstrict as unknown as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as typeof server.registerTool;

  /**
   * Builds the strict schema, and makes an unknown key the FIRST thing the caller reads.
   *
   * Zod appends `unrecognized_keys` after the per-field issues, so `getMonitor {monitorId: 1}`
   * reports the absent monitorID first and the misspelled key second. The first line is the
   * misleading one: it points at a field the caller never got wrong. Reordering turns a
   * message that sends you hunting for a missing argument into one that says "you misspelled
   * this key" (#65).
   *
   * The message comes from the schema's own `error` option. The order has no public hook, so
   * it is applied where every parse path meets: the SDK runs a Zod 4 schema through Zod's
   * top-level safeParseAsync(), which calls `_zod.run` and never the schema's safeParse().
   */
  function strictInputSchema(toolName: string, shape: z.ZodRawShape) {
    const accepted = Object.keys(shape);
    // camelCase, snake_case and a wrong capital are the same guess at a name. Uptime Kuma mixes
    // all three (basic_auth_user, authMethod, monitorID), so say which one this field uses
    // rather than leaving the caller to find it in the list.
    const looseName = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');
    const byLooseName = new Map(accepted.map((key) => [looseName(key), key]));

    const schema = z.strictObject(shape, {
      error: (issue) => {
        if (issue.code !== 'unrecognized_keys') return undefined;
        const suggestions = issue.keys
          .map((k) => [k, byLooseName.get(looseName(k))])
          .filter(([, match]) => match !== undefined)
          .map(([k, match]) => `'${match}' for '${k}'`);
        // The fields that live in typeFields are the likeliest thing to be passed here instead.
        const typeFieldFor = (k: string) => MONITOR_TYPE_FIELD_NAMES.find((name) => looseFieldName(name) === looseFieldName(k));
        const nested = 'typeFields' in shape ? issue.keys.filter((k) => typeFieldFor(k) !== undefined) : [];
        return (
          `Unknown field(s) for ${toolName}: ${issue.keys.map((k) => `'${k}'`).join(', ')}. ` +
          (nested.length > 0
            ? `${nested.map((k) => `'${k}'`).join(', ')} ${nested.length > 1 ? 'are type-specific fields and go' : 'is a type-specific field and goes'} ` +
              `inside typeFields: {"typeFields": {${nested.map((k) => `"${typeFieldFor(k)}": …`).join(', ')}}}. `
            : '') +
          (suggestions.length > 0 ? `Did you mean ${suggestions.join(', ')}? ` : '') +
          'Field names are case-sensitive — check spelling and casing first (monitorID, not monitorId). ' +
          `Accepted fields: ${accepted.join(', ')}. ` +
          'Any other issue reported below may be a knock-on effect of this one: a required field ' +
          'that looks absent is usually the misspelled key.'
        );
      },
    });

    type Payload = { issues: Array<{ code?: string }> };
    const unknownKeysFirst = <P extends Payload>(payload: P): P => {
      payload.issues.sort(
        (a, b) => Number(b.code === 'unrecognized_keys') - Number(a.code === 'unrecognized_keys')
      );
      return payload;
    };
    const internals = schema._zod as unknown as {
      run: (payload: Payload, ctx: unknown) => Payload | Promise<Payload>;
    };
    const run = internals.run;
    internals.run = (payload, ctx) => {
      const result = run(payload, ctx);
      return result instanceof Promise ? result.then(unknownKeysFirst) : unknownKeysFirst(result);
    };

    return schema;
  }

  // Normalize the advertised JSON Schema on the way out (see normalizeAdvertisedSchema).
  // This intercepts the SDK's own `setRequestHandler(ListToolsRequestSchema, ...)` call (made
  // lazily on first `registerTool`, below) rather than reimplementing tools/list, so it keeps
  // working across SDK internals changing between versions.
  const setRequestHandlerUnpatched = server.server.setRequestHandler.bind(server.server) as (
    requestSchema: unknown,
    handler: (...args: unknown[]) => unknown
  ) => unknown;
  (server.server as unknown as { setRequestHandler: typeof server.server.setRequestHandler }).setRequestHandler = ((
    requestSchema: unknown,
    handler: (...args: unknown[]) => unknown
  ) => {
    if (requestSchema === ListToolsRequestSchema) {
      const wrapped = async (...args: unknown[]) => normalizeAdvertisedSchema(await handler(...args));
      return setRequestHandlerUnpatched(requestSchema, wrapped);
    }
    return setRequestHandlerUnpatched(requestSchema, handler);
  }) as typeof server.server.setRequestHandler;

  // Handle logging level changes via the underlying server
  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const level = request.params?.level as LoggingLevel | undefined;
    if (level && LoggingLevelSchema.safeParse(level).success) {
      currentLogLevel = level;
      return {};
    }
    throw new McpError(ErrorCode.InvalidParams, `Invalid log level: ${level}`);
  });

  // Initialize Uptime Kuma client with a function to check if a log level should be sent
  // LoggingLevelSchema enum values are already in order: debug < info < notice < ... < emergency
  const logLevels = LoggingLevelSchema.options;
  const shouldLog = (level: LoggingLevel): boolean => {
    return logLevels.indexOf(level) >= logLevels.indexOf(currentLogLevel);
  };
  
  const client = new UptimeKumaClient(config.url, server, shouldLog, config.extraHeaders);

  // Issue #59: read tools withhold credentials by default. Captured here because the
  // registerTool wrapper above shadows `config` with the per-tool registration object.
  //
  // The env var is the global switch and the per-call `includeSecrets` parameter is the
  // narrow one; the parameter wins where both are present, in either direction, so a
  // globally-permissive deployment can still ask a single call to redact.
  const includeSecretsByDefault = config.includeSecrets === true;
  const wantsSecrets = (perCall?: boolean): boolean =>
    perCall === undefined ? includeSecretsByDefault : perCall;
  const includeSecretsParam = z.boolean().optional().describe(INCLUDE_SECRETS_DESCRIPTION);

  let isAuthenticated = false;
  let authInFlight: Promise<void> | null = null;

  // The client reports when the authenticated session is known to be gone (socket dropped,
  // or a re-auth on reconnect was refused). Clearing the flag here is what lets the next
  // tool call transparently re-authenticate, instead of the process staying wedged.
  client.onAuthLost = (reason: string) => {
    if (!isAuthenticated) return;
    isAuthenticated = false;
    process.stderr.write(`Uptime Kuma session invalidated: ${reason}. Will re-authenticate on next call.\n`);
  };

  // UPTIME_KUMA_JWT_TOKEN must be a real JWT — Uptime Kuma verifies it with jwt.verify()
  // against its jwtSecret. Anything else (a password, an API key, a truncated paste) is
  // rejected with the opaque message "authInvalidToken", which reads exactly like an
  // expired credential and sends you looking for a token-lifetime problem that isn't there.
  // Only the credential's SHAPE is ever reported — never its value.
  const describeCredential = (): string | null => {
    const t = config.jwtToken;
    if (!t) return null;
    const segments = String(t).split('.').length;
    if (segments === 3) return null;
    return `UPTIME_KUMA_JWT_TOKEN is not a JWT: it has ${segments} dot-separated segment(s), expected 3 `
      + `(length ${String(t).length}). Uptime Kuma will always reject this with "authInvalidToken". `
      + `Generate a real token with: mcp-uptime-kuma-get-jwt ${config.url} <username> <password>. `
      + 'Note this variable may also be set in your shell environment as well as your MCP client '
      + 'config — check both and make sure they agree.';
  };

  // Function to authenticate the client (to be called after transport is connected).
  //
  // Memoised on two axes. Returning early when already authenticated makes it safe to call
  // from every tool handler; sharing one in-flight promise stops concurrent calls opening a
  // second socket.io connection during the handshake.
  const authenticateClient = async (): Promise<void> => {
    if (isAuthenticated) return;
    if (authInFlight) return authInFlight;

    authInFlight = (async () => {
      try {
        // Reuse a live socket. connect() unconditionally assigns a new one, so every retry
        // orphaned the previous socket — still holding listeners, still reconnecting.
        await client.ensureConnected();
        await client.login(config.username, config.password, config.token, config.jwtToken);

        // Logging in anonymously gives no indication that authentication failed.
        // So instead, we issue a getSettings call after login, to prove the connection is working.
        await client.getSettings();
        isAuthenticated = true;

        await server.sendLoggingMessage({
          level: 'info',
          data: 'Successfully authenticated with Uptime Kuma'
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const credentialProblem = describeCredential();
        const detail = credentialProblem ? `${errorMessage}. ${credentialProblem}` : errorMessage;
        await server.sendLoggingMessage({
          level: 'error',
          data: `Failed to authenticate with Uptime Kuma: ${detail}`
        });
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to authenticate with Uptime Kuma: ${detail}`
        );
      }
    })();

    try {
      return await authInFlight;
    } finally {
      // Always clear the in-flight promise once it settles. Clearing only on failure meant
      // that after the first success it stayed set forever, so once a session could be
      // invalidated, authenticateClient() would return that stale resolved promise and skip
      // re-authenticating entirely.
      authInFlight = null;
    }
  };

  // Register getMonitor tool
  server.registerTool(
    'getMonitor',
    {
      title: 'Get Monitor',
      description: 'Retrieves configuration details for a specific monitor by ID (URL, check interval, notification settings, etc.). Use this when you need to examine or modify settings for a specific monitor. For current status, use getMonitorSummary instead. By default returns only common fields plus runtime data (uptime, avgPing); set includeTypeSpecificFields to true to include type-specific fields (e.g., url for HTTP, hostname/port for TCP).',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to retrieve'),
        includeTypeSpecificFields: z.boolean().optional().describe('Include type-specific fields (url, hostname, port, etc.) in addition to common fields. Default: false. When false, only returns MonitorBase fields plus uptime/avgPing.'),
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        monitor: MonitorBaseSchema.passthrough().describe('Monitor object with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true. Credentials (pushToken, basic_auth_pass, bearer_token, headers, ...) read "***" unless includeSecrets is set.')
      },
    },
    async ({ monitorID, includeTypeSpecificFields, includeSecrets }) => {
      await authenticateClient();

      try {
        const monitor = includeTypeSpecificFields
          ? client.getMonitor(monitorID, true)
          : client.getMonitor(monitorID, false);

        if (!monitor) {
          throw new Error(`Monitor with ID ${monitorID} not found`);
        }

        // Redact on a copy. getMonitor() spreads the cached row, but nested values are
        // still shared with monitorListCache — which updateMonitor merges over on write.
        const result = wantsSecrets(includeSecrets) ? monitor : redactSecrets(monitor);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: { monitor: result },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get monitor: ${errorMessage}`
        );
      }
    }
  );

  // Register listMonitors tool
  server.registerTool(
    'listMonitors',
    {
      title: 'List Monitors',
      description: 'Retrieves configuration details for all monitors (URLs, check intervals, notification settings, etc.). Use this when you need to examine or modify monitor settings. For status checks ("how is everything doing?", "what\'s down?"), use getMonitorSummary instead. By default returns only common fields plus runtime data (uptime, avgPing); set includeTypeSpecificFields to true to include type-specific fields (e.g., url for HTTP, hostname/port for TCP). Supports filtering by keywords, type, active/maintenance status, tags, and parent group.',
      inputSchema: {
        includeTypeSpecificFields: z.boolean().optional().describe('Include type-specific fields (url, hostname, port, etc.) in addition to common fields. Default: false. When false, only returns MonitorBase fields plus uptime/avgPing.'),
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive fuzzy match). All keywords must match for a monitor to be included.'),
        type: z.string().optional().describe('Filter by monitor type(s). Comma-separated for multiple types. Use listMonitorTypes tool to see all available types.'),
        active: z.boolean().optional().describe('Filter by active status. true=only active monitors, false=only inactive monitors.'),
        maintenance: z.boolean().optional().describe('Filter by maintenance status. true=only monitors in maintenance, false=only monitors not in maintenance.'),
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"'),
        // Issue #65: there was no way to list a group's members, so callers passing
        // `parentId` got the entire monitor list back, which reads as a broken filter.
        parentId: numeric(z.number().int()).nullable().optional().describe('Filter to the DIRECT children of this group monitor. Pass null for top-level monitors (those with no parent). Not recursive — use the group\'s own childrenIDs to walk deeper.'),
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        monitors: z.array(MonitorBaseSchema.passthrough()).describe('Array of monitor objects with common fields plus uptime/avgPing. May include type-specific fields when includeTypeSpecificFields is true. Credentials (pushToken, basic_auth_pass, bearer_token, headers, ...) read "***" unless includeSecrets is set.'),
        count: z.number()
      },
    },
    async ({ includeTypeSpecificFields, keywords, type, active, maintenance, tags, parentId, includeSecrets }) => {
      await authenticateClient();

      try {
        const monitorList = includeTypeSpecificFields
          ? client.getMonitorList({ keywords, type, active, maintenance, tags, parentId, includeTypeSpecificFields: true })
          : client.getMonitorList({ keywords, type, active, maintenance, tags, parentId, includeTypeSpecificFields: false });
        const raw = Object.values(monitorList);
        // This is the tool an agent reaches for to answer "what am I monitoring?", so it
        // is both the highest-volume caller and the one carrying the most credentials.
        const monitors = wantsSecrets(includeSecrets) ? raw : raw.map((m) => redactSecrets(m));

        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(monitors, null, 2) 
          }],
          structuredContent: { 
            monitors,
            count: monitors.length 
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list monitors: ${errorMessage}`
        );
      }
    }
  );

  const MONITOR_TYPES = [
    { type: 'http', description: 'HTTP/HTTPS monitoring with status code and response time checks' },
    { type: 'keyword', description: 'HTTP monitoring that searches for a specific keyword in the response' },
    { type: 'json-query', description: 'HTTP monitoring that validates JSON response using JSONPath queries' },
    { type: 'port', description: 'TCP port connectivity check' },
    { type: 'ping', description: 'ICMP ping check' },
    { type: 'dns', description: 'DNS resolution check for A, AAAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, or CAA records' },
    { type: 'docker', description: 'Docker container status check' },
    { type: 'mqtt', description: 'MQTT broker connectivity and topic monitoring' },
    { type: 'mongodb', description: 'MongoDB database connectivity check' },
    { type: 'redis', description: 'Redis database connectivity check' },
    { type: 'sqlserver', description: 'SQL Server database connectivity check' },
    { type: 'postgres', description: 'PostgreSQL database connectivity check' },
    { type: 'mysql', description: 'MySQL/MariaDB database connectivity check' },
    { type: 'grpc-keyword', description: 'gRPC service health check with keyword validation' },
    { type: 'kafka-producer', description: 'Kafka producer connectivity and message publishing check' },
    { type: 'radius', description: 'RADIUS server authentication check' },
    { type: 'rabbitmq', description: 'RabbitMQ server connectivity check' },
    { type: 'smtp', description: 'SMTP server connectivity check' },
    { type: 'snmp', description: 'SNMP device monitoring with OID queries' },
    { type: 'real-browser', description: 'Real browser-based monitoring using Chrome/Chromium' },
    { type: 'gamedig', description: 'Game server status check using GameDig protocol' },
    { type: 'push', description: 'Push-based monitoring (monitor receives heartbeats from external sources)' },
    { type: 'group', description: 'Group/folder for organizing monitors (not an actual check)' },
    { type: 'tailscale-ping', description: 'Tailscale network ping check' },
    { type: 'manual', description: 'Manual status monitor (status set manually, not automatically checked)' },
    { type: 'steam', description: 'Steam game server status check' },
    { type: 'globalping', description: 'Ping, HTTP or DNS check run from Globalping probes around the world' },
    { type: 'ntp', description: 'NTP server check with stratum and time offset thresholds' },
    { type: 'websocket-upgrade', description: 'WebSocket upgrade handshake check' },
    { type: 'sftp', description: 'SFTP server login and path check' },
    { type: 'sip-options', description: 'SIP OPTIONS ping check' },
    { type: 'oracledb', description: 'Oracle Database connectivity check' },
    { type: 'system-service', description: 'Local system service status check (systemd or Windows service)' },
    { type: 'pm2', description: 'PM2 process status check' }
  ];
  const MONITOR_TYPE_NAMES = new Set(MONITOR_TYPES.map((t) => t.type));

  // Register listMonitorTypes tool
  server.registerTool(
    'listMonitorTypes',
    {
      title: 'List Monitor Types',
      description: 'Returns a list of all available monitor types supported by Uptime Kuma. Use this to discover valid values for type filters in other tools.',
      inputSchema: {},
      outputSchema: {
        types: z.array(z.object({
          type: z.string().describe('The monitor type identifier'),
          description: z.string().describe('Description of what this monitor type does')
        })).describe('Array of available monitor types')
      },
    },
    async () => {
      const monitorTypes = MONITOR_TYPES;
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify(monitorTypes, null, 2) 
        }],
        structuredContent: { 
          types: monitorTypes 
        },
      };
    }
  );

  // Register getMonitorSummary tool
  server.registerTool(
    'getMonitorSummary',
    {
      title: 'Get Monitor Summary',
      description: 'START HERE for status overview questions. Retrieves current status for all monitors showing UP/DOWN/PENDING/MAINTENANCE states with the most recent heartbeat message. Use this when asked "how is everything doing?", "what\'s down?", "what\'s up?", or for any general status overview. Returns essential information (ID, name, pathName, active state, maintenance state, status, message, lastBeatTime, type, tags). Supports filtering by keywords, type, active/maintenance status, tags, parent group, and current status. Check lastBeatTime before trusting the status of a push monitor — one that has stopped beating keeps reporting its last known status. lastBeatTime is UTC with no zone marker, so measure staleness against the current UTC time.',
      inputSchema: {
        keywords: z.string().optional().describe('Space-separated keywords to filter monitors by pathName (case-insensitive fuzzy match). All keywords must match for a monitor to be included.'),
        type: z.string().optional().describe('Filter by monitor type(s). Comma-separated for multiple types. Use listMonitorTypes tool to see all available types.'),
        active: z.boolean().optional().describe('Filter by active status. true=only active monitors, false=only inactive monitors.'),
        maintenance: z.boolean().optional().describe('Filter by maintenance status. true=only monitors in maintenance, false=only monitors not in maintenance.'),
        tags: z.string().optional().describe('Filter by tag name and optional value. Comma-separated for multiple tags. Format: "tagName" or "tagName=value". Monitor must have all specified tags. Case-insensitive. Examples: "production", "env=staging", "production,region=us-east"'),
        // "What's down in this group?" is a status question, so it arrives here rather than at
        // listMonitors — but the #65 parent filter only reached listMonitors, leaving the tool
        // the instructions send callers to FIRST unable to answer it.
        parentId: numeric(z.number().int()).nullable().optional().describe('Filter to the DIRECT children of this group monitor. Pass null for top-level monitors (those with no parent). Not recursive — use the group\'s own childrenIDs to walk deeper.'),
        status: z.string().optional().describe('Filter by current heartbeat status. Comma-separated for multiple statuses. 0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE. Examples: "0", "1", "0,2"')
      },
      outputSchema: { 
        summaries: z.array(MonitorSummarySchema).describe('Array of monitor summaries'),
        count: z.number()
      },
    },
    async ({ keywords, type, active, maintenance, tags, parentId, status }) => {
      await authenticateClient();

      try {
        const summaries = client.getMonitorSummary({ keywords, type, active, maintenance, tags, parentId, status });
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(summaries, null, 2) 
          }],
          structuredContent: { 
            summaries,
            count: summaries.length 
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get monitor summary: ${errorMessage}`
        );
      }
    }
  );

  // Register getHeartbeats tool
  server.registerTool(
    'getHeartbeats',
    {
      title: 'Get Heartbeats',
      description: 'Retrieves historical heartbeat data for a specific monitor (response times, status changes over time). Use this for analyzing patterns or history for one monitor. Beats are returned NEWEST-FIRST. By default returns only the most recent heartbeat; set maxHeartbeats (up to 100) for historical analysis. Keep maxHeartbeats ≤10 unless user requests more. Set important:true for the status CHANGES only (Uptime Kuma\'s own event list) — that is history, not current state, so do not read status from it. Credentials embedded in a status message URL (user:pass@host) read "***" unless includeSecrets is set.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to get heartbeats for'),
        maxHeartbeats: numeric(z.number().int().positive().max(100)).optional().describe('If set, returns the most recent X heartbeats (up to 100). If unset, returns only the most recent heartbeat (default: 1)'),
        // `limit` and `count` are what a caller reaches for first. Both used to be stripped,
        // leaving maxHeartbeats undefined and the call silently returning a single beat.
        limit: numeric(z.number().int().positive().max(100)).optional().describe('Alias for maxHeartbeats. Prefer maxHeartbeats.'),
        count: numeric(z.number().int().positive().max(100)).optional().describe('Alias for maxHeartbeats. Prefer maxHeartbeats.'),
        important: z.boolean().optional().describe('Return only IMPORTANT beats — the status changes behind Uptime Kuma\'s event list — fetched live from the server rather than the cache. History only: the newest important beat is not the monitor\'s current status.'),
        includeSecrets: includeSecretsParam
      },
      outputSchema: { 
        monitorID: z.number(),
        heartbeats: z.array(HeartbeatSchema),
        count: z.number()
      },
    },
    async ({ monitorID, maxHeartbeats, limit, count: countAlias, important, includeSecrets }) => {
      await authenticateClient();

      try {
        const requested = [maxHeartbeats, limit, countAlias].filter((v) => v !== undefined);
        if (new Set(requested).size > 1) {
          throw new Error(
            `Conflicting values for maxHeartbeats and its aliases (${requested.join(', ')}) — pass only 'maxHeartbeats'.`
          );
        }
        const count = requested[0] ?? 1;
        // The important/event feed is fetched live rather than served from the cache, but it
        // is heartbeat data all the same — it carries the same `msg`, so it goes through the
        // same redaction. Redacting only the cached path would leave the event list as an
        // unguarded second way to read the credentials out of a status message (#59).
        const raw = important
          ? await client.fetchImportantHeartbeats(monitorID, count)
          : client.getHeartbeatsForMonitor(monitorID, count);
        // Heartbeats are projected to their declared fields (dropping passthrough columns
        // like response) and a msg that quotes the monitor's URL has its credentials scrubbed.
        const heartbeatsArray = wantsSecrets(includeSecrets) ? raw : raw.map((hb) => redactHeartbeat(hb));

        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(heartbeatsArray, null, 2) 
          }],
          structuredContent: { 
            monitorID,
            heartbeats: heartbeatsArray,
            count: heartbeatsArray.length 
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get heartbeats: ${errorMessage}`
        );
      }
    }
  );

  // Register getSettings tool
  server.registerTool(
    'getSettings',
    {
      title: 'Get Settings',
      description: 'Retrieves the current Uptime Kuma server settings including timezone, authentication status, primary base URL, and other configuration options.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        settings: SettingsSchema.describe('Current Uptime Kuma server settings')
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const response = await client.getSettings();

        if (!response.data) {
          throw new Error('No settings data returned');
        }

        // SettingsSchema declares a safe subset, but the text content below stringifies
        // whatever Uptime Kuma actually sent — which includes steamAPIKey. Redacting the
        // object covers both channels; redacting only structuredContent would not.
        const settings = wantsSecrets(includeSecrets) ? response.data : redactSecrets(response.data);

        return {
          content: [{ type: 'text', text: JSON.stringify(settings, null, 2) }],
          structuredContent: { settings },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get settings: ${errorMessage}`
        );
      }
    }
  );

  // Register listAllHeartbeats tool
  server.registerTool(
    'listHeartbeats',
    {
      title: 'List Heartbeats',
      description: 'Retrieves historical heartbeat data for ALL monitors (response times, status changes over time). Use this for analyzing patterns across multiple monitors or correlating events. Beats are returned NEWEST-FIRST. By default returns only the most recent heartbeat per monitor; set maxHeartbeats (up to 100) for historical analysis. Keep maxHeartbeats ≤5 unless user requests more. Credentials embedded in a status message URL (user:pass@host) read "***" unless includeSecrets is set.',
      inputSchema: {
        maxHeartbeats: numeric(z.number().int().positive().max(100)).optional().describe('If set, returns the most recent X heartbeats per monitor (up to 100). If unset, returns only the most recent heartbeat per monitor (default: 1)'),
        limit: numeric(z.number().int().positive().max(100)).optional().describe('Alias for maxHeartbeats. Prefer maxHeartbeats.'),
        count: numeric(z.number().int().positive().max(100)).optional().describe('Alias for maxHeartbeats. Prefer maxHeartbeats.'),
        includeSecrets: includeSecretsParam
      },
      outputSchema: { 
        heartbeats: z.record(z.string(), z.array(HeartbeatSchema)).describe('Map of monitor IDs to their heartbeat arrays'),
        monitorCount: z.number(),
        totalHeartbeatCount: z.number()
      },
    },
    async ({ maxHeartbeats, limit, count: countAlias, includeSecrets }) => {
      await authenticateClient();

      try {
        const requested = [maxHeartbeats, limit, countAlias].filter((v) => v !== undefined);
        if (new Set(requested).size > 1) {
          throw new Error(
            `Conflicting values for maxHeartbeats and its aliases (${requested.join(', ')}) — pass only 'maxHeartbeats'.`
          );
        }
        const count = requested[0] ?? 1;
        const raw = client.getHeartbeatList(count);
        // Heartbeats are projected to their declared fields (dropping passthrough columns
        // like response) and a msg that quotes the monitor's URL has its credentials scrubbed.
        const heartbeatList = wantsSecrets(includeSecrets)
          ? raw
          : Object.fromEntries(
              Object.entries(raw).map(([id, beats]) => [id, beats.map((hb) => redactHeartbeat(hb))])
            );
        
        // Calculate total heartbeat count
        const totalCount = Object.values(heartbeatList).reduce(
          (sum, heartbeats) => sum + heartbeats.length, 
          0
        );
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(heartbeatList, null, 2) 
          }],
          structuredContent: { 
            heartbeats: heartbeatList,
            monitorCount: Object.keys(heartbeatList).length,
            totalHeartbeatCount: totalCount
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list heartbeats: ${errorMessage}`
        );
      }
    }
  );

  // Register pauseMonitor tool
  server.registerTool(
    'pauseMonitor',
    {
      title: 'Pause Monitor',
      description: 'Pauses a monitor, stopping it from performing checks. The monitor will remain in the system but will not send notifications or collect data until resumed.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to pause')
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional()
      },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        const response = await client.pauseMonitor(monitorID);
        
        return {
          content: [{ 
            type: 'text', 
            text: response.msg || `Monitor ${monitorID} paused successfully` 
          }],
          structuredContent: {
            ok: response.ok,
            msg: response.msg
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to pause monitor: ${errorMessage}`
        );
      }
    }
  );

  // Register resumeMonitor tool
  server.registerTool(
    'resumeMonitor',
    {
      title: 'Resume Monitor',
      description: 'Resumes a paused monitor, restarting all checks. Use this to re-enable monitoring after pausing.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to resume')
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional()
      },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        const response = await client.resumeMonitor(monitorID);
        
        return {
          content: [{ 
            type: 'text', 
            text: response.msg || `Monitor ${monitorID} resumed successfully` 
          }],
          structuredContent: {
            ok: response.ok,
            msg: response.msg
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to resume monitor: ${errorMessage}`
        );
      }
    }
  );

  // ─── Monitor write tools ──────────────────────────────────────────────────

  // Uptime Kuma's editMonitor handler reads these fields under camelCase names on the wire
  // (server/server.js: `bean.jsonPath = monitor.jsonPath`, `bean.pushToken = monitor.pushToken`,
  // …) while the database columns are snake_case (json_path, push_token). The snake_case
  // spellings are what the schema documentation, the database and issue #60 all use, so they
  // are the ones callers reach for first. Accept both and normalise onto the name Kuma reads,
  // rather than letting a reasonable guess silently do nothing.
  const MONITOR_FIELD_ALIASES: Record<string, string> = {
    json_path: 'jsonPath',
    json_path_operator: 'jsonPathOperator',
    expected_value: 'expectedValue',
    push_token: 'pushToken',
    database_connection_string: 'databaseConnectionString',
    database_query: 'databaseQuery',
    // Uptime Kuma's mysql monitor reads its password from the RADIUS column
    // (server/monitor-types/mysql.js: `monitor.radiusPassword`); nobody would guess that name.
    databasePassword: 'radiusPassword',
    // The snmp monitor reads its community string from the same column
    // (server/monitor-types/snmp.js: `snmp.createSession(monitor.hostname, monitor.radiusPassword, …)`).
    snmpCommunity: 'radiusPassword',
    // Fields editMonitor reads in camelCase and stores under a snake_case bean property
    // (`bean.save_response = monitor.saveResponse`), plus auth_method, which is the spelling
    // Uptime Kuma's own check code uses (server/model/monitor.js: `this.auth_method`).
    auth_method: 'authMethod',
    proxy_id: 'proxyId',
    save_response: 'saveResponse',
    save_error_response: 'saveErrorResponse',
    response_max_length: 'responseMaxLength',
    retry_only_on_status_code_failure: 'retryOnlyOnStatusCodeFailure',
  };

  // Types whose check is a connection to databaseConnectionString (#106). Without one, Uptime
  // Kuma creates the monitor and then fails every check against an empty connection string.
  const DATABASE_MONITOR_TYPES = new Set(['mysql', 'postgres', 'mongodb', 'redis', 'sqlserver', 'oracledb']);

  // A mongodb monitor's databaseQuery is a JSON command that Uptime Kuma JSON.parses on every
  // check, so a malformed one is accepted on save and then fails every beat.
  const assertMongoQueryIsJson = (type: unknown, query: unknown): void => {
    if (type !== 'mongodb' || query === undefined || query === null || query === '') return;
    try {
      const parsed = JSON.parse(String(query));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      throw new Error(
        'A mongodb databaseQuery must be a JSON command object, e.g. {"ping": 1} — Uptime Kuma JSON.parses it on every check.'
      );
    }
  };

  const normaliseMonitorAliases = (fields: Record<string, unknown>): Record<string, unknown> => {
    for (const [alias, canonical] of Object.entries(MONITOR_FIELD_ALIASES)) {
      if (!(alias in fields)) continue;
      if (canonical in fields && fields[canonical] !== fields[alias]) {
        throw new Error(
          `Conflicting values for ${canonical} (${JSON.stringify(fields[canonical])}) and its alias ${alias} (${JSON.stringify(fields[alias])}) — pass only '${canonical}'.`
        );
      }
      fields[canonical] = fields[alias];
      delete fields[alias];
    }
    return fields;
  };

  // Uptime Kuma generates push tokens in the browser (src/pages/EditMonitor.vue:
  // genSecret(pushTokenLength) with pushTokenLength = 32). Match its length and alphabet.
  const generatePushToken = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(32 * 2);
    let token = '';
    // Rejection sampling — modulo on a raw byte would bias the alphabet.
    const max = 256 - (256 % chars.length);
    for (let i = 0; token.length < 32 && i < bytes.length; i++) {
      if (bytes[i] < max) token += chars[bytes[i] % chars.length];
    }
    while (token.length < 32) token += chars[randomInt(0, chars.length)];
    return token;
  };

  // Uptime Kuma's own intent for an unset timeout is 0.8 x interval; only its unit handling is
  // wrong. Storing the value at creation means the buggy runtime fallback never runs.
  // push never polls and group has no request of its own, so both correctly keep 0.
  const defaultTimeoutForInterval = (type: string, interval?: number): number | undefined => {
    if (type === 'push' || type === 'group') return undefined;
    const seconds = Math.round((interval ?? 60) * 0.8 * 10) / 10;
    // Monitor.validate() rejects a ping timeout outside PING_GLOBAL_TIMEOUT_MIN/MAX (1..300).
    if (type === 'ping') return Math.min(Math.max(Math.round(seconds), 1), 300);
    return seconds;
  };

  // The web UI's form stores its "https://" placeholder in url for types that never use it.
  // "wss://" is the same placeholder for websocket-upgrade. An empty list (kafkaProducerBrokers,
  // rabbitmqNodes) names no target either.
  const isBlank = (v: unknown): boolean =>
    v === undefined ||
    v === null ||
    v === '' ||
    v === 'https://' ||
    v === 'http://' ||
    v === 'wss://' ||
    v === 'ws://' ||
    (Array.isArray(v) && v.length === 0);

  // Monitor.validate() checks none of these: a monitor missing one is saved and then fails
  // every check, which looks like a broken target rather than a broken config.
  const REQUIRED_MONITOR_FIELDS: Record<string, string[]> = {
    http: ['url'],
    keyword: ['url', 'keyword'],
    'json-query': ['url', 'jsonPath', 'jsonPathOperator', 'expectedValue'],
    port: ['hostname', 'port'],
    ping: ['hostname'],
    dns: ['hostname'],
    docker: ['docker_container', 'docker_host'],
    ...Object.fromEntries([...DATABASE_MONITOR_TYPES].map((t) => [t, ['databaseConnectionString']])),
    // #112. Each list is what the type's check dereferences with no fallback of its own
    // (server/monitor-types/*.js and the radius / kafka-producer branches of
    // server/model/monitor.js). A port the check defaults itself (radius 1812, snmp 161,
    // smtp 25, sftp 22, ntp 123) is not listed.
    mqtt: ['hostname', 'port', 'mqttTopic'],
    'grpc-keyword': ['grpcUrl', 'grpcProtobuf', 'grpcServiceName', 'grpcMethod', 'keyword'],
    'kafka-producer': ['kafkaProducerBrokers', 'kafkaProducerTopic', 'kafkaProducerMessage'],
    radius: ['hostname', 'radiusUsername', 'radiusPassword', 'radiusSecret'],
    rabbitmq: ['rabbitmqNodes'],
    smtp: ['hostname'],
    // radiusPassword is the community string here; see snmpCommunity in MONITOR_FIELD_ALIASES.
    snmp: ['hostname', 'snmpOid', 'radiusPassword', 'expectedValue'],
    gamedig: ['hostname', 'port', 'game'],
    steam: ['hostname', 'port'],
    'real-browser': ['url'],
    'websocket-upgrade': ['url'],
    sftp: ['hostname', 'sshUsername'],
    ntp: ['hostname'],
    'sip-options': ['hostname', 'port'],
    'tailscale-ping': ['hostname'],
    // Monitor.validate() does refuse these two, but only with "Service Name is required."
    'system-service': ['system_service_name'],
    pm2: ['system_service_name'],
  };

  // What the caller should pass for a required field, where that is not the stored name.
  const requiredFieldLabel = (type: string, field: string): string =>
    type === 'snmp' && field === 'radiusPassword' ? 'snmpCommunity' : field;

  // The types whose check sends HTTP credentials, and only those of `authMethod`
  // (server/model/monitor.js: `if (this.auth_method === "basic")`, …; websocket-upgrade.js and
  // globalping.js read the same fields). oracledb also reads basic_auth_user/pass, but as its
  // database login and with no authMethod, so it is deliberately absent.
  const HTTP_AUTH_MONITOR_TYPES = new Set(['http', 'keyword', 'json-query', 'websocket-upgrade', 'globalping']);

  // The credential fields each method sends. `needs` is what the method cannot work without.
  const HTTP_AUTH_METHODS: Record<string, { fields: string[]; needs: string[] }> = {
    basic: { fields: ['basic_auth_user', 'basic_auth_pass'], needs: ['basic_auth_user'] },
    ntlm: {
      fields: ['basic_auth_user', 'basic_auth_pass', 'authDomain', 'authWorkstation'],
      needs: ['basic_auth_user'],
    },
    bearer: { fields: ['bearer_token'], needs: ['bearer_token'] },
    'oauth2-cc': {
      fields: ['oauth_token_url', 'oauth_client_id', 'oauth_client_secret', 'oauth_scopes', 'oauth_audience', 'oauth_auth_method'],
      needs: ['oauth_token_url', 'oauth_client_id', 'oauth_client_secret'],
    },
    mtls: { fields: ['tlsCert', 'tlsKey', 'tlsCa'], needs: ['tlsCert', 'tlsKey'] },
  };

  // Which method a credential field implies when authMethod is not set. Tried in this order,
  // so basic_auth_user alongside authDomain means ntlm rather than basic.
  const HTTP_AUTH_INFERENCE: Array<[string, string[]]> = [
    ['ntlm', ['authDomain', 'authWorkstation']],
    ['basic', ['basic_auth_user', 'basic_auth_pass']],
    ['bearer', ['bearer_token']],
    ['oauth2-cc', ['oauth_token_url', 'oauth_client_id', 'oauth_client_secret']],
    ['mtls', ['tlsCert', 'tlsKey', 'tlsCa']],
  ];

  /**
   * Keeps HTTP credentials and `authMethod` in step (#112).
   *
   * Uptime Kuma stores every credential it is given and sends only the ones `authMethod`
   * names. So `bearer_token` on a monitor whose authMethod is null is saved, answered with
   * "Saved.", and never sent — the monitor then reports 401 against a correctly configured
   * target. The web form cannot produce that state, because its fields only appear once a
   * method is chosen; an API caller can.
   *
   * `sent` is what this call passed, `monitor` the full monitor about to be written and
   * `stored` the monitor as it was (absent on a create). Runs on every write that CHANGES an
   * auth field, not just on a type change, and never on one that does not: an unrelated edit,
   * or a credential echoed back unchanged, must not be refused over a monitor that was
   * already odd — the web form leaves the old method's credentials behind when it switches.
   *
   * Sets the inferred authMethod on `monitor` and returns it, so the caller can verify it.
   */
  const applyHttpAuthRules = (
    monitor: Record<string, unknown>,
    sent: Record<string, unknown>,
    stored?: Record<string, unknown>
  ): Record<string, unknown> => {
    if (!HTTP_AUTH_MONITOR_TYPES.has(String(monitor.type))) return {};
    const authFields = new Set(Object.values(HTTP_AUTH_METHODS).flatMap((m) => m.fields));
    const sentCredentials = Object.keys(sent).filter(
      (f) => authFields.has(f) && !isBlank(sent[f]) && sent[f] !== stored?.[f]
    );
    if (!('authMethod' in sent) && sentCredentials.length === 0) return {};
    // An explicit null is the caller turning authentication off.
    if ('authMethod' in sent && isBlank(sent.authMethod)) return {};

    const applied: Record<string, unknown> = {};
    if (isBlank(monitor.authMethod)) {
      const implied = HTTP_AUTH_INFERENCE.filter(([, fields]) => fields.some((f) => sentCredentials.includes(f)))
        .map(([method]) => method)
        // authDomain already settled basic-vs-ntlm in favour of ntlm.
        .filter((method, _i, all) => !(method === 'basic' && all.includes('ntlm')));
      if (implied.length === 0) {
        throw new Error(
          `${sentCredentials.join(', ')} ${sentCredentials.length > 1 ? 'do' : 'does'} nothing on a monitor with no authMethod. ` +
          'Pass authMethod along with the credentials it needs.'
        );
      }
      if (implied.length > 1) {
        throw new Error(
          `${sentCredentials.join(', ')} belong to different authentication methods (${implied.join(', ')}), and ` +
          'Uptime Kuma only sends the credentials of one. Pass authMethod to say which.'
        );
      }
      applied.authMethod = implied[0];
      monitor.authMethod = implied[0];
    }

    const method = String(monitor.authMethod);
    const spec = HTTP_AUTH_METHODS[method];
    // A method this server does not know (a newer Uptime Kuma) is left to Uptime Kuma.
    if (!spec) return applied;

    const ignored = sentCredentials.filter((f) => !spec.fields.includes(f));
    if (ignored.length > 0) {
      throw new Error(
        `This monitor's authMethod is '${method}', which does not send ${ignored.join(', ')} — Uptime Kuma would ` +
        `save ${ignored.length > 1 ? 'them' : 'it'} and never use ${ignored.length > 1 ? 'them' : 'it'}. ` +
        'Pass the authMethod those credentials belong to, or drop them.'
      );
    }
    const missing = spec.needs.filter((f) => isBlank(monitor[f]));
    if (missing.length > 0) {
      throw new Error(`authMethod '${method}' needs ${missing.join(', ')}.`);
    }
    return applied;
  };

  /**
   * Restores the `user:pass@` of a monitor `url` that a redacted read scrubbed.
   *
   * `rehydrateSecrets` only recognises a field whose whole value is "***"; here the marker sits
   * inside the URL, so without this an agent that reads a monitor and writes its `url` back
   * stores "***:***" as the login and the monitor starts answering 401. `stored` is undefined
   * on a create, where there is nothing to restore and the marker is refused.
   *
   * Returns whether credentials were restored, so the caller can say so.
   */
  const rehydrateMonitorUrl = (fields: Record<string, unknown>, stored: unknown): boolean => {
    if (typeof fields.url !== 'string') return false;
    const restored = rehydrateUrlCredentials(fields.url, typeof stored === 'string' ? stored : undefined);
    if (restored.hostChanged) {
      throw new Error(HOST_CHANGED_MARKER_ERROR('url', 'call getMonitor with includeSecrets'));
    }
    if (restored.missing) {
      throw new Error(
        '"***" in the url is the redaction marker, not a credential, and the monitor has no stored url ' +
        'credentials to restore it from. Pass the real credentials, or leave them out of the url.'
      );
    }
    fields.url = restored.value;
    return restored.preserved;
  };

  const inferredAuthNote = (method: unknown): string =>
    `\n\nSet authMethod to '${method}' to match the credentials passed — Uptime Kuma only sends the credentials of the method it has stored.`;

  /**
   * Restores the credentials of `rabbitmqNodes` entries that a redacted read scrubbed (#112).
   *
   * Each node is a URL, and `redactUrlCredentials` turns `https://user:pass@host` into
   * `https://***:***@host`. `rehydrateSecrets` skips arrays and only recognises a bare "***"
   * anyway, so without this the read-edit-write loop persists the marker as the login.
   * A node is matched to its stored counterpart by host and path, so reordering the list or
   * removing an entry does not hand one node another's credentials.
   */
  const rehydrateRabbitmqNodes = (fields: Record<string, unknown>, stored: unknown): void => {
    const nodes = fields.rabbitmqNodes;
    if (!Array.isArray(nodes)) return;
    const address = (node: unknown): string | undefined => {
      try {
        const url = new URL(String(node));
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return undefined;
      }
    };
    const storedNodes = Array.isArray(stored) ? stored.filter((n): n is string => typeof n === 'string') : [];
    fields.rabbitmqNodes = nodes.map((node) => {
      const at = address(node);
      const restored = rehydrateUrlCredentials(
        node as string,
        at === undefined ? undefined : storedNodes.find((s) => address(s) === at)
      );
      if (restored.missing) {
        throw new Error(
          `"***" in the rabbitmqNodes entry for ${at ?? 'an unparseable URL'} is the redaction marker, not a credential, ` +
          'and there is no stored node at that address to restore it from. Pass the real credentials, or use ' +
          'rabbitmqUsername and rabbitmqPassword instead.'
        );
      }
      return restored.value;
    });
  };

  const pushURLFor = (token: unknown): string => {
    // A loop, not /\/+$/: that pattern backtracks quadratically on a long run of slashes.
    let end = config.url.length;
    while (end > 0 && config.url[end - 1] === '/') end--;
    return `${config.url.slice(0, end)}/api/push/${token}?status=up&msg=OK&ping=`;
  };

  /**
   * What a monitor must satisfy to be of its type, for a create and for a type change alike.
   * Uptime Kuma applies the defaults in its web form (src/pages/EditMonitor.vue, the
   * "monitor.type" watcher) and never on the server, so an API caller gets none of them.
   *
   * Sets the defaults on `monitor` and returns them, so the caller can verify they were stored.
   */
  const applyMonitorTypeRules = (
    monitor: Record<string, unknown>,
    timeoutIsCallers: boolean
  ): Record<string, unknown> => {
    const type = String(monitor.type);
    if (!MONITOR_TYPE_NAMES.has(type)) {
      throw new Error(`Unknown monitor type '${type}'. Use listMonitorTypes for the valid types.`);
    }

    const applied: Record<string, unknown> = {};
    const required = [...(REQUIRED_MONITOR_FIELDS[type] ?? [])];
    if (type === 'globalping') {
      // The form's default; the check switches on it and does nothing at all for a blank one.
      if (isBlank(monitor.subtype)) applied.subtype = 'ping';
      if (isBlank(monitor.location)) applied.location = 'world';
      required.push((applied.subtype ?? monitor.subtype) === 'http' ? 'url' : 'hostname');
    }
    if (type === 'sftp') {
      required.push(monitor.sshAuthMethod === 'privateKey' ? 'sshPrivateKey' : 'sshPassword');
    }

    const missing = required.filter((f) => isBlank(monitor[f])).map((f) => requiredFieldLabel(type, f));
    if (missing.length > 0) {
      throw new Error(
        `A ${type} monitor needs ${missing.join(', ')}. Without ${missing.length > 1 ? 'them' : 'it'} ` +
        `Uptime Kuma saves the monitor and then fails every check. getMonitorTypeFields {"type": "${type}"} describes each field.`
      );
    }
    assertMongoQueryIsJson(type, monitor.databaseQuery);

    if (type === 'websocket-upgrade') {
      if (!/^wss?:\/\//i.test(String(monitor.url))) {
        throw new Error('A websocket-upgrade monitor needs a ws:// or wss:// url.');
      }
      // "Accepted status codes" are WebSocket close codes for this type, and the form swaps
      // the HTTP default for 1000 (normal closure). Left at 200-299 no handshake ever passes.
      const codes = monitor.accepted_statuscodes;
      if (isBlank(codes) || (Array.isArray(codes) && codes.length === 1 && codes[0] === '200-299')) {
        applied.accepted_statuscodes = ['1000'];
      }
    }
    // The check does JSON.parse(kafkaProducerSaslOptions).mechanism, and an unset column
    // parses to null — so a producer created without SASL options throws on every check.
    if (type === 'kafka-producer' && isBlank(monitor.kafkaProducerSaslOptions)) {
      applied.kafkaProducerSaslOptions = { mechanism: 'None' };
    }
    if (type === 'snmp') {
      // The form's defaults: compare the OID's value itself for equality.
      if (isBlank(monitor.snmpVersion)) applied.snmpVersion = '2c';
      if (isBlank(monitor.jsonPath)) applied.jsonPath = '$';
      if (isBlank(monitor.jsonPathOperator)) applied.jsonPathOperator = '==';
    }
    // Without a token a push monitor has no ping URL and can never report, while looking
    // identical to one that is merely awaiting its first beat.
    if (type === 'push' && !monitor.pushToken) applied.pushToken = generatePushToken();
    if (type === 'dns') {
      if (isBlank(monitor.dns_resolve_server)) applied.dns_resolve_server = '1.1.1.1';
      if (isBlank(monitor.dns_resolve_type)) applied.dns_resolve_type = 'A';
    }
    // Never leave timeout at 0 — see the schema description for why that is a ~13 hour
    // timeout rather than a default.
    if (!timeoutIsCallers && type !== 'push' && type !== 'group') {
      const stored = Number(monitor.timeout) || 0;
      if (!stored) {
        applied.timeout = defaultTimeoutForInterval(type, monitor.interval as number | undefined);
      } else if (type === 'ping') {
        const inRange = Math.min(Math.max(Math.round(stored), 1), 300);
        if (inRange !== stored) applied.timeout = inRange;
      }
    }

    Object.assign(monitor, applied);
    return applied;
  };

  const asText = (v: unknown): string | null =>
    v === null || v === undefined || v === '' ? null : String(v);
  const asNumber = (v: unknown): number | null =>
    v === null || v === undefined || v === '' ? null : Number(v);

  // Lists and objects Uptime Kuma stores as JSON text and parses again on read.
  const asJson = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

  const TYPE_FIELD_HINT = 'See #112 — the monitor\'s check depends on this field.';

  // Uptime Kuma answers a boolean column as true/false from toJSON() and 0/1 from a raw row.
  const asFlag = (v: unknown): number => (v ? 1 : 0);

  interface VerifiedField {
    read: (v: unknown) => string | number | null;
    equals?: (wanted: string | number | null, stored: string | number | null) => boolean;
    /** Never put this field's value in an error message — it is a credential. */
    secret?: boolean;
    hint: string;
  }

  /**
   * The fields where a write that quietly does not land is dangerous: it either produces a
   * monitor that silently cannot report (timeout, pushToken, the json-query triple) or loses
   * information with no error (description, parent).
   *
   * These are exactly the fields #58, #60 and #63 were filed about. Declaring them in the
   * schema stops them being stripped; reading them back is what proves they were stored.
   */
  const VERIFIED_MONITOR_FIELDS: Record<string, VerifiedField> = {
    parent: {
      read: asNumber,
      hint: 'Uptime Kuma rejects a parent that is one of this monitor\'s own descendants, and the parent must be a monitor of type "group".',
    },
    description: {
      read: asText,
      hint: 'See #58 — the class of bug where the field is accepted and written as NULL.',
    },
    timeout: {
      read: asNumber,
      // Monitor.validate() rounds a ping timeout to whole seconds, so 47.5 -> 48 is correct
      // rather than a failure. Anything else must match exactly.
      equals: (wanted, stored) =>
        wanted === stored ||
        (typeof wanted === 'number' && typeof stored === 'number' && Math.round(wanted) === stored),
      hint: 'timeout is stored in SECONDS, and a stored 0 is not "no timeout": Uptime Kuma\'s runtime fallback turns it into ~13 hours, so the monitor can never report DOWN against a black-holed endpoint.',
    },
    type: {
      read: asText,
      hint: 'See #110.',
    },
    jsonPath: { read: asText, hint: 'See #60.' },
    jsonPathOperator: { read: asText, hint: 'See #60.' },
    expectedValue: { read: asText, hint: 'See #60 — the threshold is stored as a string.' },
    pushToken: {
      read: asText,
      secret: true,
      hint: 'See #60 — a push monitor with no token has no ping URL and can never report, while looking identical to one merely awaiting its first beat.',
    },
    databaseConnectionString: {
      read: asText,
      secret: true,
      hint: 'See #106 — a database monitor with no connection string fails every check.',
    },
    databaseQuery: { read: asText, hint: 'See #106.' },
    radiusPassword: { read: asText, secret: true, hint: 'See #106 — the mysql monitor reads its password from this field.' },
    ...Object.fromEntries(
      [
        'basic_auth_user', 'oauth_token_url',
        'mqttTopic', 'mqttUsername',
        'grpcUrl', 'grpcServiceName', 'grpcMethod',
        'kafkaProducerTopic',
        'radiusUsername',
        'rabbitmqUsername',
        'snmpOid', 'snmpVersion',
        'game',
        'subtype', 'location',
        'sshUsername', 'sshAuthMethod',
      ].map((f) => [f, { read: asText, hint: TYPE_FIELD_HINT }])
    ),
    ...Object.fromEntries(
      [
        'basic_auth_pass', 'bearer_token', 'oauth_client_id', 'oauth_client_secret',
        'tlsCert', 'tlsKey', 'tlsCa',
        'mqttPassword',
        'radiusSecret',
        'rabbitmqPassword',
        'gamedigToken',
        'sshPassword', 'sshPrivateKey', 'sshPassphrase',
      ].map((f) => [f, { read: asText, secret: true, hint: TYPE_FIELD_HINT }])
    ),
    authMethod: {
      read: asText,
      hint: 'See #112 — Uptime Kuma only sends the credentials of the stored authMethod, so without it the monitor makes unauthenticated requests.',
    },
    proxyId: { read: asNumber, hint: 'See #112 — the proxy must exist in Uptime Kuma.' },
    // Monitor.validate() trims it.
    system_service_name: { read: (v) => asText(typeof v === 'string' ? v.trim() : v), hint: TYPE_FIELD_HINT },
    kafkaProducerBrokers: { read: asJson, hint: TYPE_FIELD_HINT },
    kafkaProducerSaslOptions: { read: asJson, secret: true, hint: TYPE_FIELD_HINT },
    // Entries can carry user:pass@ inline.
    rabbitmqNodes: { read: asJson, secret: true, hint: TYPE_FIELD_HINT },
    conditions: { read: asJson, hint: TYPE_FIELD_HINT },
    expiryNotification: { read: asFlag, hint: 'See #110.' },
    domainExpiryNotification: {
      read: asFlag,
      hint: 'See #110 — domain expiry monitoring needs Uptime Kuma 2.1 or later.',
    },
  };

  /**
   * Reads the monitor back after a write and proves the fields above actually landed.
   *
   * `{"ok":true,"msg":"Saved."}` means the socket call returned, not that your field was
   * stored — Uptime Kuma answers that for any edit it accepts, including one that changed
   * nothing. That is the whole reason #58/#60/#63 were each filed as separate bugs: there is
   * nothing in the response to tell a partial write from a complete one.
   *
   * Uses `fetchMonitor()` (Kuma's `getMonitor` handler, which reads the DB) and NOT
   * `getMonitor()` (which serves `monitorListCache`, refreshed by pushed events that can
   * arrive after this write's callback resolved — so it can echo a write that never happened).
   *
   * Returns the problem as a string rather than throwing: by the time this runs the write has
   * already happened, so the caller still has to report the monitorID and any generated push
   * token. Throwing from here would unwind into the handler's catch, which reports "Failed to
   * create monitor" and returns no structured content at all — see the call sites.
   */
  const verifyMonitorWrite = async (
    monitorID: number,
    requested: Record<string, unknown>,
    operation: string
  ): Promise<string | null> => {
    const fields = Object.keys(VERIFIED_MONITOR_FIELDS).filter((f) => f in requested);
    if (fields.length === 0) return null;

    let fresh: Record<string, unknown>;
    try {
      fresh = await client.fetchMonitor(monitorID);
    } catch (verifyError) {
      const m = verifyError instanceof Error ? verifyError.message : String(verifyError);
      return (
        `Monitor ${monitorID} was ${operation}, but the write of ${fields.join(', ')} could NOT be verified: ${m}. ` +
        'Do not assume it applied — check the monitor before relying on it.'
      );
    }

    const mismatches: string[] = [];
    for (const field of fields) {
      const spec = VERIFIED_MONITOR_FIELDS[field];
      const wanted = spec.read(requested[field]);
      const stored = spec.read(fresh[field]);
      if (spec.equals ? spec.equals(wanted, stored) : wanted === stored) continue;

      mismatches.push(
        spec.secret
          ? `${field}: sent a ${wanted === null ? 'null' : `${String(wanted).length}-character`} value, server reports ` +
            `${stored === null ? 'nothing stored' : `a different ${String(stored).length}-character value`} ` +
            `(value withheld — it is a credential). ${spec.hint}`
          : `${field}: asked for ${JSON.stringify(wanted)}, server reports ${JSON.stringify(stored)}. ${spec.hint}`
      );
    }

    if (mismatches.length > 0) {
      return (
        `Monitor ${monitorID} was ${operation} and Uptime Kuma acknowledged it, but the following did NOT persist:\n` +
        `  - ${mismatches.join('\n  - ')}\n` +
        'Uptime Kuma answers "Saved." for any edit it accepts, including one that changed nothing.'
      );
    }

    return null;
  };

  // Hoisted out of the registration so getMonitorTypeFields can read the descriptions of the
  // fields declared here (url, hostname, port, …) instead of keeping a second copy of them.
  const createMonitorShape = {
    name: z.string().describe('Display name for the monitor'),
    type: z.string().describe('Monitor type (e.g. http, port, ping, dns, push, keyword). Use listMonitorTypes for all options.'),
    description: z.string().nullable().optional().describe('Free-text description shown on the monitor page'),
    active: z.boolean().optional().describe('Whether the monitor starts checking immediately (default: true). Pass false to create it paused.'),
    resendInterval: numeric(z.number()).optional().describe('Resend notification every N checks while down (0 = disabled, the default)'),
    timeout: numeric(z.number()).nullable().optional().describe('Request timeout in SECONDS. Omit for 0.8 x interval. Avoid 0: Uptime Kuma\'s runtime fallback for a stored 0 computes interval * 1000 * 0.8 and then multiplies by 1000 again, yielding a ~13 hour timeout, so the monitor can never report DOWN against a host that accepts the connection and never answers.'),
    jsonPath: z.string().optional().describe('JSONata expression for json-query monitors. Must resolve to a primitive.'),
    json_path: z.string().optional().describe('Alias for jsonPath (the database column name). Prefer jsonPath.'),
    jsonPathOperator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Comparison operator for json-query monitors. UP while value <operator> expectedValue.'),
    json_path_operator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Alias for jsonPathOperator. Prefer jsonPathOperator.'),
    expectedValue: z.coerce.string().optional().describe('Threshold the json-query result is compared against. Stored as a string.'),
    expected_value: z.coerce.string().optional().describe('Alias for expectedValue. Prefer expectedValue.'),
    pushToken: z.string().min(8).optional().describe('Push token for push monitors — the secret in the ping URL. Omit and one is generated and returned.'),
    push_token: z.string().min(8).optional().describe('Alias for pushToken (the database column name). Prefer pushToken.'),
    url: z.string().optional().describe('URL to monitor (required for http, keyword and json-query; other types that need it are listed by getMonitorTypeFields)'),
    hostname: z.string().optional().describe('Hostname or IP address to check (required for port, ping and dns, and most non-HTTP types — see getMonitorTypeFields)'),
    port: numeric(z.number()).optional().describe('Port number (required for port; see getMonitorTypeFields for other types)'),
    interval: numeric(z.number().min(1)).optional().describe('Check interval in seconds (default: 60, min: 1)'),
    retryInterval: numeric(z.number().min(1)).optional().describe('Retry interval in seconds when monitor is down (default: 60, min: 1)'),
    maxretries: numeric(z.number()).optional().describe('Max retries before marking as down (default: 0)'),
    notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Map of notification IDs to enable (e.g. {"1": true, "3": true})'),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string().optional(),
      color: z.string().optional(),
    })).optional().describe('Tags to assign to the monitor'),
    keyword: z.string().optional().describe('Keyword to search for (keyword monitor type)'),
    invertKeyword: z.boolean().optional().describe('Invert keyword match'),
    method: z.string().optional().describe('HTTP method (GET, POST, etc.) for http type'),
    body: z.string().optional().describe('HTTP request body'),
    headers: z.string().optional().describe('HTTP headers as JSON string'),
    accepted_statuscodes: z.array(z.string()).optional().describe('Accepted HTTP status codes (e.g. ["200-299"])'),
    ignoreTls: z.boolean().optional().describe('Ignore TLS/SSL errors'),
    maxredirects: numeric(z.number()).optional().describe('Max HTTP redirects (default: 10)'),
    upsideDown: z.boolean().optional().describe('Invert status — treat up as down'),
    expiryNotification: z.boolean().optional().describe('Notify before the TLS certificate expires (HTTP-based types)'),
    domainExpiryNotification: z.boolean().optional().describe('Notify before the domain registration expires. Needs Uptime Kuma 2.1 or later.'),
    parent: numeric(z.number()).nullable().optional().describe('Parent group monitor ID'),
    docker_container: z.string().optional().describe('Docker container name (required for docker type)'),
    docker_host: numeric(z.number()).optional().describe('Docker host ID (required for docker type). Use listDockerHosts to find available IDs.'),
    dns_resolve_server: z.string().optional().describe('DNS server to use for resolution (required for dns type, default: 1.1.1.1)'),
    dns_resolve_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'CAA']).optional().describe('DNS record type to query (required for dns type, default: A)'),
    databaseConnectionString: z.string().optional().describe('Connection string for mysql, postgres, mongodb, redis, sqlserver and oracledb monitors (required for those types). For oracledb the login goes in basic_auth_user and basic_auth_pass. A credential: read tools return it as "***" unless includeSecrets is set.'),
    database_connection_string: z.string().optional().describe('Alias for databaseConnectionString (the database column name). Prefer databaseConnectionString.'),
    databaseQuery: z.string().optional().describe('Query for database monitors. SQL for mysql, postgres and sqlserver (default: SELECT 1); a JSON command object for mongodb (default: {"ping": 1}).'),
    database_query: z.string().optional().describe('Alias for databaseQuery (the database column name). Prefer databaseQuery.'),
    databasePassword: z.string().optional().describe('Password for mysql monitors, if not inline in the connection string. Stored by Uptime Kuma as radiusPassword. A credential: read tools return it as "***".'),
    radiusPassword: z.string().optional().describe('The RADIUS password (required for radius). Also the column databasePassword and typeFields.snmpCommunity are stored in — prefer those names for mysql and snmp.'),
    typeFields: z.record(z.string(), z.unknown()).optional().describe(TYPE_FIELDS_DESCRIPTION),
  };

  // Which defaults this server fills in, and which fields depend on another field's value.
  // Everything here restates a rule enforced in applyMonitorTypeRules / applyHttpAuthRules.
  const MONITOR_TYPE_NOTES: Record<string, string[]> = {
    dns: ['dns_resolve_server defaults to 1.1.1.1 and dns_resolve_type to A.'],
    push: ['pushToken is generated when omitted, and the ping URL is returned by the call that creates the monitor.'],
    group: ['A group has no check of its own. Put monitors in it with their parent field.'],
    mqtt: [
      'hostname is the broker, e.g. mqtt://broker.example.com, mqtts://… or ws://… for MQTT over WebSocket.',
      'With mqttCheckType "json-query" the message is tested with jsonPath and expectedValue.',
    ],
    'kafka-producer': ['kafkaProducerSaslOptions defaults to { mechanism: "None" }.'],
    snmp: [
      'The value at snmpOid is compared using jsonPath, jsonPathOperator and expectedValue, which default to "$" and "==" — i.e. the value must equal expectedValue.',
      'snmpVersion defaults to 2c. SNMPv3 cannot be configured through this server.',
    ],
    'websocket-upgrade': [
      'url must be ws:// or wss://.',
      'accepted_statuscodes are WebSocket close codes for this type and default to ["1000"].',
    ],
    globalping: [
      'subtype defaults to "ping" and location to "world".',
      'subtype "ping" and "dns" require hostname; subtype "http" requires url instead.',
    ],
    sftp: ['sshAuthMethod "password" (the default) requires sshPassword; "privateKey" requires sshPrivateKey.'],
    mongodb: ['databaseQuery must be a JSON command object, e.g. {"ping": 1}.'],
    oracledb: ['The login goes in basic_auth_user and basic_auth_pass, not in the connection string.'],
    manual: ['manual_status is not returned by Uptime Kuma, so it cannot be read back.'],
    'system-service': ['Checks a service on the machine Uptime Kuma itself runs on.'],
    pm2: ['Checks a PM2 process on the machine Uptime Kuma itself runs on.'],
  };

  const describeMonitorField = (name: string) => {
    const inTypeFields = MONITOR_TYPE_FIELD_NAMES.includes(name);
    const schema = inTypeFields
      ? (TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS as Record<string, z.ZodTypeAny>)[name]
      : (createMonitorShape as Record<string, z.ZodTypeAny>)[name];
    const description =
      (MONITOR_FIELD_DOCS as Record<string, string>)[name] ?? schema?.description ?? '';
    // Type and allowed values, without the description the entry already carries.
    let accepts: Record<string, unknown> = {};
    try {
      const { description: _d, $schema: _s, ...rest } = z.toJSONSchema(schema, {
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>;
      accepts = normalizeAdvertisedSchema(rest) as Record<string, unknown>;
    } catch {
      // Described in words only.
    }
    return { name, in: inTypeFields ? 'typeFields' : 'top-level', description, accepts };
  };

  const MonitorFieldDescription = z.object({
    name: z.string(),
    in: z.enum(['top-level', 'typeFields']).describe('Where to pass it: as an argument of createMonitor / updateMonitor, or inside their typeFields object'),
    description: z.string(),
    accepts: z.record(z.string(), z.unknown()).describe('JSON Schema of the value: its type and any allowed values'),
  });

  server.registerTool(
    'getMonitorTypeFields',
    {
      title: 'Get Monitor Type Fields',
      description: 'Describes the fields one monitor type uses: which are required, which are optional, what each means and accepts, and the defaults applied when they are omitted. Call this before createMonitor, or before updateMonitor changes a type or sets type-specific fields: most of them go in the typeFields argument of those tools, which is not described there.',
      inputSchema: {
        type: z.string().describe('The monitor type, e.g. http, mqtt, snmp. Use listMonitorTypes for all options.'),
      },
      outputSchema: {
        type: z.string(),
        description: z.string().describe('What this monitor type checks'),
        required: z.array(MonitorFieldDescription).describe('Fields a monitor of this type cannot work without. A create or type change without them is refused.'),
        optional: z.array(MonitorFieldDescription).describe('Other fields this type uses'),
        notes: z.array(z.string()).describe('Defaults applied when a field is omitted, and fields that become required depending on another'),
        commonFields: z.array(z.string()).describe('Fields every monitor type accepts, described on createMonitor'),
      },
    },
    async ({ type }) => {
      const known = MONITOR_TYPES.find((t) => t.type === type);
      if (!known) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown monitor type '${type}'. Use listMonitorTypes for the valid types.`
        );
      }

      const required = (REQUIRED_MONITOR_FIELDS[type] ?? []).map((f) => requiredFieldLabel(type, f));
      const notes = [...(MONITOR_TYPE_NOTES[type] ?? [])];
      if (HTTP_AUTH_MONITOR_TYPES.has(type)) {
        notes.push(
          'Authentication: Uptime Kuma only sends the credentials of the stored authMethod. Pass authMethod, or pass ' +
          'the credentials of one method and it is set to match. ' +
          Object.entries(HTTP_AUTH_METHODS)
            .filter(([, spec]) => spec.fields.every((f) => MONITOR_TYPE_FIELDS[type].includes(f)))
            .map(([method, spec]) => `"${method}" requires ${spec.needs.join(' and ')}`)
            .join('; ') + '.'
        );
      }
      if (type !== 'push' && type !== 'group') {
        notes.push('timeout defaults to 0.8 x interval seconds.');
      }

      const structuredContent = {
        type,
        description: known.description,
        required: required.map(describeMonitorField),
        optional: MONITOR_TYPE_FIELDS[type].filter((f) => !required.includes(f)).map(describeMonitorField),
        notes,
        commonFields: COMMON_MONITOR_FIELDS,
      };
      return {
        // Not indented, unlike the other tools: this is read by a model on its way to a write,
        // and indentation alone is a third of the size.
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
  );

  server.registerTool(
    'createMonitor',
    {
      title: 'Create Monitor',
      description: 'Creates a new monitor in Uptime Kuma. Requires at minimum a name and type. Use listMonitorTypes to see supported types. For HTTP monitors include url; for TCP/port monitors include hostname and port; for ping and dns include hostname; for json-query include url, jsonPath, jsonPathOperator and expectedValue; for database types (mysql, postgres, mongodb, redis, sqlserver, oracledb) include databaseConnectionString. For any other type, and for anything type-specific such as HTTP authentication, call getMonitorTypeFields first: it lists the required and optional fields of the type, what each means, and whether it is passed at the top level or inside typeFields. A create without the required fields of its type is refused rather than saved as a monitor that fails every check. For an HTTP monitor behind authentication pass the credentials in typeFields (basic_auth_user and basic_auth_pass, or bearer_token) and authMethod is set to match. Never pass "***" for a credential. A push monitor is given a generated push token (Uptime Kuma only generates one in its own web UI) and the resulting ping URL is returned. timeout defaults to 0.8 x interval seconds for polled types.',
      inputSchema: createMonitorShape,
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
        pushToken: z.string().optional().describe('Push monitors only. The token, so the sender can be wired up without a second, wider read.'),
        pushURL: z.string().optional().describe('Push monitors only. The URL the sender should GET.'),
        timeout: z.number().optional().describe('The timeout in seconds actually stored, including the default applied when omitted.'),
        authMethod: z.string().optional().describe('Only when authMethod was inferred from the credentials passed. The method that was stored.'),
      },
    },
    async (input) => {
      await authenticateClient();

      try {
        const defaults: Record<string, unknown> = {
          notificationIDList: {} as Record<string, boolean>,
          accepted_statuscodes: ['200-299'],
          conditions: [] as string[],
          retryInterval: 60,
        };

        // typeFields is flattened into the monitor here: Uptime Kuma's payload is one flat object.
        const { typeFields, ...topLevel } = input as Record<string, unknown>;
        const requested = normaliseMonitorAliases({
          ...topLevel,
          ...parseTypeFields(typeFields, Object.keys(createMonitorShape)),
        });

        // Issue #59: nothing to restore on a create, so the redaction marker must be refused
        // rather than persisted — writing "***" produces a credential that looks set and can
        // never work. Reached by copying a redacted monitor to make a similar one.
        const markers = rehydrateSecrets(requested, undefined).missing;
        if (markers.length > 0) {
          throw new Error(
            `"***" is the redaction marker, not a credential — pass the real value for ${markers.join(', ')}, or omit the field.`
          );
        }

        // Same refusal for a marker inside a rabbitmqNodes URL, which the check above cannot see.
        rehydrateRabbitmqNodes(requested, undefined);
        rehydrateMonitorUrl(requested, undefined);

        if (requested.timeout === null) delete requested.timeout;
        const applied = applyMonitorTypeRules(requested, requested.timeout !== undefined);
        const authApplied = applyHttpAuthRules(requested, requested);
        const generatedPushToken = 'pushToken' in applied;

        const monitorData = {
          ...defaults,
          ...requested,
        };
        const response = await client.createMonitor(monitorData as Record<string, unknown>);

        // Prove the dangerous fields actually landed, rather than trusting "Saved."
        const verifyProblem =
          response.monitorID !== undefined
            ? await verifyMonitorWrite(response.monitorID, requested, 'created')
            : null;

        const structuredContent: Record<string, unknown> = {
          ok: response.ok,
          monitorID: response.monitorID,
          msg: response.msg,
        };
        if (requested.timeout !== undefined) structuredContent.timeout = Number(requested.timeout);

        let text = response.msg || `Monitor created with ID ${response.monitorID}`;
        if (authApplied.authMethod) {
          structuredContent.authMethod = authApplied.authMethod;
          text += inferredAuthNote(authApplied.authMethod);
        }
        if (requested.type === 'push' && requested.pushToken) {
          structuredContent.pushToken = requested.pushToken;
          structuredContent.pushURL = pushURLFor(requested.pushToken);
          text += `\n\nPush monitor ${response.monitorID}: point the sender at (GET, not POST)\n  ${structuredContent.pushURL}\nThis URL contains a secret — treat it as a credential.${generatedPushToken ? ' The token was generated because Uptime Kuma only ever generates one in its own web UI.' : ''}`;
        }

        if (verifyProblem) {
          // The monitor was created — the write is what could not be confirmed. Say so
          // explicitly and keep the whole payload: a caller told only "failed" retries and
          // ends up with two monitors, and for a push monitor the token above is the only
          // copy outside the database, since Uptime Kuma never generated it server-side.
          return {
            content: [
              {
                type: 'text',
                text:
                  `${verifyProblem}\n\nMonitor ${response.monitorID} EXISTS — do not create it again. ` +
                  `Fix it with updateMonitor, or delete it with deleteMonitor ${response.monitorID}.\n\n${text}`,
              },
            ],
            structuredContent,
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create monitor: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateMonitor',
    {
      title: 'Update Monitor',
      description: 'Updates an existing monitor configuration. You must include the monitorID. Only the fields you provide will be changed (the server merges your changes with the existing config). Use getMonitor first to get the current config. Passing a different type converts the monitor in place, keeping its ID and history: the new type must have the fields it needs, passed here or already stored (e.g. url for http, hostname for ping), and a monitor becoming push is given a push token if it has none. Type-specific fields go in typeFields; call getMonitorTypeFields for their names and meanings. Credentials read back as "***"; sending "***" keeps the stored value.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to update'),
        // `parent` was declared on createMonitor but not here, so an existing monitor could
        // never be moved into or out of a group (issue #63). The merge below then folded the
        // old value back in and Uptime Kuma replied "Saved." — a no-op reported as success.
        parent: numeric(z.number().int()).nullable().optional().describe('Parent group monitor ID — re-parents this monitor into that group. Pass null to move it to the top level.'),
        parentID: numeric(z.number().int()).nullable().optional().describe('Alias for parent. Prefer parent.'),
        parent_id: numeric(z.number().int()).nullable().optional().describe('Alias for parent. Prefer parent.'),
        description: z.string().nullable().optional().describe('Free-text description shown on the monitor page'),
        // editMonitor assigns bean.type = monitor.type.
        type: z.string().optional().describe('Change the monitor type in place (e.g. ping -> http), keeping its ID, history and notifications. Pass the fields the new type needs in the same call (e.g. url for http). A group cannot be converted. Use listMonitorTypes for all options.'),
        resendInterval: numeric(z.number()).optional().describe('Resend notification every N checks while down (0 = disabled)'),
        timeout: numeric(z.number()).nullable().optional().describe('Request timeout in SECONDS. Avoid 0 — Uptime Kuma\'s runtime fallback for a stored 0 yields a ~13 hour timeout, so the monitor can never report DOWN against a black-holed endpoint.'),
        jsonPath: z.string().optional().describe('JSONata expression for json-query monitors. Must resolve to a primitive.'),
        json_path: z.string().optional().describe('Alias for jsonPath (the database column name). Prefer jsonPath.'),
        jsonPathOperator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Comparison operator for json-query monitors.'),
        json_path_operator: z.enum(['>', '>=', '<', '<=', '==', '!=', 'contains']).optional().describe('Alias for jsonPathOperator. Prefer jsonPathOperator.'),
        expectedValue: z.coerce.string().optional().describe('Threshold the json-query result is compared against, stored as a string.'),
        expected_value: z.coerce.string().optional().describe('Alias for expectedValue. Prefer expectedValue.'),
        pushToken: z.string().min(8).optional().describe('Push token — the secret in the ping URL. Changing it invalidates the existing URL and any sender still using it stops beating.'),
        push_token: z.string().min(8).optional().describe('Alias for pushToken (the database column name). Prefer pushToken.'),
        name: z.string().optional().describe('Display name'),
        url: z.string().optional().describe('URL to monitor'),
        hostname: z.string().optional().describe('Hostname'),
        port: numeric(z.number()).optional().describe('Port number'),
        interval: numeric(z.number().min(1)).optional().describe('Check interval in seconds (min: 1)'),
        retryInterval: numeric(z.number().min(1)).optional().describe('Retry interval in seconds (min: 1)'),
        maxretries: numeric(z.number()).optional().describe('Max retries before marking as down'),
        notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Notification ID map'),
        tags: z.array(z.object({
          name: z.string(),
          value: z.string().optional(),
          color: z.string().optional(),
        })).optional().describe('Tags to assign'),
        keyword: z.string().optional().describe('Keyword to search for'),
        invertKeyword: z.boolean().optional().describe('Invert keyword match'),
        method: z.string().optional().describe('HTTP method'),
        body: z.string().optional().describe('HTTP request body'),
        headers: z.string().optional().describe('HTTP headers as JSON string'),
        accepted_statuscodes: z.array(z.string()).optional().describe('Accepted HTTP status codes'),
        ignoreTls: z.boolean().optional().describe('Ignore TLS/SSL errors'),
        maxredirects: numeric(z.number()).optional().describe('Max HTTP redirects'),
        upsideDown: z.boolean().optional().describe('Invert status'),
        expiryNotification: z.boolean().optional().describe('Notify before the TLS certificate expires (HTTP-based types)'),
        domainExpiryNotification: z.boolean().optional().describe('Notify before the domain registration expires. Needs Uptime Kuma 2.1 or later.'),
        active: z.boolean().optional().describe('Whether the monitor is active'),
        docker_container: z.string().optional().describe('Docker container name (required for docker type)'),
        docker_host: numeric(z.number()).optional().describe('Docker host ID (required for docker type). Use listDockerHosts to find available IDs.'),
        dns_resolve_server: z.string().optional().describe('DNS server to use for resolution (for dns type)'),
        dns_resolve_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'CAA']).optional().describe('DNS record type to query (for dns type)'),
        databaseConnectionString: z.string().optional().describe('Connection string for mysql, postgres, mongodb, redis, sqlserver and oracledb monitors. A credential: read tools return "***", and sending "***" back keeps the stored value.'),
        database_connection_string: z.string().optional().describe('Alias for databaseConnectionString (the database column name). Prefer databaseConnectionString.'),
        databaseQuery: z.string().optional().describe('Query for database monitors. SQL for mysql, postgres and sqlserver; a JSON command object for mongodb.'),
        database_query: z.string().optional().describe('Alias for databaseQuery (the database column name). Prefer databaseQuery.'),
        databasePassword: z.string().optional().describe('Password for mysql monitors, stored by Uptime Kuma as radiusPassword. Sending "***" back keeps the stored value.'),
        radiusPassword: z.string().optional().describe('The RADIUS password (required for radius). Also the column databasePassword and typeFields.snmpCommunity are stored in — prefer those names for mysql and snmp.'),
        typeFields: z.record(z.string(), z.unknown()).optional().describe(TYPE_FIELDS_DESCRIPTION),
      },
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
        pushToken: z.string().optional().describe('Only when the type was changed to push. The token, generated if the monitor had none.'),
        pushURL: z.string().optional().describe('Only when the type was changed to push. The URL the sender should GET.'),
        authMethod: z.string().optional().describe('Only when authMethod was inferred from the credentials passed. The method that was stored.'),
      },
    },
    async ({ monitorID, ...rest }) => {
      await authenticateClient();

      try {
        const existing = client.getMonitor(monitorID, true);
        if (!existing) {
          throw new Error(`Monitor ${monitorID} not found`);
        }
        // editMonitor detaches every child of a group that changes type (removeGroupChildren).
        if (rest.type !== undefined && existing.type === 'group' && rest.type !== 'group') {
          throw new Error(`Monitor ${monitorID} is a group; changing its type would detach all of its child monitors. Move the children out first, or delete and recreate the group.`);
        }
        // Strip undefined values so existing config is preserved for omitted fields, and flatten
        // typeFields in beside them: Uptime Kuma's payload is one flat object.
        const { typeFields, ...topLevel } = rest as Record<string, unknown>;
        const defined: Record<string, unknown> = {
          ...Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v !== undefined)),
          ...parseTypeFields(typeFields, ['monitorID', ...Object.keys(topLevel)]),
        };
        // Fold `parentID` / `parent_id` onto the single field Uptime Kuma's editMonitor
        // handler reads (`bean.parent = monitor.parent`), along with the snake_case
        // type-specific aliases, so a reasonable guess at a name cannot become a silent no-op.
        for (const alias of ['parentID', 'parent_id']) {
          if (alias in defined) {
            if ('parent' in defined && defined.parent !== defined[alias]) {
              throw new Error(`Conflicting values for parent (${defined.parent}) and ${alias} (${defined[alias]}) — pass only 'parent'.`);
            }
            defined.parent = defined[alias];
            delete defined[alias];
          }
        }
        normaliseMonitorAliases(defined);
        assertMongoQueryIsJson(defined.type ?? existing.type, defined.databaseQuery);

        // Issue #59: a caller that read this monitor back holds "***" where a credential
        // was, and the natural edit-one-field-and-write-it-back loop would then persist
        // the marker. Restore the stored value instead. Runs AFTER alias normalisation so
        // `push_token: "***"` is matched against the stored `pushToken`.
        //
        // `existing` is the unredacted cache row: redaction lives at the tool output
        // boundary only, precisely so this comparison still has a real value to find.
        const { preserved, missing } = rehydrateSecrets(defined, existing as unknown as Record<string, unknown>);
        if (missing.length > 0) {
          throw new Error(
            `Cannot write the redaction marker "***" to ${missing.join(', ')} — the monitor has no stored value ` +
            'to restore, so this would create a credential that looks set and cannot work. ' +
            'Pass the real value, or omit the field to leave it unchanged.'
          );
        }

        rehydrateRabbitmqNodes(defined, (existing as unknown as Record<string, unknown>).rabbitmqNodes);
        if (rehydrateMonitorUrl(defined, (existing as unknown as Record<string, unknown>).url)) preserved.push('the credentials in url');

        const merged = { ...existing, ...defined, id: monitorID };
        // A type sent back unchanged is the read-edit-write loop, not a conversion: it must
        // not make an already-incomplete monitor impossible to edit.
        const typeChanged = defined.type !== undefined && defined.type !== existing.type;
        if (typeChanged) {
          const applied = applyMonitorTypeRules(
            merged as unknown as Record<string, unknown>,
            defined.timeout !== undefined && defined.timeout !== null
          );
          // So the read-back below proves the defaults landed too.
          Object.assign(defined, applied);
        }
        // Not only on a type change: adding a credential to an existing monitor is the common
        // case, and the one where a missing authMethod goes unnoticed.
        const authApplied = applyHttpAuthRules(
          merged as unknown as Record<string, unknown>,
          defined,
          existing as unknown as Record<string, unknown>
        );
        Object.assign(defined, authApplied);
        // Ensure retryInterval is valid — Kuma rejects values < 1 on edit even if
        // it stored 0 during creation (pre-existing monitors or older defaults)
        if (!merged.retryInterval || (merged as any).retryInterval < 1) {
          (merged as any).retryInterval = (merged as any).interval || 60;
        }
        const response = await client.updateMonitor(merged as unknown as Record<string, unknown>);

        // Verify against what the CALLER asked for (`defined`), not the merged object —
        // re-checking fields that were only carried over from the existing config would
        // prove nothing about this write.
        const verifyProblem = await verifyMonitorWrite(monitorID, defined, 'saved');

        let text = response.msg || `Monitor ${monitorID} updated successfully`;
        if (preserved.length > 0) {
          text += `\n\nKept the existing value for ${preserved.join(', ')} — "***" was sent, which is the redaction marker, not a credential.`;
        }

        const structuredContent: Record<string, unknown> = {
          ok: response.ok,
          monitorID: response.monitorID ?? monitorID,
          msg: response.msg,
        };
        if (authApplied.authMethod) {
          structuredContent.authMethod = authApplied.authMethod;
          text += inferredAuthNote(authApplied.authMethod);
        }
        const pushToken = (merged as unknown as Record<string, unknown>).pushToken;
        if (typeChanged && defined.type === 'push' && pushToken) {
          structuredContent.pushToken = pushToken;
          structuredContent.pushURL = pushURLFor(pushToken);
          text += `\n\nMonitor ${monitorID} is now a push monitor: point the sender at (GET, not POST)\n  ${structuredContent.pushURL}\nThis URL contains a secret — treat it as a credential.`;
        }

        if (verifyProblem) {
          return {
            content: [{ type: 'text', text: `${verifyProblem}\n\n${text}` }],
            structuredContent,
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update monitor: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteMonitor',
    {
      title: 'Delete Monitor',
      description: 'Permanently deletes a monitor and all its heartbeat history. This action cannot be undone.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteMonitor(monitorID);
        return {
          content: [{ type: 'text', text: response.msg || `Monitor ${monitorID} deleted successfully` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete monitor: ${errorMessage}`);
      }
    }
  );

  // ─── Notification tools ───────────────────────────────────────────────────

  server.registerTool(
    'listNotifications',
    {
      title: 'List Notifications',
      description: 'Returns all configured notification channels (Slack, ntfy, Discord, email, webhooks, etc.). To attach a channel to a monitor you only need its id — the credentials in `config` are withheld by default and the names of the withheld fields are listed in `redactedConfigKeys`.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        notifications: z.array(NotificationSchema).describe('Array of notification channel configurations. By default `config` is reduced to its non-secret fields and `redactedConfigKeys` names what was withheld.'),
        count: z.number(),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const raw = client.getNotificationList();
        // getNotificationList() returns references into notificationListCache, so this
        // must not mutate — redactNotifications builds new objects.
        const notifications = wantsSecrets(includeSecrets)
          ? raw
          : redactNotifications(raw as unknown as Record<string, unknown>[]);
        return {
          content: [{ type: 'text', text: JSON.stringify(notifications, null, 2) }],
          structuredContent: { notifications, count: notifications.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list notifications: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addNotification',
    {
      title: 'Add Notification',
      description: 'Creates a new notification channel. The configuration fields depend on the notification type (e.g., for slack: webhookURL; for ntfy: ntfyTopic, ntfyServerUrl; for discord: discordWebhookUrl).',
      inputSchema: {
        name: z.string().describe('Human-readable name for this notification channel'),
        type: z.string().describe('Notification type (e.g. slack, ntfy, discord, telegram, webhook, smtp)'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Apply this notification to all existing monitors now'),
        config: z.record(z.string(), z.unknown()).describe('Type-specific configuration fields (e.g. webhookURL for slack, ntfyTopic for ntfy)'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, type, isDefault, applyExisting, config }) => {
      await authenticateClient();

      try {
        const notification = { name, type, isDefault, applyExisting, ...config };

        // Issue #59: as with createMonitor, there is no stored value to restore on a create,
        // so the redaction marker is refused rather than saved as the credential. This is the
        // path you hit cloning an existing channel from a redacted listNotifications.
        const markers = rehydrateSecrets(notification as Record<string, unknown>, undefined).missing;
        if (markers.length > 0) {
          throw new Error(
            `"***" is the redaction marker, not a credential — pass the real value for ${markers.join(', ')}. ` +
            'To copy an existing channel, read it with listNotifications { includeSecrets: true }.'
          );
        }

        const response = await client.addNotification(notification as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: response.msg || `Notification created with ID ${response.id}` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add notification: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateNotification',
    {
      title: 'Update Notification',
      description: 'Updates an existing notification channel. Use listNotifications to find the notification ID.',
      inputSchema: {
        notificationID: requiredId('The ID of the notification to update'),
        name: z.string().optional().describe('Human-readable name'),
        type: z.string().optional().describe('Notification type'),
        isDefault: z.boolean().optional().describe('Enable by default for new monitors'),
        applyExisting: z.boolean().optional().describe('Apply to all existing monitors now'),
        config: z.record(z.string(), z.unknown()).optional().describe('Type-specific configuration fields to update'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ notificationID, name, type, isDefault, applyExisting, config }) => {
      await authenticateClient();

      try {
        const notification: Record<string, unknown> = { ...config };
        if (name !== undefined) notification['name'] = name;
        if (type !== undefined) notification['type'] = type;
        if (isDefault !== undefined) notification['isDefault'] = isDefault;
        if (applyExisting !== undefined) notification['applyExisting'] = applyExisting;

        // Issue #59, and the sharper edge of it. Uptime Kuma's addNotification REPLACES the
        // row rather than merging, so the read-edit-write loop writes back whatever the
        // caller was shown — and after redaction that is `smtpPassword: "***"`. Renaming a
        // channel would otherwise destroy the credential that makes it work.
        const stored = client
          .getNotificationList()
          .find((n) => (n as Record<string, unknown>)['id'] === notificationID) as
          | Record<string, unknown>
          | undefined;
        let storedConfig: Record<string, unknown> | undefined;
        const rawStored = stored?.['config'];
        if (typeof rawStored === 'string') {
          try {
            const parsed: unknown = JSON.parse(rawStored);
            if (parsed && typeof parsed === 'object') storedConfig = parsed as Record<string, unknown>;
          } catch {
            storedConfig = undefined;
          }
        } else if (rawStored && typeof rawStored === 'object') {
          storedConfig = rawStored as Record<string, unknown>;
        }

        const { preserved, missing } = rehydrateSecrets(notification, storedConfig);
        if (missing.length > 0) {
          throw new Error(
            `Cannot write the redaction marker "***" to ${missing.join(', ')} — notification ${notificationID} has ` +
            'no stored value to restore. Pass the real value, or call listNotifications with includeSecrets ' +
            'to read the current one.'
          );
        }

        const response = await client.addNotification(notification, notificationID);
        let text = response.msg || `Notification ${notificationID} updated`;
        if (preserved.length > 0) {
          text += `\n\nKept the existing value for ${preserved.join(', ')} — "***" was sent, which is the redaction marker, not a credential.`;
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update notification: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteNotification',
    {
      title: 'Delete Notification',
      description: 'Permanently deletes a notification channel. Monitors that used this channel will no longer send alerts through it.',
      inputSchema: {
        notificationID: requiredId('The ID of the notification to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ notificationID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteNotification(notificationID);
        return {
          content: [{ type: 'text', text: response.msg || `Notification ${notificationID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete notification: ${errorMessage}`);
      }
    }
  );

  // ─── Docker host tools ───────────────────────────────────────────────────

  server.registerTool(
    'listDockerHosts',
    {
      title: 'List Docker Hosts',
      description: 'Returns all docker daemon connections configured in Uptime Kuma. These are referenced by docker container monitors via docker_host.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        dockerHosts: z.array(DockerHostSchema).describe('Array of docker host configurations. Any credentials embedded in a dockerDaemon URL read "***" unless includeSecrets is set.'),
        count: z.number(),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const raw = client.getDockerHostList();
        // A TCP dockerDaemon can be http://user:pass@host:2375 — the field name gives no
        // hint of that, so the URL scrub in redactSecrets is what catches it.
        const dockerHosts = wantsSecrets(includeSecrets) ? raw : raw.map((h) => redactSecrets(h));
        return {
          content: [{ type: 'text', text: JSON.stringify(dockerHosts, null, 2) }],
          structuredContent: { dockerHosts, count: dockerHosts.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list docker hosts: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addDockerHost',
    {
      title: 'Add Docker Host',
      description: 'Creates a new docker daemon connection. For a unix socket use dockerType="socket" and dockerDaemon="/var/run/docker.sock". For a TCP proxy (e.g. tecnativa/docker-socket-proxy) use dockerType="tcp" and dockerDaemon="http://host:2375". Consider calling testDockerHost first to verify reachability.',
      inputSchema: {
        name: z.string().describe('Human-readable name for this docker host'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z.string().describe('Unix socket path (e.g. /var/run/docker.sock) when dockerType=socket, or TCP URL (e.g. http://docker-proxy:2375) when dockerType=tcp'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        const response = await client.addDockerHost({ name, dockerType, dockerDaemon });
        return {
          content: [{ type: 'text', text: response.msg || `Docker host created with ID ${response.id}` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateDockerHost',
    {
      title: 'Update Docker Host',
      description: 'Updates an existing docker daemon connection. Use listDockerHosts to find the docker host ID. Only the fields you pass are changed — the others are preserved.',
      inputSchema: {
        dockerHostID: requiredId('The ID of the docker host to update'),
        name: z.string().optional().describe('New human-readable name'),
        dockerType: z.enum(['socket', 'tcp']).optional().describe('New connection type'),
        dockerDaemon: z.string().optional().describe('New socket path or TCP URL'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ dockerHostID, name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        // Merge new values onto the current record so callers can omit unchanged fields.
        // Uptime Kuma's addDockerHost handler overwrites every column it receives, so we
        // need to send the full set to avoid clobbering existing values with undefined.
        const existing = client.getDockerHostList().find(h => h.id === dockerHostID);
        if (!existing) {
          throw new Error(`Docker host ${dockerHostID} not found — call listDockerHosts to see available IDs`);
        }

        const merged: Record<string, unknown> = {
          name: name ?? existing.name,
          dockerType: dockerType ?? existing.dockerType,
          dockerDaemon: dockerDaemon ?? existing.dockerDaemon,
        };

        // Issue #59: listDockerHosts scrubs inline URL credentials to "***:***@host", and a
        // dockerDaemon TCP URL is written back here wholesale. The read-edit-write loop an agent
        // performs would otherwise persist those markers over the real credentials. Restore them
        // from the stored URL. The marker sits inside the URL userinfo, not as a bare "***", so
        // rehydrateSecrets cannot catch it — rehydrateUrlCredentials is its URL-shaped counterpart.
        // Only reached when the caller passed dockerDaemon; omitting it already keeps the stored URL.
        let preservedCreds = false;
        if (dockerDaemon !== undefined) {
          const restored = rehydrateUrlCredentials(dockerDaemon, existing.dockerDaemon);
          if (restored.hostChanged) {
            throw new Error(HOST_CHANGED_MARKER_ERROR('dockerDaemon', 'call listDockerHosts with includeSecrets'));
          }
          if (restored.missing) {
            throw new Error(
              'Cannot write the redaction marker "***" into dockerDaemon — the docker host has no ' +
              'stored credential to restore, so this would save an endpoint that looks authenticated ' +
              'and cannot connect. Pass the real URL, or call listDockerHosts with includeSecrets to ' +
              'read the current one.'
            );
          }
          merged.dockerDaemon = restored.value;
          preservedCreds = restored.preserved;
        }

        const response = await client.addDockerHost(merged, dockerHostID);
        let text = response.msg || `Docker host ${dockerHostID} updated`;
        if (preservedCreds) {
          text += '\n\nKept the existing credentials embedded in dockerDaemon — "***" was sent, ' +
            'which is the redaction marker, not a credential.';
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteDockerHost',
    {
      title: 'Delete Docker Host',
      description: 'Permanently deletes a docker daemon connection. Any monitors referencing it will have their docker_host cleared by Uptime Kuma (the monitors themselves are not deleted).',
      inputSchema: {
        dockerHostID: requiredId('The ID of the docker host to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ dockerHostID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteDockerHost(dockerHostID);
        return {
          content: [{ type: 'text', text: response.msg || `Docker host ${dockerHostID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'testDockerHost',
    {
      title: 'Test Docker Host',
      description: 'Tests connectivity to a docker daemon without persisting it. On success the message includes the number of containers. Use this before addDockerHost to avoid saving a broken configuration.',
      inputSchema: {
        name: z.string().describe('Display name (used only in the test request)'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z.string().describe('Unix socket path or TCP URL to probe'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        const response = await client.testDockerHost({ name, dockerType, dockerDaemon });
        return {
          content: [{ type: 'text', text: response.msg || (response.ok ? 'Docker host reachable' : 'Docker host unreachable') }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to test docker host: ${errorMessage}`);
      }
    }
  );

  // ─── Tag tools ───────────────────────────────────────────────────────────

  server.registerTool(
    'listTags',
    {
      title: 'List Tags',
      description: 'Returns all tags defined in Uptime Kuma (name, color, and ID).',
      inputSchema: {},
      outputSchema: {
        tags: z.array(z.object({
          id: z.number(),
          name: z.string(),
          color: z.string(),
        })).describe('Array of tags'),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const tags = await client.getTagList();
        return {
          content: [{ type: 'text', text: JSON.stringify(tags, null, 2) }],
          structuredContent: { tags, count: tags.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list tags: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addTag',
    {
      title: 'Add Tag',
      description: 'Creates a new tag that can be assigned to monitors.',
      inputSchema: {
        name: z.string().describe('Tag name'),
        color: z.string().describe('Tag color as a hex string (e.g. "#ff0000") or CSS color name'),
      },
      outputSchema: {
        ok: z.boolean(),
        tag: z.object({ id: z.number(), name: z.string(), color: z.string() }).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, color }) => {
      await authenticateClient();

      try {
        const response = await client.addTag(name, color);
        return {
          content: [{ type: 'text', text: `Tag "${name}" created with ID ${response.tag?.id}` }],
          structuredContent: { ok: response.ok, tag: response.tag, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add tag: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteTag',
    {
      title: 'Delete Tag',
      description: 'Permanently deletes a tag. It will be removed from all monitors that use it. Use listTags to find the tag ID.',
      inputSchema: {
        tagID: requiredId('The ID of the tag to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ tagID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteTag(tagID);
        return {
          content: [{ type: 'text', text: response.msg || `Tag ${tagID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete tag: ${errorMessage}`);
      }
    }
  );

  // ─── Maintenance tools ────────────────────────────────────────────────────

  const MAINTENANCE_STRATEGIES = ['single', 'recurring-interval', 'recurring-weekday', 'recurring-day-of-month', 'cron', 'manual'] as const;

  // The schedule fields shared by createMaintenance and updateMaintenance. Each tool applies
  // its own optionality: create requires title and strategy, update requires neither.
  const maintenanceScheduleFields = {
    description: z.string().optional().describe('Description or reason for the maintenance'),
    timezone: z.string().optional().describe('Timezone the dates and times are in (e.g. "America/New_York", "UTC"). Omit to follow the server timezone.'),
    dateRange: z.array(z.string()).optional().describe('[start, end] as local wall-clock times in the window\'s timezone, e.g. ["2026-10-08T10:00", "2026-10-08T12:00"] — the format Uptime Kuma\'s own UI stores. Required for single; optional bounds for recurring strategies; ignored for manual.'),
    timeRange: z.array(z.object({ hours: numeric(z.number().int().min(0).max(23)), minutes: numeric(z.number().int().min(0).max(59)) })).optional()
      .describe('Daily [{hours, minutes}, {hours, minutes}] start and end. Required for the recurring-* strategies, ignored otherwise.'),
    weekdays: z.array(numeric(z.number().int().min(0).max(6))).optional()
      .describe('Days of week (0=Sunday … 6=Saturday) for recurring-weekday strategy'),
    daysOfMonth: z.array(numeric(z.number().int().min(1).max(31))).optional()
      .describe('Days of month (1-31) for recurring-day-of-month strategy'),
    intervalDay: numeric(z.number().int().positive()).optional()
      .describe('Interval in days for recurring-interval strategy'),
    cron: z.string().optional()
      .describe('Cron expression for when the window starts, e.g. "30 3 * * *" (03:30 daily), for the cron strategy'),
    durationMinutes: numeric(z.number().int().positive()).optional()
      .describe('How long each window lasts, in minutes, for the cron strategy'),
    monitorIDs: z.array(numeric(z.number().int().nonnegative())).optional()
      .describe('IDs of the monitors this window suppresses. A window with no monitors suppresses nothing. On update this REPLACES the current list; pass [] to detach all.'),
  };

  /**
   * Turns tool input into the object Uptime Kuma's Maintenance.jsonToBean() expects.
   *
   * jsonToBean() reads every field unconditionally, so anything left out is not "unchanged"
   * or "defaulted" — it is an error or a NULL:
   *   - dateRange missing → "Cannot read properties of undefined (reading '0')", which made
   *     manual and recurring windows impossible to create without inventing dates.
   *   - active missing → "NOT NULL constraint failed: maintenance.active", despite the
   *     schema promising a default of true.
   *   - timezone is not read at all; the column is filled from `timezoneOption`. Passing
   *     timezone silently produced a window in the server timezone.
   *   - a recurring-* strategy without a timeRange throws while generating its cron.
   */
  const toKumaMaintenance = (fields: Record<string, unknown>): Record<string, unknown> => {
    const strategy = fields.strategy as string;
    const dateRange = (fields.dateRange as Array<string | null> | undefined) ?? [];
    const timeRange = fields.timeRange as Array<{ hours: number; minutes: number } | null> | undefined;

    if (strategy === 'single' && !(dateRange[0] && dateRange[1])) {
      throw new Error('A single maintenance window needs dateRange: [start, end].');
    }
    if (strategy.startsWith('recurring-') && !(timeRange?.length === 2 && timeRange[0] && timeRange[1])) {
      throw new Error(`A ${strategy} maintenance window needs timeRange: [{hours, minutes}, {hours, minutes}].`);
    }
    if (strategy === 'recurring-weekday' && !(fields.weekdays as number[] | undefined)?.length) {
      throw new Error('A recurring-weekday maintenance window needs at least one entry in weekdays.');
    }
    if (strategy === 'recurring-day-of-month' && !(fields.daysOfMonth as number[] | undefined)?.length) {
      throw new Error('A recurring-day-of-month maintenance window needs at least one entry in daysOfMonth.');
    }
    if (strategy === 'recurring-interval' && !fields.intervalDay) {
      throw new Error('A recurring-interval maintenance window needs intervalDay.');
    }
    if (strategy === 'cron' && !(fields.cron && fields.durationMinutes)) {
      throw new Error('A cron maintenance window needs cron and durationMinutes.');
    }

    const out: Record<string, unknown> = {
      title: fields.title,
      description: fields.description ?? '',
      strategy,
      active: fields.active ?? true,
      intervalDay: fields.intervalDay ?? null,
      dateRange,
      weekdays: fields.weekdays ?? [],
      daysOfMonth: fields.daysOfMonth ?? [],
      timezoneOption: fields.timezone ?? null,
    };
    if (timeRange) out.timeRange = timeRange;
    // jsonToBean reads these only for the cron strategy, and then unconditionally: a missing
    // cron fails validation and a missing durationMinutes stores a NaN duration.
    if (strategy === 'cron') {
      out.cron = fields.cron;
      out.durationMinutes = fields.durationMinutes;
    }
    if (fields.id !== undefined) out.id = fields.id;
    return out;
  };

  /** Strips nulls so [start] and [start, null] and [null] compare the way Kuma stores them. */
  const presentDates = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string' && d !== '') : [];

  /**
   * Reads the window back and reports every requested field that did not persist.
   * Same contract as verifyMonitorWrite(): returns the problem rather than throwing, because
   * the write has already happened and the caller still has to report the window's ID.
   */
  const verifyMaintenanceWrite = async (
    maintenanceID: number,
    requested: Record<string, unknown>,
    operation: string
  ): Promise<string | null> => {
    let fresh: Record<string, unknown>;
    try {
      fresh = await client.fetchMaintenance(maintenanceID);
    } catch (verifyError) {
      const m = verifyError instanceof Error ? verifyError.message : String(verifyError);
      return `Maintenance window ${maintenanceID} was ${operation}, but the write could NOT be verified: ${m}. Do not assume it applied.`;
    }

    const recurring = String(fresh.strategy ?? '').startsWith('recurring-');
    const mismatches: string[] = [];
    const check = (field: string, wanted: unknown, stored: unknown) => {
      if (JSON.stringify(wanted) !== JSON.stringify(stored)) {
        mismatches.push(`${field}: asked for ${JSON.stringify(wanted)}, server reports ${JSON.stringify(stored)}`);
      }
    };

    for (const field of ['title', 'description', 'strategy', 'intervalDay', 'active'] as const) {
      if (field in requested) check(field, requested[field] ?? null, fresh[field] ?? null);
    }
    if ('timezone' in requested) check('timezone', requested.timezone ?? null, fresh.timezoneOption ?? null);
    if ('dateRange' in requested && fresh.strategy !== 'manual') {
      check('dateRange', presentDates(requested.dateRange), presentDates(fresh.dateRange));
    }
    if (recurring) {
      if ('timeRange' in requested) {
        const hm = (v: unknown) =>
          Array.isArray(v) ? v.map((t) => (t ? { hours: Number(t.hours), minutes: Number(t.minutes) } : null)) : null;
        check('timeRange', hm(requested.timeRange), hm(fresh.timeRange));
      }
      if ('weekdays' in requested) check('weekdays', requested.weekdays, fresh.weekdays);
      if ('daysOfMonth' in requested) check('daysOfMonth', requested.daysOfMonth, fresh.daysOfMonth);
    }
    if (fresh.strategy === 'cron') {
      if ('cron' in requested) check('cron', requested.cron, fresh.cron);
      if ('durationMinutes' in requested) check('durationMinutes', requested.durationMinutes, fresh.durationMinutes);
    }

    if (mismatches.length === 0) return null;
    return (
      `Maintenance window ${maintenanceID} was ${operation} and Uptime Kuma acknowledged it, but the following did NOT persist:\n` +
      `  - ${mismatches.join('\n  - ')}`
    );
  };

  /**
   * Sets the window's monitor list (a full replace) and reads it back. Returns the problem
   * as a string, like verifyMaintenanceWrite().
   */
  const setAndVerifyMaintenanceMonitors = async (
    maintenanceID: number,
    monitorIDs: number[],
    operation: string
  ): Promise<string | null> => {
    const wanted = [...new Set(monitorIDs)].sort((a, b) => a - b);
    try {
      await client.setMonitorMaintenance(maintenanceID, wanted);
    } catch (linkError) {
      const m = linkError instanceof Error ? linkError.message : String(linkError);
      return `Maintenance window ${maintenanceID} was ${operation}, but setting its monitors to [${wanted.join(', ')}] failed: ${m}`;
    }

    let stored: number[];
    try {
      stored = (await client.getMonitorMaintenance(maintenanceID)).sort((a, b) => a - b);
    } catch (verifyError) {
      const m = verifyError instanceof Error ? verifyError.message : String(verifyError);
      return `Maintenance window ${maintenanceID} was ${operation}, but its monitor list could NOT be verified: ${m}. Do not assume it applied.`;
    }

    if (JSON.stringify(stored) !== JSON.stringify(wanted)) {
      return (
        `Maintenance window ${maintenanceID} was ${operation} and Uptime Kuma acknowledged the monitor list, ` +
        `but it covers [${stored.join(', ')}] rather than the requested [${wanted.join(', ')}].`
      );
    }
    return null;
  };

  /**
   * Uptime Kuma answers a write to a missing window with either `ok: true` (delete) or a raw
   * "Cannot read properties of null" (edit, pause, resume). Check first so the caller gets
   * "not found" instead of a false success or a stack-trace fragment.
   */
  const requireMaintenance = async (maintenanceID: number): Promise<void> => {
    const list = await client.refreshMaintenanceList();
    if (!list.some((w) => w.id === maintenanceID)) {
      throw new Error(`Maintenance window ${maintenanceID} not found. Use getMaintenanceWindows to list the windows that exist.`);
    }
  };

  const errorResult = (problem: string, text: string, structuredContent: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: `${problem}\n\n${text}` }],
    structuredContent,
    isError: true,
  });

  server.registerTool(
    'getMaintenanceWindows',
    {
      title: 'Get Maintenance Windows',
      description: 'Returns all maintenance windows defined in Uptime Kuma, each with monitorIDs — the monitors it suppresses. A window with an empty monitorIDs list suppresses nothing.',
      inputSchema: {},
      outputSchema: {
        maintenanceWindows: z.array(MaintenanceSchema).describe('Array of maintenance windows'),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const maintenanceWindows = await Promise.all(
          client.getMaintenanceList().map(async (w) => ({
            ...w,
            monitorIDs: w.id === undefined ? [] : await client.getMonitorMaintenance(w.id),
          }))
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(maintenanceWindows, null, 2) }],
          structuredContent: { maintenanceWindows, count: maintenanceWindows.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get maintenance windows: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createMaintenance',
    {
      title: 'Create Maintenance',
      description: 'Schedules a new maintenance window. During maintenance, the monitors in monitorIDs are suppressed and show MAINTENANCE status instead of DOWN. A window created without monitorIDs suppresses nothing. Use strategy "manual" for a window you switch on and off with resumeMaintenance / pauseMaintenance.',
      inputSchema: {
        title: z.string().describe('Title of the maintenance window'),
        strategy: z.enum(MAINTENANCE_STRATEGIES)
          .describe('Scheduling strategy: single=one-time, recurring-interval=every N days, recurring-weekday=specific weekdays, recurring-day-of-month=specific dates, cron=starts on a cron expression and lasts durationMinutes, manual=on whenever active'),
        active: z.boolean().optional().describe('Whether the window is active (default: true). For a manual window, active means in maintenance right now.'),
        ...maintenanceScheduleFields,
      },
      outputSchema: {
        ok: z.boolean(),
        maintenanceID: z.number().optional(),
        monitorIDs: z.array(z.number()).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorIDs, ...input }) => {
      await authenticateClient();

      try {
        const response = await client.createMaintenance(toKumaMaintenance(input));
        const maintenanceID = response.maintenanceID;
        const structuredContent: Record<string, unknown> = { ok: response.ok, maintenanceID, msg: response.msg };
        let text = `Maintenance window created with ID ${maintenanceID}`;

        if (maintenanceID !== undefined) {
          const problems = [
            await verifyMaintenanceWrite(maintenanceID, input, 'created'),
            monitorIDs ? await setAndVerifyMaintenanceMonitors(maintenanceID, monitorIDs, 'created') : null,
          ].filter((p): p is string => p !== null);

          if (problems.length > 0) {
            return errorResult(
              `${problems.join('\n\n')}\n\nMaintenance window ${maintenanceID} EXISTS — do not create it again. ` +
                `Fix it with updateMaintenance, or remove it with deleteMaintenance ${maintenanceID}.`,
              text,
              structuredContent
            );
          }
        }

        if (monitorIDs && monitorIDs.length > 0) {
          structuredContent.monitorIDs = [...new Set(monitorIDs)].sort((a, b) => a - b);
          text += `, covering monitors ${(structuredContent.monitorIDs as number[]).join(', ')}.`;
        } else {
          text += '. It has no monitors, so it suppresses nothing — add them with updateMaintenance (monitorIDs).';
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create maintenance window: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateMaintenance',
    {
      title: 'Update Maintenance',
      description: 'Updates an existing maintenance window. Only the fields you provide are changed (the server merges them with the stored window). monitorIDs replaces the full monitor list. To switch a window on or off use pauseMaintenance / resumeMaintenance.',
      inputSchema: {
        maintenanceID: requiredId('The ID of the maintenance window to update'),
        title: z.string().optional().describe('Title of the maintenance window'),
        strategy: z.enum(MAINTENANCE_STRATEGIES).optional().describe('Scheduling strategy (see createMaintenance)'),
        ...maintenanceScheduleFields,
      },
      outputSchema: {
        ok: z.boolean(),
        maintenanceID: z.number(),
        monitorIDs: z.array(z.number()).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ maintenanceID, monitorIDs, ...rest }) => {
      await authenticateClient();

      try {
        const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        if (Object.keys(defined).length === 0 && monitorIDs === undefined) {
          throw new Error('Nothing to update — pass at least one field to change, or monitorIDs.');
        }

        await requireMaintenance(maintenanceID);
        const structuredContent: Record<string, unknown> = { ok: true, maintenanceID };
        const problems: string[] = [];

        if (Object.keys(defined).length > 0) {
          const existing = await client.fetchMaintenance(maintenanceID);
          // timezoneOption is the stored choice (null = follow the server); `timezone` in the
          // read model is the RESOLVED zone. Carrying `timezone` over would pin a window that
          // follows the server to whatever the server happens to use today.
          const current = {
            id: maintenanceID,
            title: existing.title,
            description: existing.description,
            strategy: existing.strategy,
            active: existing.active,
            intervalDay: existing.intervalDay,
            dateRange: existing.dateRange,
            timeRange: existing.timeRange,
            weekdays: existing.weekdays,
            daysOfMonth: existing.daysOfMonth,
            cron: existing.cron,
            durationMinutes: existing.durationMinutes,
            timezone: existing.timezoneOption ?? undefined,
          };
          const response = await client.editMaintenance(toKumaMaintenance({ ...current, ...defined }));
          structuredContent.msg = response.msg;
          const problem = await verifyMaintenanceWrite(maintenanceID, defined, 'saved');
          if (problem) problems.push(problem);
        }

        if (monitorIDs !== undefined) {
          const problem = await setAndVerifyMaintenanceMonitors(maintenanceID, monitorIDs, 'updated');
          if (problem) problems.push(problem);
          else structuredContent.monitorIDs = [...new Set(monitorIDs)].sort((a, b) => a - b);
        }

        const changed = [...Object.keys(defined), ...(monitorIDs !== undefined ? ['monitorIDs'] : [])];
        const text = `Maintenance window ${maintenanceID} updated (${changed.join(', ')}).`;
        if (problems.length > 0) {
          structuredContent.ok = false;
          return errorResult(problems.join('\n\n'), text, structuredContent);
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update maintenance window: ${errorMessage}`);
      }
    }
  );

  const registerMaintenanceToggle = (name: string, title: string, description: string, active: boolean) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          maintenanceID: requiredId(`The ID of the maintenance window to ${active ? 'resume' : 'pause'}`),
        },
        outputSchema: {
          ok: z.boolean(),
          maintenanceID: z.number(),
          active: z.boolean(),
          msg: z.string().optional(),
        },
      },
      async ({ maintenanceID }) => {
        await authenticateClient();

        try {
          await requireMaintenance(maintenanceID);
          const response = active
            ? await client.resumeMaintenance(maintenanceID)
            : await client.pauseMaintenance(maintenanceID);
          const text = `Maintenance window ${maintenanceID} ${active ? 'resumed' : 'paused'}.`;
          const structuredContent = { ok: response.ok, maintenanceID, active, msg: response.msg };

          const problem = await verifyMaintenanceWrite(maintenanceID, { active }, active ? 'resumed' : 'paused');
          if (problem) return errorResult(problem, text, { ...structuredContent, ok: false });

          return {
            content: [{ type: 'text', text }],
            structuredContent,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          throw new McpError(ErrorCode.InternalError, `Failed to ${active ? 'resume' : 'pause'} maintenance window: ${errorMessage}`);
        }
      }
    );
  };

  registerMaintenanceToggle(
    'pauseMaintenance',
    'Pause Maintenance',
    'Switches a maintenance window off: it stops suppressing its monitors and its schedule stops until resumed. For a manual window this ends the maintenance.',
    false
  );

  registerMaintenanceToggle(
    'resumeMaintenance',
    'Resume Maintenance',
    'Switches a paused maintenance window back on. For a manual window this starts the maintenance immediately; a scheduled window resumes following its schedule.',
    true
  );

  server.registerTool(
    'deleteMaintenance',
    {
      title: 'Delete Maintenance',
      description: 'Permanently deletes a maintenance window. Its monitors return to normal alerting. Use getMaintenanceWindows to find the ID.',
      inputSchema: {
        maintenanceID: requiredId('The ID of the maintenance window to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ maintenanceID }) => {
      await authenticateClient();

      try {
        await requireMaintenance(maintenanceID);
        const response = await client.deleteMaintenance(maintenanceID);
        const text = `Maintenance window ${maintenanceID} deleted.`;

        const remaining = await client.refreshMaintenanceList();
        if (remaining.some((w) => w.id === maintenanceID)) {
          return errorResult(
            `Uptime Kuma acknowledged deleting maintenance window ${maintenanceID}, but it is still listed.`,
            text,
            { ok: false, msg: response.msg }
          );
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete maintenance window: ${errorMessage}`);
      }
    }
  );

  // ─── Status page tools ────────────────────────────────────────────────────

  server.registerTool(
    'listStatusPages',
    {
      title: 'List Status Pages',
      description: 'Returns all configured status pages with their slug, title, visibility, and custom domain settings.',
      inputSchema: {},
      outputSchema: {
        statusPages: z.array(StatusPageSchema).describe('Array of status page configurations'),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const statusPages = client.getStatusPageList();
        return {
          content: [{ type: 'text', text: JSON.stringify(statusPages, null, 2) }],
          structuredContent: { statusPages, count: statusPages.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list status pages: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'getStatusPage',
    {
      title: 'Get Status Page',
      description: 'Returns the full configuration of a status page by slug, including the ordered list of groups, the monitors inside each group, and active incidents. Only works for published status pages (fetches the public `/api/status-page/{slug}` endpoint).',
      inputSchema: {
        slug: z.string().describe('The status page slug (the URL-safe identifier)'),
      },
      outputSchema: {
        ok: z.boolean(),
        config: StatusPageSchema.optional(),
        publicGroupList: z.array(z.record(z.string(), z.unknown())).optional().describe('Ordered groups with their monitorList'),
        incidents: z.array(z.record(z.string(), z.unknown())).optional().describe('Active incidents on the status page'),
        msg: z.string().optional(),
      },
    },
    async ({ slug }) => {
      await authenticateClient();

      try {
        const response = await client.getStatusPage(slug);
        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
          structuredContent: {
            ok: response.ok,
            config: response.config,
            publicGroupList: response.publicGroupList as Array<Record<string, unknown>> | undefined,
            incidents: response.incidents as Array<Record<string, unknown>> | undefined,
            msg: response.msg,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createStatusPage',
    {
      title: 'Create Status Page',
      description: 'Creates a new (empty) status page with the given title and slug. After creating, call updateStatusPage to set the description, theme, groups, and monitors. Slug must be lowercase letters, digits, and dashes only.',
      inputSchema: {
        title: z.string().describe('Display title of the status page'),
        slug: z.string().regex(/^[a-z0-9-]+$/).describe('URL slug (lowercase letters, digits, and dashes only)'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ title, slug }) => {
      await authenticateClient();

      try {
        const response = await client.createStatusPage(title, slug);
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} created` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateStatusPage',
    {
      title: 'Update Status Page',
      description: 'Updates an existing status page. Pass the full config (title, description, theme, published, etc.) and the full publicGroupList — both are replaced wholesale. Each group has a name, weight, and monitorList of [{id}]. Use getStatusPage first to read current state before modifying.',
      inputSchema: {
        slug: z.string().describe('The status page slug (immutable identifier)'),
        config: z.record(z.string(), z.unknown()).describe('Full status page config (title, description, theme, published, showTags, showPoweredBy, domainNameList, customCSS, footerText, icon, etc.)'),
        publicGroupList: z.array(z.record(z.string(), z.unknown())).optional().describe('Ordered groups. Each: {name, weight, monitorList: [{id}]}. Defaults to empty list.'),
        imgDataUrl: z.string().optional().describe('Icon as data URL. Omit or pass empty string to keep existing.'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug, config, publicGroupList, imgDataUrl }) => {
      await authenticateClient();

      try {
        const response = await client.updateStatusPage(
          slug,
          config,
          publicGroupList ?? [],
          imgDataUrl ?? ''
        );
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} updated` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteStatusPage',
    {
      title: 'Delete Status Page',
      description: 'Permanently deletes a status page by slug. The status page URL will no longer be accessible.',
      inputSchema: {
        slug: z.string().describe('The status page slug to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug }) => {
      await authenticateClient();

      try {
        const response = await client.deleteStatusPage(slug);
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete status page: ${errorMessage}`);
      }
    }
  );

  // Clean up on server shutdown
  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    client.disconnect();
    process.exit(0);
  });

  return { server, client, authenticateClient };
}
