import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { rehydrateSecrets } from '../redact.js';
import { numeric, requiredId } from './schema.js';
import { normalizeAdvertisedSchema } from './registration.js';
import {
  MONITOR_TYPES,
  MONITOR_TYPE_NAMES,
  TYPE_SPECIFIC_MONITOR_FIELD_SCHEMAS,
  MONITOR_FIELD_DOCS,
  DNS_RECORD_TYPES,
  ALL_DNS_RECORD_TYPES,
  MONITOR_TYPE_FIELDS,
  COMMON_MONITOR_FIELDS,
  MONITOR_TYPE_FIELD_NAMES,
  parseTypeFields,
  TYPE_FIELDS_DESCRIPTION,
  unknownMonitorTypeMessage,
} from '../monitors/fields.js';
import {
  assertMongoQueryIsJson,
  assertDnsRecordType,
  normaliseMonitorAliases,
  FORM_TIMEOUT_DEFAULTS,
  REQUIRED_MONITOR_FIELDS,
  requiredFieldLabel,
  HTTP_AUTH_MONITOR_TYPES,
  HTTP_AUTH_METHODS,
  applyHttpAuthRules,
  rehydrateMonitorUrl,
  inferredAuthNote,
  rehydrateRabbitmqNodes,
  pushURLFor,
  applyMonitorTypeRules,
  verifyMonitorWrite,
} from '../monitors/rules.js';

