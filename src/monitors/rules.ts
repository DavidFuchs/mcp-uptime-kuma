/**
 * The rules a monitor write has to satisfy, and the checks that it was stored as asked.
 * Shared by createMonitor and updateMonitor.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { UptimeKumaClient } from '../uptime-kuma-client.js';
import { rehydrateUrlCredentials } from '../redact.js';
import {
  MONITOR_TYPE_NAMES,
  HOST_CHANGED_MARKER_ERROR,
  DNS_RECORD_TYPES,
  unknownMonitorTypeMessage,
} from './fields.js';

// Names this server accepts for a value Uptime Kuma keeps under a name nobody would guess.
//
// These are NOT spelling variants. Uptime Kuma reads exactly one name per field, and this
// server used to accept a second spelling for some (json_path for jsonPath, push_token,
// parent_id, …) so that a reasonable guess did not silently do nothing. Unknown fields are
// now refused with the accepted spelling named, which does that job without a second name
// for the same field, so those were removed.
export const MONITOR_FIELD_ALIASES: Record<string, string> = {
  // Uptime Kuma's mysql monitor reads its password from the RADIUS column
  // (server/monitor-types/mysql.js: `monitor.radiusPassword`); nobody would guess that name.
  databasePassword: 'radiusPassword',
  // The snmp monitor reads its community string from the same column
  // (server/monitor-types/snmp.js: `snmp.createSession(monitor.hostname, monitor.radiusPassword, …)`).
  snmpCommunity: 'radiusPassword',
};

// Types whose check is a connection to databaseConnectionString (#106). Without one, Uptime
// Kuma creates the monitor and then fails every check against an empty connection string.
export const DATABASE_MONITOR_TYPES = new Set(['mysql', 'postgres', 'mongodb', 'redis', 'sqlserver', 'oracledb']);

// A mongodb monitor's databaseQuery is a JSON command that Uptime Kuma JSON.parses on every
// check, so a malformed one is accepted on save and then fails every beat.
export const assertMongoQueryIsJson = (type: unknown, query: unknown): void => {
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

// A record type the monitor's type cannot query is saved, then fails every check.
export const assertDnsRecordType = (type: unknown, recordType: unknown): void => {
  const supported = DNS_RECORD_TYPES[String(type)];
  if (!supported || recordType === undefined || recordType === null || supported.includes(String(recordType))) return;
  throw new Error(`A ${type} monitor cannot query ${recordType} records. It supports ${supported.join(', ')}.`);
};

export const normaliseMonitorAliases = (fields: Record<string, unknown>): Record<string, unknown> => {
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
export const generatePushToken = (): string => {
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

// The timeout the web form gives a new monitor (EditMonitor.vue, the "monitor.type" watcher):
// 5 s for snmp, 10 s for ping, 1 s for kafka-producer and 48 s otherwise, held to 80% of the
// interval by clampTimeout() for every type but ping. Storing it at creation also means
// Uptime Kuma's runtime fallback for a 0 timeout, whose unit handling is wrong, never runs.
// push and group never use it, but the form stores 48 for them too, and a stored 0 reads as
// the broken value the timeout description warns about.
export const FORM_TIMEOUT_DEFAULTS: Record<string, number> = { snmp: 5, ping: 10, 'kafka-producer': 1 };
export const defaultTimeoutForInterval = (type: string, interval?: number): number => {
  const timeout = FORM_TIMEOUT_DEFAULTS[type] ?? 48;
  // Monitor.validate() rejects a ping timeout outside PING_GLOBAL_TIMEOUT_MIN/MAX (1..300).
  if (type === 'ping') return timeout;
  return Math.min(timeout, Math.floor((interval ?? 60) * 8) / 10);
};

// The web UI's form stores its "https://" placeholder in url for types that never use it.
// "wss://" is the same placeholder for websocket-upgrade. An empty list (kafkaProducerBrokers,
// rabbitmqNodes) names no target either.
export const isBlank = (v: unknown): boolean =>
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
export const REQUIRED_MONITOR_FIELDS: Record<string, string[]> = {
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
  // Both station IDs are sent in every request, and Uptime Kuma's RADIUS library cannot encode
  // an unset one, so without them every check fails. The web form requires both.
  radius: [
    'hostname',
    'radiusUsername',
    'radiusPassword',
    'radiusSecret',
    'radiusCalledStationId',
    'radiusCallingStationId',
  ],
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
export const requiredFieldLabel = (type: string, field: string): string =>
  type === 'snmp' && field === 'radiusPassword' ? 'snmpCommunity' : field;

// The types whose check sends HTTP credentials, and only those of `authMethod`
// (server/model/monitor.js: `if (this.auth_method === "basic")`, …; websocket-upgrade.js and
// globalping.js read the same fields). oracledb also reads basic_auth_user/pass, but as its
// database login and with no authMethod, so it is deliberately absent.
export const HTTP_AUTH_MONITOR_TYPES = new Set(['http', 'keyword', 'json-query', 'websocket-upgrade', 'globalping']);

// The credential fields each method sends. `needs` is what the method cannot work without.
export const HTTP_AUTH_METHODS: Record<string, { fields: string[]; needs: string[] }> = {
  basic: { fields: ['basic_auth_user', 'basic_auth_pass'], needs: ['basic_auth_user'] },
  ntlm: {
    fields: ['basic_auth_user', 'basic_auth_pass', 'authDomain', 'authWorkstation'],
    needs: ['basic_auth_user'],
  },
  bearer: { fields: ['bearer_token'], needs: ['bearer_token'] },
  'oauth2-cc': {
    fields: [
      'oauth_token_url',
      'oauth_client_id',
      'oauth_client_secret',
      'oauth_scopes',
      'oauth_audience',
      'oauth_auth_method',
    ],
    needs: ['oauth_token_url', 'oauth_client_id', 'oauth_client_secret'],
  },
  mtls: { fields: ['tlsCert', 'tlsKey', 'tlsCa'], needs: ['tlsCert', 'tlsKey'] },
};

// Which method a credential field implies when authMethod is not set. Tried in this order,
// so basic_auth_user alongside authDomain means ntlm rather than basic.
export const HTTP_AUTH_INFERENCE: Array<[string, string[]]> = [
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
export const applyHttpAuthRules = (
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
  // The oauth_auth_method column has no default, and Uptime Kuma's own fallback to
  // client_secret_basic only covers undefined, not the stored null: openid-client then
  // refuses every token request. The web form always sends one; do the same.
  if (method === 'oauth2-cc' && isBlank(monitor.oauth_auth_method)) {
    applied.oauth_auth_method = 'client_secret_basic';
    monitor.oauth_auth_method = 'client_secret_basic';
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
export const rehydrateMonitorUrl = (fields: Record<string, unknown>, stored: unknown): boolean => {
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

export const inferredAuthNote = (method: unknown): string =>
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
export const rehydrateRabbitmqNodes = (fields: Record<string, unknown>, stored: unknown): void => {
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

/**
 * The ping URL of a push monitor, built the way Uptime Kuma's own UI builds it: from the
 * Primary Base URL setting when one is set, else from the address this server connects with.
 * `note` says which, so the caller can tell the user whether the host may need changing.
 */
