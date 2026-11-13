/**
 * What a monitor is made of: the types Uptime Kuma has, the fields each one takes, and how
 * those fields are validated and described.
 */
import { z } from 'zod';
import { numeric } from '../tools/schema.js';

export const MONITOR_TYPES = [
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
  {
    type: 'gamedig',
    description:
      'Game server (Minecraft, Counter-Strike, Valheim, Rust, ARK and any other game GameDig supports): checks that the server answers its game query, not just that the port is open. Set game to the GameDig ID, e.g. "minecraft".',
  },
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
  { type: 'pm2', description: 'PM2 process status check' },
];
export const MONITOR_TYPE_NAMES = new Set(MONITOR_TYPES.map((t) => t.type));

/**
 * The refusal for a redacted URL sent back pointing at a different host. Stored credentials
 * are only ever restored onto the host they were stored for — see rehydrateUrlCredentials.
 */
export const HOST_CHANGED_MARKER_ERROR = (field: string, howToRead: string): string =>
  `"***" in ${field} is the redaction marker, and the stored credentials belong to a different host or port, ` +
  'so they were not restored — that would send a credential you were not shown to a new address. ' +
  `Pass the real credentials for the new address, or ${howToRead} to read the current ones.`;

/** A credential field's shared wording, so every one of them describes the round trip. */
export const SECRET_NOTE =
  'A credential: read tools return "***", and on updateMonitor sending "***" back keeps the stored value.';

/**
 * One entry of a monitor's `conditions`, as Uptime Kuma's condition editor builds it
 * (server/monitor-conditions/expression.js).
 *
 * Conditions nest, but this is deliberately NOT a recursive schema: z.lazy() is advertised as
 * a `$ref` into `definitions`, and tool input schemas with references are rejected by several
 * MCP clients (the class of problem behind #55 and #83). The top level is spelled out and the
 * children of a group are passed through as given, which also keeps the advertised schema small.
 */
