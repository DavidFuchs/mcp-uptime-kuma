import { z } from 'zod';
import { MonitorBaseSchema, type MonitorBase } from './monitor-base.js';
import { OAuth2Schema, KafkaProducerSaslOptionsSchema } from './monitor-auth.js';

/**
 * HTTP/HTTPS Monitor Schema
 */
export const HttpMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('http'),
  url: z.string().url().describe('Full URL to monitor'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  headers: z.string().optional().describe('HTTP headers as JSON string'),
  body: z.string().optional().describe('Request body (JSON string or other)'),
  httpBodyEncoding: z.enum(['json', 'xml', 'form']).optional().describe('Body encoding format'),
  ipFamily: z.enum(['4', '6']).nullable().optional().describe('IP version (4 or 6)'),

  // Authentication
  basic_auth_user: z.string().optional().describe('HTTP Basic auth username'),
  basic_auth_pass: z.string().optional().describe('HTTP Basic auth password'),
  authMethod: z.enum(['ntlm', 'bearer']).nullable().optional().describe('Auth method'),
  authWorkstation: z.string().optional().describe('NTLM workstation'),
  authDomain: z.string().optional().describe('NTLM domain'),

  // TLS/SSL
  ignoreTls: z.boolean().default(false).describe('Ignore TLS/SSL errors'),
  tlsCa: z.string().optional().describe('TLS CA certificate'),
  tlsCert: z.string().optional().describe('TLS client certificate'),
  tlsKey: z.string().optional().describe('TLS client key'),
  expiryNotification: z.boolean().default(false).describe('Certificate expiry notifications'),

  // Advanced
  maxredirects: z.number().default(10).describe('Maximum HTTP redirects'),
  cacheBust: z.boolean().default(false).describe('Add cache-busting query parameter'),
  proxyId: z.number().nullable().optional().describe('Proxy ID (null for none)'),
}).merge(OAuth2Schema);

/**
 * Keyword Monitor Schema (extends HTTP)
 */
export const KeywordMonitorSchema = HttpMonitorSchema.extend({
  type: z.literal('keyword'),
  keyword: z.string().optional().describe('Text to search for'),
  invertKeyword: z.boolean().optional().describe('Invert keyword match'),
});

/**
 * JSON Query Monitor Schema (extends HTTP)
 */
export const JsonQueryMonitorSchema = HttpMonitorSchema.extend({
  type: z.literal('json-query'),
  jsonPath: z.string().optional().describe('JSON path query'),
  expectedValue: z.string().optional().describe('Expected value'),
  jsonPathOperator: z.string().optional().describe('Comparison operator'),
});

/**
 * TCP Monitor Schema
 */
export const TcpMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('port'),
  hostname: z.string().describe('Hostname or IP address'),
  port: z.number().min(1).max(65535).describe('TCP port number'),
});

/**
 * Ping Monitor Schema
 */
export const PingMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('ping'),
  hostname: z.string().describe('Hostname or IP address to ping'),
  packetSize: z.number().default(56).describe('Ping packet size in bytes'),
  ping_numeric: z.boolean().default(true).describe('Use numeric output only'),
  ping_count: z.number().default(3).describe('Number of ping packets to send'),
  ping_per_request_timeout: z.number().default(2).describe('Per-request timeout in seconds'),
});

/**
 * DNS Monitor Schema
 */
export const DnsMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('dns'),
  hostname: z.string().describe('Hostname to resolve'),
  port: z.number().optional().describe('DNS server port'),
  dns_resolve_server: z.string().default('1.1.1.1').describe('DNS server to use'),
  dns_resolve_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'CAA']).default('A').describe('DNS record type'),
  dns_last_result: z.string().optional().describe('Last DNS resolution result'),
});

/**
 * Docker Monitor Schema
 */
export const DockerMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('docker'),
  docker_container: z.string().describe('Docker container name'),
  docker_host: z.number().describe('Docker host ID (required)'),
});

/**
 * MQTT Monitor Schema
 */