export const pushURLFor = async (
  client: UptimeKumaClient,
  kumaUrl: string,
  token: unknown
): Promise<{ url: string; note: string }> => {
  let primary = '';
  try {
    const value = (await client.getSettings()).data?.primaryBaseURL;
    if (typeof value === 'string') primary = value.trim();
  } catch {
    // Settings are a nicety here; the connection URL still works where this server runs.
  }
  const base = primary || kumaUrl;
  // A loop, not /\/+$/: that pattern backtracks quadratically on a long run of slashes.
  let end = base.length;
  while (end > 0 && base[end - 1] === '/') end--;
  return {
    url: `${base.slice(0, end)}/api/push/${token}?status=up&msg=OK&ping=`,
    note: primary
      ? "The host is Uptime Kuma's Primary Base URL setting."
      : 'No Primary Base URL is set in Uptime Kuma, so the host is the address this MCP server connects with. If the sender reaches Uptime Kuma at another address, use that host instead, or set the Primary Base URL under Settings → General in Uptime Kuma (this MCP server cannot change settings).',
  };
};

/**
 * What a monitor must satisfy to be of its type, for a create and for a type change alike.
 * Uptime Kuma applies the defaults in its web form (src/pages/EditMonitor.vue, the
 * "monitor.type" watcher) and never on the server, so an API caller gets none of them.
 *
 * Sets the defaults on `monitor` and returns them, so the caller can verify they were stored.
 */