/** The tools that create, change, pause and delete monitors, and the one that describes a type's fields. */
export function registerMonitorWriteTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, kumaUrl } = ctx;

  // Register pauseMonitor tool
  server.registerTool(
    'pauseMonitor',
    {
      title: 'Pause Monitor',
      description:
        'Pauses a monitor, stopping it from performing checks. The monitor will remain in the system but will not send notifications or collect data until resumed.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to pause'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        const response = await client.pauseMonitor(monitorID);

        return {
          content: [
            {
              type: 'text',
              text: response.msg || `Monitor ${monitorID} paused successfully`,
            },
          ],
          structuredContent: {
            ok: response.ok,
            msg: response.msg,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to pause monitor: ${errorMessage}`);
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
        monitorID: requiredId('The ID of the monitor to resume'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorID }) => {
      await authenticateClient();

      try {
        const response = await client.resumeMonitor(monitorID);

        return {
          content: [
            {
              type: 'text',
              text: response.msg || `Monitor ${monitorID} resumed successfully`,
            },
          ],
          structuredContent: {
            ok: response.ok,
            msg: response.msg,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to resume monitor: ${errorMessage}`);
      }
    }
  );

  // Hoisted out of the registration so getMonitorTypeFields can read the descriptions of the
  // fields declared here (url, hostname, port, …) instead of keeping a second copy of them.
  const createMonitorShape = {
    name: z.string().describe('Display name for the monitor'),
    type: z
      .string()
      .describe('Monitor type (e.g. http, port, ping, dns, push, keyword). Use listMonitorTypes for all options.'),
    description: z.string().nullable().optional().describe('Free-text description shown on the monitor page'),
    active: z
      .boolean()
      .optional()
      .describe('Whether the monitor starts checking immediately (default: true). Pass false to create it paused.'),
    resendInterval: numeric(z.number())
      .optional()
      .describe('Resend notification every N checks while down (0 = disabled, the default)'),
    timeout: numeric(z.number())
      .nullable()
      .optional()
      .describe(
        "Request timeout in SECONDS. Omit for the web form's default: 48, or 10 for ping, 5 for snmp and 1 for kafka-producer, at most 0.8 x interval. Avoid 0: Uptime Kuma's runtime fallback for a stored 0 computes interval * 1000 * 0.8 and then multiplies by 1000 again, yielding a ~13 hour timeout, so the monitor can never report DOWN against a host that accepts the connection and never answers. Push and group monitors do not use it; a 0 stored on one of those is harmless."
      ),
    jsonPath: z
      .string()
      .optional()
      .describe('JSONata expression for json-query monitors. Must resolve to a primitive.'),
    jsonPathOperator: z
      .enum(['>', '>=', '<', '<=', '==', '!=', 'contains'])
      .optional()
      .describe('Comparison operator for json-query monitors. UP while value <operator> expectedValue.'),
    expectedValue: z.coerce
      .string()
      .optional()
      .describe('Threshold the json-query result is compared against. Stored as a string.'),
    pushToken: z
      .string()
      .min(8)
      .optional()
      .describe('Push token for push monitors — the secret in the ping URL. Omit and one is generated and returned.'),
    url: z
      .string()
      .optional()
      .describe(
        'URL to monitor (required for http, keyword and json-query; other types that need it are listed by getMonitorTypeFields)'
      ),
    hostname: z
      .string()
      .optional()
      .describe(
        'Hostname or IP address to check (required for port, ping and dns, and most non-HTTP types — see getMonitorTypeFields)'
      ),
    port: numeric(z.number())
      .optional()
      .describe('Port number (required for port; see getMonitorTypeFields for other types)'),
    interval: numeric(z.number().min(1))
      .optional()
      .describe('Check interval in seconds (default: 60, or 300 for ntp; min: 1)'),
    retryInterval: numeric(z.number().min(1))
      .optional()
      .describe('Retry interval in seconds when monitor is down (default: the interval, min: 1)'),
    maxretries: numeric(z.number()).optional().describe('Max retries before marking as down (default: 0)'),
    notificationIDList: z
      .record(z.string(), z.boolean())
      .optional()
      .describe('Map of notification IDs to enable (e.g. {"1": true, "3": true})'),
    tags: z
      .array(
        z.object({
          name: z.string(),
          value: z.string().optional(),
          color: z.string().optional(),
        })
      )
      .optional()
      .describe('Tags to assign to the monitor'),
    keyword: z.string().optional().describe('Keyword to search for (keyword monitor type)'),
    invertKeyword: z.boolean().optional().describe('Invert keyword match'),
    method: z.string().optional().describe('HTTP method (GET, POST, etc.) for http type'),
    body: z.string().optional().describe('HTTP request body'),
    headers: z.string().optional().describe('HTTP headers as JSON string'),
    accepted_statuscodes: z.array(z.string()).optional().describe('Accepted HTTP status codes (e.g. ["200-299"])'),
    ignoreTls: z.boolean().optional().describe('Ignore TLS/SSL errors'),
    maxredirects: numeric(z.number()).optional().describe('Max HTTP redirects (default: 10)'),
    upsideDown: z.boolean().optional().describe('Invert status — treat up as down'),
    expiryNotification: z
      .boolean()
      .optional()
      .describe('Notify before the TLS certificate expires (http, keyword, json-query, globalping)'),
    domainExpiryNotification: z
      .boolean()
      .optional()
      .describe(
        'Notify before the domain registration expires (most types with a url or hostname; see getMonitorTypeFields). Needs Uptime Kuma 2.1 or later.'
      ),
    parent: numeric(z.number()).nullable().optional().describe('Parent group monitor ID'),
    docker_container: z.string().optional().describe('Docker container name (required for docker type)'),
    docker_host: numeric(z.number())
      .optional()
      .describe('Docker host ID (required for docker type). Use listDockerHosts to find available IDs.'),
    dns_resolve_server: z
      .string()
      .optional()
      .describe('DNS server to use for resolution (required for dns type, default: 1.1.1.1)'),
    dns_resolve_type: z
      .enum(ALL_DNS_RECORD_TYPES)
      .optional()
      .describe(
        'DNS record type to query, for dns and globalping (default: A). Which types each supports: getMonitorTypeFields'
      ),
    databaseConnectionString: z
      .string()
      .optional()
      .describe(
        'Connection string for mysql, postgres, mongodb, redis, sqlserver and oracledb monitors (required for those types). For oracledb the login goes in basic_auth_user and basic_auth_pass. A credential: read tools return it as "***" unless includeSecrets is set.'
      ),
    databaseQuery: z
      .string()
      .optional()
      .describe(
        'Query for database monitors. SQL for mysql, postgres and sqlserver (default: SELECT 1) and oracledb (default: SELECT 1 FROM DUAL); a JSON command object for mongodb (default: {"ping": 1}).'
      ),
    databasePassword: z
      .string()
      .optional()
      .describe(
        'Password for mysql monitors, if not inline in the connection string. Stored by Uptime Kuma as radiusPassword. A credential: read tools return it as "***".'
      ),
    radiusPassword: z
      .string()
      .optional()
      .describe(
        'The RADIUS password (required for radius). Also the column databasePassword and typeFields.snmpCommunity are stored in — prefer those names for mysql and snmp.'
      ),
    typeFields: z.record(z.string(), z.unknown()).optional().describe(TYPE_FIELDS_DESCRIPTION),
  };

  // Which defaults this server fills in, and which fields depend on another field's value.
  // Everything here restates a rule enforced in applyMonitorTypeRules / applyHttpAuthRules.
  const MONITOR_TYPE_NOTES: Record<string, string[]> = {
    dns: [
      'dns_resolve_server defaults to 1.1.1.1 and dns_resolve_type to A.',
      `dns_resolve_type is one of ${DNS_RECORD_TYPES.dns.join(', ')}.`,
    ],
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
      `For subtype "dns", dns_resolve_type defaults to A and is one of ${DNS_RECORD_TYPES.globalping.join(', ')}. Uptime Kuma stores it in a 5-character column, so on a MariaDB or MySQL database DNSKEY may be refused or cut short.`,
    ],
    sftp: ['sshAuthMethod "password" (the default) requires sshPassword; "privateKey" requires sshPrivateKey.'],
    mongodb: [
      'databaseQuery must be a JSON command object, e.g. {"ping": 1}.',
      'Optionally, jsonPath (a JSONata expression) picks a value out of the command result, which is DOWN when it finds nothing, and expectedValue is a string that value must equal. jsonPathOperator is not used.',
    ],
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
    const description = (MONITOR_FIELD_DOCS as Record<string, string>)[name] ?? schema?.description ?? '';
    // Type and allowed values, without the description the entry already carries.
    let accepts: Record<string, unknown> = {};
    try {
      const {
        description: _d,
        $schema: _s,
        ...rest
      } = z.toJSONSchema(schema, {
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
    in: z
      .enum(['top-level', 'typeFields'])
      .describe('Where to pass it: as an argument of createMonitor / updateMonitor, or inside their typeFields object'),
    description: z.string(),
    accepts: z.record(z.string(), z.unknown()).describe('JSON Schema of the value: its type and any allowed values'),
  });

  server.registerTool(
    'getMonitorTypeFields',
    {
      title: 'Get Monitor Type Fields',
      description:
        'Describes the fields one monitor type uses: which are required, which are optional, what each means and accepts, and the defaults applied when they are omitted. Call this before createMonitor, or before updateMonitor changes a type or sets type-specific fields: most of them go in the typeFields argument of those tools, which is not described there.',
      inputSchema: {
        type: z.string().describe('The monitor type, e.g. http, mqtt, snmp. Use listMonitorTypes for all options.'),
      },
      outputSchema: {
        type: z.string(),
        description: z.string().describe('What this monitor type checks'),
        required: z
          .array(MonitorFieldDescription)
          .describe(
            'Fields a monitor of this type cannot work without. A create or type change without them is refused.'
          ),
        optional: z.array(MonitorFieldDescription).describe('Other fields this type uses'),
        notes: z
          .array(z.string())
          .describe('Defaults applied when a field is omitted, and fields that become required depending on another'),
        commonFields: z.array(z.string()).describe('Fields every monitor type accepts, described on createMonitor'),
      },
    },
    async ({ type }) => {
      const known = MONITOR_TYPES.find((t) => t.type === type);
      if (!known) {
        throw new McpError(ErrorCode.InvalidParams, unknownMonitorTypeMessage(type, MONITOR_TYPE_NAMES));
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
              .join('; ') +
            '.'
        );
      }
      if (type !== 'push' && type !== 'group') {
        const timeout = FORM_TIMEOUT_DEFAULTS[type] ?? 48;
        notes.push(
          `timeout defaults to ${timeout} seconds${type === 'ping' ? '' : ', or 0.8 x interval if that is less'}.`
        );
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
      description:
        'Creates a new monitor in Uptime Kuma. Requires at minimum a name and type. Use listMonitorTypes to see supported types; prefer one made for the service (e.g. gamedig for a game server) over a port check. For HTTP monitors include url; for TCP/port monitors include hostname and port; for ping and dns include hostname; for json-query include url, jsonPath, jsonPathOperator and expectedValue; for database types (mysql, postgres, mongodb, redis, sqlserver, oracledb) include databaseConnectionString. For any other type, and for anything type-specific such as HTTP authentication, call getMonitorTypeFields first: it lists the required and optional fields of the type, what each means, and whether it is passed at the top level or inside typeFields. A create without the required fields of its type is refused rather than saved as a monitor that fails every check. For an HTTP monitor behind authentication pass the credentials in typeFields (basic_auth_user and basic_auth_pass, or bearer_token) and authMethod is set to match. Never pass "***" for a credential. A push monitor is given a generated push token (Uptime Kuma only generates one in its own web UI) and the resulting ping URL is returned. Omitted settings get the web form\'s defaults: interval 60 (300 for ntp), retryInterval equal to interval, and a per-type timeout.',
      inputSchema: createMonitorShape,
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
        pushToken: z
          .string()
          .optional()
          .describe('Push monitors only. The token, so the sender can be wired up without a second, wider read.'),
        pushURL: z.string().optional().describe('Push monitors only. The URL the sender should GET.'),
        timeout: z
          .number()
          .optional()
          .describe('The timeout in seconds actually stored, including the default applied when omitted.'),
        authMethod: z
          .string()
          .optional()
          .describe('Only when authMethod was inferred from the credentials passed. The method that was stored.'),
      },
    },
    async (input) => {
      await authenticateClient();

      try {
        const defaults: Record<string, unknown> = {
          notificationIDList: {} as Record<string, boolean>,
          accepted_statuscodes: ['200-299'],
          conditions: [] as string[],
        };

        // typeFields is flattened into the monitor here: Uptime Kuma's payload is one flat object.
        const { typeFields, ...topLevel } = input as Record<string, unknown>;
        const requested = normaliseMonitorAliases({
          ...topLevel,
          ...parseTypeFields(typeFields, Object.keys(createMonitorShape)),
        });

        // What the web form starts a new monitor with, where the column default differs.
        // Set on `requested` rather than `defaults` because the timeout default below is
        // derived from the interval. The interval column defaults to 20, retry_interval to 0
        // and expiry_notification to true.
        if (requested.interval === undefined) requested.interval = requested.type === 'ntp' ? 300 : 60;
        // The form moves the retry interval along with the interval while the two are equal.
        if (requested.retryInterval === undefined) requested.retryInterval = requested.interval;
        if (requested.expiryNotification === undefined) requested.expiryNotification = false;

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
            ? await verifyMonitorWrite(client, response.monitorID, requested, 'created')
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
          const push = await pushURLFor(client, kumaUrl, requested.pushToken);
          structuredContent.pushURL = push.url;
          text += `\n\nPush monitor ${response.monitorID}: point the sender at (GET, not POST)\n  ${push.url}\n${push.note} This URL contains a secret — treat it as a credential.${generatedPushToken ? ' The token was generated because Uptime Kuma only ever generates one in its own web UI.' : ''}`;
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
      description:
        'Updates an existing monitor configuration. You must include the monitorID. Only the fields you provide will be changed (the server merges your changes with the existing config). Use getMonitor first to get the current config. Passing a different type converts the monitor in place, keeping its ID and history: the new type must have the fields it needs, passed here or already stored (e.g. url for http, hostname for ping), and a monitor becoming push is given a push token if it has none. Type-specific fields go in typeFields; call getMonitorTypeFields for their names and meanings. Credentials read back as "***"; sending "***" keeps the stored value.',
      inputSchema: {
        monitorID: requiredId('The ID of the monitor to update'),
        // `parent` was declared on createMonitor but not here, so an existing monitor could
        // never be moved into or out of a group (issue #63). The merge below then folded the
        // old value back in and Uptime Kuma replied "Saved." — a no-op reported as success.
        parent: numeric(z.number().int())
          .nullable()
          .optional()
          .describe(
            'Parent group monitor ID — re-parents this monitor into that group. Pass null to move it to the top level.'
          ),
        description: z.string().nullable().optional().describe('Free-text description shown on the monitor page'),
        // editMonitor assigns bean.type = monitor.type.
        type: z
          .string()
          .optional()
          .describe(
            'Change the monitor type in place (e.g. ping -> http), keeping its ID, history and notifications. Pass the fields the new type needs in the same call (e.g. url for http). A group cannot be converted. Use listMonitorTypes for all options.'
          ),
        resendInterval: numeric(z.number())
          .optional()
          .describe('Resend notification every N checks while down (0 = disabled)'),
        timeout: numeric(z.number())
          .nullable()
          .optional()
          .describe(
            "Request timeout in SECONDS. Avoid 0 — Uptime Kuma's runtime fallback for a stored 0 yields a ~13 hour timeout, so the monitor can never report DOWN against a black-holed endpoint."
          ),
        jsonPath: z
          .string()
          .optional()
          .describe('JSONata expression for json-query monitors. Must resolve to a primitive.'),
        jsonPathOperator: z
          .enum(['>', '>=', '<', '<=', '==', '!=', 'contains'])
          .optional()
          .describe('Comparison operator for json-query monitors.'),
        expectedValue: z.coerce
          .string()
          .optional()
          .describe('Threshold the json-query result is compared against, stored as a string.'),
        pushToken: z
          .string()
          .min(8)
          .optional()
          .describe(
            'Push token — the secret in the ping URL. Changing it invalidates the existing URL and any sender still using it stops beating.'
          ),
        name: z.string().optional().describe('Display name'),
        url: z.string().optional().describe('URL to monitor'),
        hostname: z.string().optional().describe('Hostname'),
        port: numeric(z.number()).optional().describe('Port number'),
        interval: numeric(z.number().min(1)).optional().describe('Check interval in seconds (min: 1)'),
        retryInterval: numeric(z.number().min(1)).optional().describe('Retry interval in seconds (min: 1)'),
        maxretries: numeric(z.number()).optional().describe('Max retries before marking as down'),
        notificationIDList: z.record(z.string(), z.boolean()).optional().describe('Notification ID map'),
        tags: z
          .array(
            z.object({
              name: z.string(),
              value: z.string().optional(),
              color: z.string().optional(),
            })
          )
          .optional()
          .describe('Tags to assign'),
        keyword: z.string().optional().describe('Keyword to search for'),
        invertKeyword: z.boolean().optional().describe('Invert keyword match'),
        method: z.string().optional().describe('HTTP method'),
        body: z.string().optional().describe('HTTP request body'),
        headers: z.string().optional().describe('HTTP headers as JSON string'),
        accepted_statuscodes: z.array(z.string()).optional().describe('Accepted HTTP status codes'),
        ignoreTls: z.boolean().optional().describe('Ignore TLS/SSL errors'),
        maxredirects: numeric(z.number()).optional().describe('Max HTTP redirects'),
        upsideDown: z.boolean().optional().describe('Invert status'),
        expiryNotification: z
          .boolean()
          .optional()
          .describe('Notify before the TLS certificate expires (http, keyword, json-query, globalping)'),
        domainExpiryNotification: z
          .boolean()
          .optional()
          .describe(
            'Notify before the domain registration expires (most types with a url or hostname; see getMonitorTypeFields). Needs Uptime Kuma 2.1 or later.'
          ),
        active: z.boolean().optional().describe('Whether the monitor is active'),
        docker_container: z.string().optional().describe('Docker container name (required for docker type)'),
        docker_host: numeric(z.number())
          .optional()
          .describe('Docker host ID (required for docker type). Use listDockerHosts to find available IDs.'),
        dns_resolve_server: z.string().optional().describe('DNS server to use for resolution (for dns type)'),
        dns_resolve_type: z
          .enum(ALL_DNS_RECORD_TYPES)
          .optional()
          .describe(
            'DNS record type to query, for dns and globalping. Which types each supports: getMonitorTypeFields'
          ),
        databaseConnectionString: z
          .string()
          .optional()
          .describe(
            'Connection string for mysql, postgres, mongodb, redis, sqlserver and oracledb monitors. A credential: read tools return "***", and sending "***" back keeps the stored value.'
          ),
        databaseQuery: z
          .string()
          .optional()
          .describe(
            'Query for database monitors. SQL for mysql, postgres, sqlserver and oracledb; a JSON command object for mongodb.'
          ),
        databasePassword: z
          .string()
          .optional()
          .describe(
            'Password for mysql monitors, stored by Uptime Kuma as radiusPassword. Sending "***" back keeps the stored value.'
          ),
        radiusPassword: z
          .string()
          .optional()
          .describe(
            'The RADIUS password (required for radius). Also the column databasePassword and typeFields.snmpCommunity are stored in — prefer those names for mysql and snmp.'
          ),
        typeFields: z.record(z.string(), z.unknown()).optional().describe(TYPE_FIELDS_DESCRIPTION),
      },
      outputSchema: {
        ok: z.boolean(),
        monitorID: z.number().optional(),
        msg: z.string().optional(),
        pushToken: z
          .string()
          .optional()
          .describe('Only when the type was changed to push. The token, generated if the monitor had none.'),
        pushURL: z
          .string()
          .optional()
          .describe('Only when the type was changed to push. The URL the sender should GET.'),
        authMethod: z
          .string()
          .optional()
          .describe('Only when authMethod was inferred from the credentials passed. The method that was stored.'),
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
          throw new Error(
            `Monitor ${monitorID} is a group; changing its type would detach all of its child monitors. Move the children out first, or delete and recreate the group.`
          );
        }
        // Strip undefined values so existing config is preserved for omitted fields, and flatten
        // typeFields in beside them: Uptime Kuma's payload is one flat object.
        const { typeFields, ...topLevel } = rest as Record<string, unknown>;
        const defined: Record<string, unknown> = {
          ...Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v !== undefined)),
          ...parseTypeFields(typeFields, ['monitorID', ...Object.keys(topLevel)]),
        };
        normaliseMonitorAliases(defined);
        assertMongoQueryIsJson(defined.type ?? existing.type, defined.databaseQuery);
        assertDnsRecordType(defined.type ?? existing.type, defined.dns_resolve_type);

        // Issue #59: a caller that read this monitor back holds "***" where a credential
        // was, and the natural edit-one-field-and-write-it-back loop would then persist
        // the marker. Restore the stored value instead. Runs AFTER alias normalisation so
        // `databasePassword: "***"` is matched against the stored `radiusPassword`.
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
        if (rehydrateMonitorUrl(defined, (existing as unknown as Record<string, unknown>).url))
          preserved.push('the credentials in url');

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
        if (!merged.retryInterval || merged.retryInterval < 1) {
          merged.retryInterval = merged.interval || 60;
        }
        const response = await client.updateMonitor(merged as unknown as Record<string, unknown>);

        // Verify against what the CALLER asked for (`defined`), not the merged object —
        // re-checking fields that were only carried over from the existing config would
        // prove nothing about this write.
        const verifyProblem = await verifyMonitorWrite(client, monitorID, defined, 'saved');

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
          const push = await pushURLFor(client, kumaUrl, pushToken);
          structuredContent.pushURL = push.url;
          text += `\n\nMonitor ${monitorID} is now a push monitor: point the sender at (GET, not POST)\n  ${push.url}\n${push.note} This URL contains a secret — treat it as a credential.`;
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
}