export const MqttMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('mqtt'),
  hostname: z.string().describe('MQTT broker hostname'),
  port: z.number().describe('MQTT broker port'),
  mqttUsername: z.string().optional().describe('MQTT username'),
  mqttPassword: z.string().optional().describe('MQTT password'),
  mqttTopic: z.string().describe('MQTT topic to subscribe to'),
  mqttSuccessMessage: z.string().optional().describe('Expected success message'),
  mqttCheckType: z.string().default('keyword').describe('Check type'),
  mqttWebsocketPath: z.string().optional().describe('WebSocket path (if using MQTT over WebSocket)'),
});

/**
 * Database Monitor Schema (MongoDB, Redis, SQL Server, Postgres, MySQL, MariaDB)
 */
export const DatabaseMonitorSchema = MonitorBaseSchema.extend({
  type: z.enum(['mongodb', 'redis', 'sqlserver', 'postgres', 'mysql']),
  databaseConnectionString: z.string().describe('Database connection string'),
  databaseQuery: z.string().optional().describe('SQL query to execute (for SQL databases)'),
});

/**
 * gRPC Monitor Schema
 */
export const GrpcMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('grpc-keyword'),
  grpcUrl: z.string().describe('gRPC server URL'),
  grpcProtobuf: z.string().describe('Protobuf definition'),
  grpcServiceName: z.string().describe('gRPC service name'),
  grpcMethod: z.string().describe('gRPC method name'),
  grpcBody: z.string().optional().describe('Request body as JSON string'),
  grpcMetadata: z.string().optional().describe('gRPC metadata as JSON string'),
  grpcEnableTls: z.boolean().default(false).describe('Enable TLS for gRPC'),
});

/**
 * Kafka Producer Monitor Schema
 */
export const KafkaMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('kafka-producer'),
  kafkaProducerTopic: z.string().describe('Kafka topic'),
  kafkaProducerBrokers: z.array(z.string()).describe('Array of Kafka broker URLs'),
  kafkaProducerMessage: z.string().describe('Message to send'),
  kafkaProducerSsl: z.boolean().default(false).describe('Enable SSL'),
  kafkaProducerAllowAutoTopicCreation: z.boolean().default(false).describe('Allow automatic topic creation'),
  kafkaProducerSaslOptions: KafkaProducerSaslOptionsSchema.optional().describe('SASL authentication options'),
});

/**
 * RADIUS Monitor Schema
 */
export const RadiusMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('radius'),
  hostname: z.string().describe('RADIUS server hostname'),
  port: z.number().describe('RADIUS server port'),
  radiusUsername: z.string().describe('RADIUS username'),
  radiusPassword: z.string().describe('RADIUS password'),
  radiusSecret: z.string().describe('RADIUS shared secret'),
  radiusCalledStationId: z.string().optional().describe('Called Station ID'),
  radiusCallingStationId: z.string().optional().describe('Calling Station ID'),
});

/**
 * RabbitMQ Monitor Schema
 */
export const RabbitmqMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('rabbitmq'),
  rabbitmqNodes: z.array(z.string().url()).min(1).describe('Array of RabbitMQ node URLs (http:// or https://)'),
  rabbitmqUsername: z.string().optional().describe('RabbitMQ username'),
  rabbitmqPassword: z.string().optional().describe('RabbitMQ password'),
});

/**
 * SMTP Monitor Schema
 */
export const SmtpMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('smtp'),
  hostname: z.string().describe('SMTP server hostname'),
  port: z.number().describe('SMTP server port'),
  smtpSecurity: z.string().optional().describe('SMTP security protocol'),
});

/**
 * SNMP Monitor Schema
 */
export const SnmpMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('snmp'),
  hostname: z.string().describe('SNMP device hostname'),
  port: z.number().describe('SNMP port'),
  snmpOid: z.string().describe('SNMP OID to query'),
  snmpVersion: z.string().describe('SNMP version'),
});

/**
 * Real Browser Monitor Schema
 */
export const RealBrowserMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('real-browser'),
  url: z.string().url().describe('URL to monitor with real browser'),
  remote_browser: z.number().describe('Remote browser instance ID'),
});

/**
 * GameDig Monitor Schema
 */
export const GameDigMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('gamedig'),
  game: z.string().describe('Game server type'),
  hostname: z.string().describe('Game server hostname'),
  port: z.number().describe('Game server port'),
  gamedigGivenPortOnly: z.boolean().default(true).describe('Use only the given port'),
});

/**
 * Push Monitor Schema
 */
export const PushMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('push'),
  pushToken: z.string().optional().describe('Push token (auto-generated if not provided)'),
});