export const applyMonitorTypeRules = (
  monitor: Record<string, unknown>,
  timeoutIsCallers: boolean
): Record<string, unknown> => {
  const type = String(monitor.type);
  if (!MONITOR_TYPE_NAMES.has(type)) {
    throw new Error(unknownMonitorTypeMessage(type, MONITOR_TYPE_NAMES));
  }

  const applied: Record<string, unknown> = {};
  const required = [...(REQUIRED_MONITOR_FIELDS[type] ?? [])];
  if (type === 'globalping') {
    // The form's default; the check switches on it and does nothing at all for a blank one.
    if (isBlank(monitor.subtype)) applied.subtype = 'ping';
    if (isBlank(monitor.location)) applied.location = 'world';
    // Also the form's default. The column has none, and the check passes it to the
    // Globalping API as the query type as it is, null included.
    if ((applied.subtype ?? monitor.subtype) === 'dns' && isBlank(monitor.dns_resolve_type))
      applied.dns_resolve_type = 'A';
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
  assertDnsRecordType(type, monitor.dns_resolve_type);

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
  if (!timeoutIsCallers) {
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

export const asText = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
export const asNumber = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

// Lists and objects Uptime Kuma stores as JSON text and parses again on read.
export const asJson = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

export const TYPE_FIELD_HINT = "See #112 — the monitor's check depends on this field.";

// Uptime Kuma answers a boolean column as true/false from toJSON() and 0/1 from a raw row.
export const asFlag = (v: unknown): number => (v ? 1 : 0);

export interface VerifiedField {
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
export const VERIFIED_MONITOR_FIELDS: Record<string, VerifiedField> = {
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
      wanted === stored || (typeof wanted === 'number' && typeof stored === 'number' && Math.round(wanted) === stored),
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
  radiusPassword: {
    read: asText,
    secret: true,
    hint: 'See #106 — the mysql monitor reads its password from this field.',
  },
  ...Object.fromEntries(
    [
      'basic_auth_user',
      'oauth_token_url',
      'mqttTopic',
      'mqttUsername',
      'grpcUrl',
      'grpcServiceName',
      'grpcMethod',
      'kafkaProducerTopic',
      'radiusUsername',
      'rabbitmqUsername',
      'snmpOid',
      'snmpVersion',
      'game',
      'subtype',
      'location',
      'sshUsername',
      'sshAuthMethod',
    ].map((f) => [f, { read: asText, hint: TYPE_FIELD_HINT }])
  ),
  ...Object.fromEntries(
    [
      'basic_auth_pass',
      'bearer_token',
      'oauth_client_id',
      'oauth_client_secret',
      'tlsCert',
      'tlsKey',
      'tlsCa',
      'mqttPassword',
      'radiusSecret',
      'rabbitmqPassword',
      'gamedigToken',
      'sshPassword',
      'sshPrivateKey',
      'sshPassphrase',
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
export const verifyMonitorWrite = async (
  client: UptimeKumaClient,
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