export const conditionFields = <T extends z.ZodTypeAny>(children: T) => ({
  type: z.enum(['expression', 'group']),
  andOr: z.enum(['and', 'or']).optional(),
  variable: z.string().optional(),
  operator: z.string().optional(),
  value: z.string().optional(),
  children: z.array(children).optional(),
});
export const MonitorConditionInputSchema = z.object(conditionFields(z.record(z.string(), z.unknown())));

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
export const TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS = {
  // ── HTTP authentication (http, keyword, json-query, websocket-upgrade, globalping) ──
  authMethod: z.enum(['basic', 'bearer', 'oauth2-cc', 'ntlm', 'mtls']).nullable().optional(),
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
  saveResponse: z.boolean().optional(),
  saveErrorResponse: z.boolean().optional(),
  responseMaxLength: numeric(z.number().int().min(0).max(1048576)).optional(),
  retryOnlyOnStatusCodeFailure: z.boolean().optional(),

  // ── websocket-upgrade ──
  wsSubprotocol: z.string().optional(),
  wsIgnoreSecWebsocketAcceptHeader: z.boolean().optional(),

  // ── mqtt (hostname takes the broker, e.g. mqtt://broker.example.com; port is required) ──
  mqttTopic: z.string().optional(),
  mqttUsername: z.string().optional(),
  mqttPassword: z.string().optional(),
  mqttCheckType: z.enum(['keyword', 'json-query']).optional(),
  mqttSuccessMessage: z.string().optional(),
  mqttWebsocketPath: z
    .string()
    .regex(/^\/[A-Za-z0-9\-_&()*+]*$/, 'must start with "/" and contain only letters, digits and -_&()*+')
    .optional(),

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
  kafkaProducerSaslOptions: z
    .object({
      mechanism: z.enum(['None', 'plain', 'scram-sha-256', 'scram-sha-512', 'aws']),
      username: z.string().optional(),
      password: z.string().optional(),
      authorizationIdentity: z.string().optional(),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      sessionToken: z.string().optional(),
    })
    .optional(),

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
export const MONITOR_FIELD_DOCS: Record<keyof typeof TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS, string> = {
  // ── HTTP authentication (http, keyword, json-query, websocket-upgrade, globalping) ──
  authMethod:
    'HTTP authentication method. Uptime Kuma only sends the credentials of the method named here, so it is inferred when you pass one kind of credential without it. null turns authentication off.',
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
  saveResponse: 'Store the response body with every heartbeat (default: false)',
  saveErrorResponse: 'Store the response body with failing heartbeats (default: true)',
  responseMaxLength: 'Maximum bytes of response body stored (default: 1024, max: 1048576)',
  retryOnlyOnStatusCodeFailure:
    'json-query only: retry when the status code is wrong, but go DOWN at once when the JSON query fails',

  // ── websocket-upgrade ──
  wsSubprotocol: 'websocket-upgrade: Sec-WebSocket-Protocol to request, comma-separated for several',
  wsIgnoreSecWebsocketAcceptHeader:
    'websocket-upgrade: do not validate the Sec-WebSocket-Accept header of the handshake',

  // ── mqtt (hostname takes the broker, e.g. mqtt://broker.example.com; port is required) ──
  mqttTopic: 'MQTT topic to subscribe to (required for mqtt)',
  mqttUsername: 'MQTT username',
  mqttPassword: `MQTT password. ${SECRET_NOTE}`,
  mqttCheckType:
    'How the received message is judged: "keyword" looks for mqttSuccessMessage, "json-query" applies jsonPath / jsonPathOperator / expectedValue (default: keyword)',
  mqttSuccessMessage: 'Text the received message must contain, for mqttCheckType "keyword". Empty accepts any message.',
  mqttWebsocketPath: 'Path for MQTT over WebSocket (ws:// or wss:// hostname), e.g. /mqtt',

  // ── grpc-keyword ──
  grpcUrl: 'gRPC server as host:port (required for grpc-keyword)',
  grpcProtobuf: 'The .proto definition text describing the service (required for grpc-keyword)',
  grpcServiceName: 'Service name from the proto (required for grpc-keyword)',
  grpcMethod: 'Method to call on the service (required for grpc-keyword)',
  grpcBody: 'Request message as a JSON string',
  grpcMetadata: `Request metadata as a JSON string. Usually carries credentials. Uptime Kuma 2.5.10 stores it but its check does not send it yet. ${SECRET_NOTE}`,
  grpcEnableTls: 'Connect to the gRPC server over TLS',

  // ── kafka-producer ──
  kafkaProducerBrokers: 'Kafka brokers as host:port (required for kafka-producer)',
  kafkaProducerTopic: 'Topic the test message is produced to (required for kafka-producer)',
  kafkaProducerMessage: 'Message produced on every check (required for kafka-producer)',
  kafkaProducerSsl: 'Connect to the brokers over TLS',
  kafkaProducerAllowAutoTopicCreation: 'Let the broker create the topic if it does not exist',
  kafkaProducerSaslOptions:
    'Kafka SASL authentication: { mechanism, ... }. mechanism "None" disables SASL; "plain", "scram-sha-256" and "scram-sha-512" take username and password; "aws" takes authorizationIdentity, accessKeyId, secretAccessKey and optionally sessionToken. Replaced as a whole object. password, secretAccessKey and sessionToken are credentials: read tools return "***", and on updateMonitor sending "***" back keeps the stored value.',

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
  snmpVersion:
    "SNMP version (default: 2c). SNMPv3 cannot be set here: Uptime Kuma's edit handler does not save the v3 username.",
  snmpCommunity: `SNMP community string, e.g. "public" (required for snmp). Stored by Uptime Kuma as radiusPassword. ${SECRET_NOTE}`,

  // ── smtp ──
  smtpSecurity:
    'smtp: "secure" for SMTPS, "starttls" to require STARTTLS, "nostarttls" to never use it. Omit to use STARTTLS when offered.',

  // ── gamedig ──
  game: 'GameDig game ID, e.g. "minecraft" (required for gamedig)',
  gamedigGivenPortOnly: "Query only the given port instead of also trying the game's default ports (default: true)",
  gamedigToken: `Token for games whose query needs one. ${SECRET_NOTE}`,

  // ── real-browser ──
  remote_browser: 'ID of a remote browser configured in Uptime Kuma. null uses the built-in Chromium.',
  screenshot_delay: 'Milliseconds to wait after page load before the screenshot. Must be under 0.5 x interval.',

  // ── globalping ──
  subtype: 'globalping: the kind of measurement (default: ping). ping and dns need hostname; http needs url.',
  location:
    'globalping: where the probe runs — a continent, country, city, ASN or cloud region, e.g. "world", "DE", "aws-us-east-1" (default: world). One location only, no commas.',
  protocol: 'globalping: ICMP or TCP for ping, UDP or TCP for dns, HTTP2 for http. null lets Globalping choose.',

  // ── sftp ──
  sshUsername: 'SSH username (required for sftp)',
  sshAuthMethod: 'How the sftp monitor logs in (default: password)',
  sshPassword: `SSH password, for sshAuthMethod "password". ${SECRET_NOTE}`,
  sshPrivateKey: `PEM private key, for sshAuthMethod "privateKey". ${SECRET_NOTE}`,
  sshPassphrase: `Passphrase of sshPrivateKey, if it has one. ${SECRET_NOTE}`,
  sftpPath: 'Remote path that must exist for the sftp monitor to be UP (optional)',

  // ── ping ──
  packetSize: 'Ping packet size in bytes (default: 56). Also the size of the ping steam measures latency with.',
  ping_count: 'Echo requests sent per check (default: 1)',
  ping_numeric: 'Skip reverse DNS lookups in ping output (default: true)',
  ping_per_request_timeout: 'Seconds to wait for each echo reply (default: 2). Must not exceed timeout.',

  // ── ntp ──
  ntpStratumThreshold: "ntp: DOWN when the server's stratum is above this (default: 5)",
  ntpTimeOffsetThreshold: 'ntp: DOWN when the clock offset exceeds this many milliseconds (default: 1000)',
  ntpRootDispersionThreshold: 'ntp: DOWN when root dispersion exceeds this many milliseconds (default: 500)',

  // ── system-service, pm2 ──
  system_service_name:
    'Service name for system-service (the systemd unit or Windows service name, no spaces) or the process name for pm2. Required for both.',

  // ── manual ──
  manual_status:
    'manual: the status to report — 1 = UP, 0 = DOWN, null = PENDING. Uptime Kuma does not return this field, so it cannot be read back.',

  // ── conditions (dns, mqtt, and the database types) ──
  conditions:
    'Conditions the result must meet: a list of { type, andOr, variable, operator, value, children }. type is "expression" (compares one variable) or "group" (nests children of the same shape). andOr is "and" (default) or "or" and says how the entry combines with the one before it. variable is "record" for dns; "topic", "message" or "json_value" for mqtt; "result" for mysql, sqlserver and oracledb. operator is one of equals, not_equals, contains, not_contains, starts_with, not_starts_with, ends_with, not_ends_with, and for numeric variables num_equals, num_not_equals, lt, gt, lte, gte. value is a string. When set on mqtt they replace mqttCheckType. Replaced as a whole; pass [] to clear.',
};

export const HTTP_AUTH_FIELDS = [
  'authMethod',
  'basic_auth_user',
  'basic_auth_pass',
  'bearer_token',
  'oauth_token_url',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_scopes',
  'oauth_audience',
  'oauth_auth_method',
];
export const HTTP_REQUEST_FIELDS = [
  'url',
  'method',
  'headers',
  'body',
  'httpBodyEncoding',
  'accepted_statuscodes',
  'maxredirects',
  'ignoreTls',
  'expiryNotification',
  'ipFamily',
  'cacheBust',
  'proxyId',
  'saveResponse',
  'saveErrorResponse',
  'responseMaxLength',
  ...HTTP_AUTH_FIELDS,
  'authDomain',
  'authWorkstation',
  'tlsCert',
  'tlsKey',
  'tlsCa',
];
export const DATABASE_FIELDS = ['databaseConnectionString', 'databaseQuery'];

/**
 * The record types each type can query, as Uptime Kuma 2.5.10 offers them (EditMonitor.vue
 * dnsresolvetypeOptions and globalpingdnsresolvetypeoptions). A dns monitor hands the type to
 * Node's resolver and globalping to the Globalping API; neither list contains the other, so
 * dns_resolve_type accepts both and assertDnsRecordType checks it against the monitor's type.
 */
export const DNS_RECORD_TYPES: Record<string, readonly string[]> = {
  dns: ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'],
  globalping: [
    'A',
    'AAAA',
    'ANY',
    'CNAME',
    'DNSKEY',
    'DS',
    'HTTPS',
    'MX',
    'NS',
    'NSEC',
    'PTR',
    'RRSIG',
    'SOA',
    'SRV',
    'SVCB',
    'TXT',
  ],
};
export const ALL_DNS_RECORD_TYPES = [...new Set(Object.values(DNS_RECORD_TYPES).flat())].sort() as [
  string,
  ...string[],
];

/**
 * The fields each monitor type uses, beyond the ones every type shares (COMMON_MONITOR_FIELDS).
 *
 * Read off what each type's check dereferences (server/monitor-types/*.js and the per-type
 * branches of server/model/monitor.js, Uptime Kuma 2.5.10). It is what getMonitorTypeFields
 * answers from and what the terse advertised descriptions are derived from. It does NOT gate
 * writes: Uptime Kuma stores any field on any type, and refusing one here because this table
 * is behind upstream would be a worse failure than accepting it.
 *
 * domainExpiryNotification is added below, from DOMAIN_EXPIRY_MONITOR_TYPES.
 */
export const MONITOR_TYPE_FIELDS: Record<string, string[]> = {
  http: HTTP_REQUEST_FIELDS,
  keyword: [...HTTP_REQUEST_FIELDS, 'keyword', 'invertKeyword'],
  'json-query': [
    ...HTTP_REQUEST_FIELDS,
    'jsonPath',
    'jsonPathOperator',
    'expectedValue',
    'retryOnlyOnStatusCodeFailure',
  ],
  port: ['hostname', 'port'],
  ping: ['hostname', 'packetSize', 'ping_count', 'ping_numeric', 'ping_per_request_timeout'],
  dns: ['hostname', 'port', 'dns_resolve_server', 'dns_resolve_type', 'conditions'],
  // ignoreTls applies to the connection to a Docker host reached over HTTPS.
  docker: ['docker_container', 'docker_host', 'ignoreTls'],
  mqtt: [
    'hostname',
    'port',
    'mqttTopic',
    'mqttUsername',
    'mqttPassword',
    'mqttCheckType',
    'mqttSuccessMessage',
    'mqttWebsocketPath',
    'jsonPath',
    'expectedValue',
    'conditions',
  ],
  mongodb: [...DATABASE_FIELDS, 'jsonPath', 'expectedValue'],
  redis: ['databaseConnectionString', 'ignoreTls'],
  sqlserver: [...DATABASE_FIELDS, 'conditions'],
  postgres: DATABASE_FIELDS,
  mysql: [...DATABASE_FIELDS, 'databasePassword', 'conditions'],
  oracledb: [...DATABASE_FIELDS, 'basic_auth_user', 'basic_auth_pass', 'conditions'],
  'grpc-keyword': [
    'grpcUrl',
    'grpcProtobuf',
    'grpcServiceName',
    'grpcMethod',
    'grpcBody',
    'grpcMetadata',
    'grpcEnableTls',
    'keyword',
    'invertKeyword',
  ],
  'kafka-producer': [
    'kafkaProducerBrokers',
    'kafkaProducerTopic',
    'kafkaProducerMessage',
    'kafkaProducerSsl',
    'kafkaProducerAllowAutoTopicCreation',
    'kafkaProducerSaslOptions',
  ],
  radius: [
    'hostname',
    'port',
    'radiusUsername',
    'radiusPassword',
    'radiusSecret',
    'radiusCalledStationId',
    'radiusCallingStationId',
  ],
  rabbitmq: ['rabbitmqNodes', 'rabbitmqUsername', 'rabbitmqPassword'],
  smtp: ['hostname', 'port', 'smtpSecurity'],
  snmp: [
    'hostname',
    'port',
    'snmpOid',
    'snmpVersion',
    'snmpCommunity',
    'jsonPath',
    'jsonPathOperator',
    'expectedValue',
  ],
  // The check takes any status from 200 to 399 and never reads accepted_statuscodes or ignoreTls.
  'real-browser': ['url', 'remote_browser', 'screenshot_delay'],
  gamedig: ['hostname', 'port', 'game', 'gamedigGivenPortOnly', 'gamedigToken'],
  // The check also reads ignoreTls, maxredirects and accepted_statuscodes, but only for its call
  // to the Steam Web API, not the game server, so they are not offered as settings of the monitor.
  steam: ['hostname', 'port', 'packetSize'],
  push: ['pushToken'],
  group: [],
  'tailscale-ping': ['hostname'],
  manual: ['manual_status'],
  globalping: [
    'subtype',
    'location',
    'protocol',
    'hostname',
    'url',
    'port',
    'ping_count',
    'dns_resolve_server',
    'dns_resolve_type',
    'method',
    'headers',
    'accepted_statuscodes',
    'ignoreTls',
    'expiryNotification',
    'ipFamily',
    'cacheBust',
    'keyword',
    'invertKeyword',
    'jsonPath',
    'jsonPathOperator',
    'expectedValue',
    ...HTTP_AUTH_FIELDS,
  ],
  ntp: ['hostname', 'port', 'ntpStratumThreshold', 'ntpTimeOffsetThreshold', 'ntpRootDispersionThreshold'],
  'websocket-upgrade': [
    'url',
    'wsSubprotocol',
    'wsIgnoreSecWebsocketAcceptHeader',
    'accepted_statuscodes',
    'headers',
    'ignoreTls',
    ...HTTP_AUTH_FIELDS,
    'tlsCert',
    'tlsKey',
    'tlsCa',
  ],
  sftp: [
    'hostname',
    'port',
    'sshUsername',
    'sshAuthMethod',
    'sshPassword',
    'sshPrivateKey',
    'sshPassphrase',
    'sftpPath',
  ],
  'sip-options': ['hostname', 'port'],
  'system-service': ['system_service_name'],
  pm2: ['system_service_name'],
};

/**
 * The types whose domain registration expiry Uptime Kuma can check: the keys of
 * TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD (src/util.ts, Uptime Kuma 2.5.10), the table
 * DomainExpiry.checkSupport() refuses every other type with. Not the same as the types that
 * check certificate expiry (expiryNotification), which are only the HTTP ones and globalping.
 */
export const DOMAIN_EXPIRY_MONITOR_TYPES = [
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
for (const type of DOMAIN_EXPIRY_MONITOR_TYPES)
  MONITOR_TYPE_FIELDS[type] = [...MONITOR_TYPE_FIELDS[type], 'domainExpiryNotification'];

/** Accepted by every monitor type, so not repeated per type. */
export const COMMON_MONITOR_FIELDS = [
  'name',
  'description',
  'active',
  'parent',
  'interval',
  'retryInterval',
  'maxretries',
  'resendInterval',
  'timeout',
  'upsideDown',
  'notificationIDList',
  'tags',
];

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
export const TypeFieldsSchema = z.strictObject(TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS);
export const looseFieldName = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');
export function parseTypeFields(raw: unknown, topLevel: string[]): Record<string, unknown> {
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
      const match = [...MONITOR_TYPE_FIELD_NAMES, ...topLevel].find(
        (name) => looseFieldName(name) === looseFieldName(key)
      );
      return match
        ? `'${key}' is not a field — did you mean '${match}'?`
        : `'${key}' is not a field of any monitor type`;
    });
  });
  throw new Error(
    `Invalid typeFields: ${problems.join('; ')}. getMonitorTypeFields lists the fields a monitor type accepts and what each takes.`
  );
}

export const TYPE_FIELDS_DESCRIPTION =
  'Fields specific to the monitor type, e.g. {"mqttTopic": "sensors/#"} for mqtt or {"bearer_token": "…"} for an HTTP monitor behind authentication. ' +
  'Call getMonitorTypeFields with the type for the names, meanings and allowed values — they are validated, and an unknown name is refused. ' +
  'getMonitor returns these fields at the top level of the monitor; to change one, pass it here.';

/**
 * The refusal for a type that does not exist. It names the valid ones, so a guess such as
 * "minecraft" (seen in the LLM eval) is put right without another call to listMonitorTypes.
 */
export function unknownMonitorTypeMessage(type: string, valid: Iterable<string>): string {
  return (
    `Unknown monitor type '${type}'. Valid types: ${[...valid].join(', ')}. ` +
    'A game server is gamedig, with the GameDig game ID in typeFields.game (e.g. "minecraft"). listMonitorTypes says what each type checks.'
  );
}