/**
 * Group Monitor Schema
 */
export const GroupMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('group'),
  name: z.string().describe('Group name'),
  parent: z.number().nullable().optional().describe('Parent group ID (null for root)'),
});

/**
 * Tailscale Ping Monitor Schema
 */
export const TailscalePingMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('tailscale-ping'),
  hostname: z.string().describe('Tailscale hostname'),
});

/**
 * Manual Monitor Schema
 */
export const ManualMonitorSchema = MonitorBaseSchema.extend({
  type: z.literal('manual'),
  manual_status: z.enum(['up', 'down', 'pending', 'maintenance']).optional().describe('Manual status'),
});

/**
 * Union of all monitor types for creation/editing
 */
export const MonitorSchema = z.discriminatedUnion('type', [
  HttpMonitorSchema,
  KeywordMonitorSchema,
  JsonQueryMonitorSchema,
  TcpMonitorSchema,
  PingMonitorSchema,
  DnsMonitorSchema,
  DockerMonitorSchema,
  MqttMonitorSchema,
  DatabaseMonitorSchema,
  GrpcMonitorSchema,
  KafkaMonitorSchema,
  RadiusMonitorSchema,
  RabbitmqMonitorSchema,
  SmtpMonitorSchema,
  SnmpMonitorSchema,
  RealBrowserMonitorSchema,
  GameDigMonitorSchema,
  PushMonitorSchema,
  GroupMonitorSchema,
  TailscalePingMonitorSchema,
  ManualMonitorSchema,
]);

/**
 * Monitor type inferred from schema (full type-specific details)
 */
export type Monitor = z.infer<typeof MonitorSchema>;

/**
 * Helper type for monitor creation (omit read-only fields)
 */
export type MonitorCreate = Omit<Monitor, 'id' | 'user_id' | 'maintenance' | 'path' | 'pathName' | 'childrenIDs' | 'forceInactive' | 'includeSensitiveData'>;

/**
 * Helper type for monitor update (requires id)
 */
export type MonitorUpdate = Partial<Monitor> & { id: number };

/**
 * Extended runtime data fields (uptime, avgPing)
 * These fields are calculated and cached separately by the client
 */
export type MonitorExtendedData = {
  uptime?: { [periodKey: string]: number };
  avgPing?: number | null;
};

/**
 * Monitor base with extended runtime data (uptime, avgPing)
 * Used when includeTypeSpecificFields is false - returns only common fields
 */
export type MonitorBaseWithExtendedData = MonitorBase & MonitorExtendedData;

/**
 * Full monitor with extended runtime data (uptime, avgPing)
 * Used when includeTypeSpecificFields is true - returns all fields including type-specific ones
 * Extends the full Monitor discriminated union with additional runtime fields
 * that are calculated and cached separately by the client
 */
export type MonitorWithExtendedData = Monitor & MonitorExtendedData;

/**
 * Raw monitor data from Uptime Kuma server (for internal caching)
 * This represents unvalidated data as received from the WebSocket API.
 * Contains all fields in a flat structure with an index signature for unknown fields.
 */
export interface MonitorRawData {
  // Core fields (always present)
  id: number;
  name: string;
  type: string;
  active: boolean;
  pathName: string;
  maintenance: boolean;
  interval: number;
  retryInterval: number;
  resendInterval: number;
  maxretries: number;
  
  // Common optional fields
  description?: string;
  parent?: number | null;
  weight?: number;
  timeout?: number;
  upsideDown?: boolean;
  accepted_statuscodes?: string[];
  notificationIDList?: { [key: string]: boolean };
  tags?: Array<{
    tag_id?: number;
    monitor_id?: number;
    name: string;
    color: string;
    value?: string;
  }>;
  user_id?: number;
  path?: string[];
  childrenIDs?: number[];
  forceInactive?: boolean;
  includeSensitiveData?: boolean;
  
  // Runtime fields
  uptime?: { [periodKey: string]: number };
  avgPing?: number | null;
  
  // Type-specific fields (vary by monitor type)
  url?: string;
  method?: string;
  hostname?: string;
  port?: number | null;
  accepted_statuscodes_json?: string;
  conditions?: any[];
  
  // Allow any other fields from Uptime Kuma
  [key: string]: any;
}
