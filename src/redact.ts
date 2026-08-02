import { HeartbeatSchema } from './types/heartbeat.js';

/**
 * Redaction of secrets on the way OUT of the read tools (issue #59).
 *
 * Uptime Kuma's socket API returns notification and monitor configuration verbatim,
 * secrets included — its own web UI masks them at render time. That is fine for a
 * browser and not fine here: an MCP server's output lands in an LLM's context window
 * and is then persisted in client-side conversation transcripts, logs and synced
 * history. A routine "what am I monitoring?" therefore writes live SMTP credentials,
 * push tokens and third-party API keys into storage the user may not control.
 *
 * Two rules make this safe, and both matter more than the field lists below:
 *
 * 1. REDACTION HAPPENS AT THE TOOL OUTPUT BOUNDARY, NEVER IN THE CLIENT OR CACHE.
 *    `updateMonitor` reads the existing monitor and merges the caller's changes over
 *    it; `getNotificationList()` hands back references straight out of
 *    `notificationListCache`. Redacting in either place would mean the next write
 *    persists "***" over a working credential. Every function here returns a COPY and
 *    the write paths keep reading unredacted.
 *
 * 2. A VALUE THAT COMES BACK IN IS RESTORED, NOT WRITTEN. See `rehydrateSecrets` —
 *    the read-edit-write loop an agent naturally performs must not destroy the secret
 *    it was never shown.
 */

/**
 * What a withheld value is replaced with. Callers can still see that the field is
 * SET without learning its value, and `rehydrateSecrets` recognises it on the way back.
 */
export const SECRET_MARKER = '***';

/**
 * Keys are compared case-insensitively with separators removed, so `push_token`
 * (the database column) and `pushToken` (what Uptime Kuma's socket payload calls it)
 * are one entry rather than two. Every set below is written in this normalised form.
 */
const normaliseKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');

/**
 * Safety net for fields Uptime Kuma has not added yet.
 *
 * Deliberately narrower than the obvious `/auth/` on the `auth` alternative: a bare
 * `auth` also matches `authMethod`, `oauth_auth_method` and `oauth_scopes`, which are
 * genuinely useful configuration and not credentials. Hiding them would make the
 * redaction itself the reason someone turns it off.
 */
export const SECRET_KEY_PATTERN =
  /pass(word|wd|phrase)?|secret|token|apikey|api_key|auth(oriz|entic)|bearer|credential|private.?key|jwt/i;

/**
 * Sensitive fields the pattern above does NOT catch, mostly because their names say
 * what they hold rather than that it is secret.
 */
const EXPLICIT_SECRET_KEYS = new Set(
  [
    // Free-form, and in practice where third-party API keys live. Masked wholesale:
    // the contents are caller-defined, so there is no key list to be selective with.
    'headers',
    'grpcmetadata',
    // Connection strings normally carry user:password inline.
    'databaseconnectionstring',
    // Client certificates and their keys.
    'tlsca',
    'tlscert',
    'tlskey',
    // Not a credential on its own, but it is half of one and was named in #59.
    'oauthclientid',
  ].map(normaliseKey)
);

/**
 * Fields that LOOK sensitive to the pattern but are not, and are useful to see.
 * Checked before everything else.
 *
 * `oauth_token_url` is the motivating case: it matches `token` and is an endpoint.
 */
const NEVER_SECRET_KEYS = new Set(
  ['oauthtokenurl', 'tokenurl', 'authmethod', 'oauthauthmethod', 'oauthscopes', 'oauthaudience'].map(
    normaliseKey
  )
);

/** Whether a field name should have its value withheld. */
export function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  if (NEVER_SECRET_KEYS.has(k)) return false;
  if (EXPLICIT_SECRET_KEYS.has(k)) return true;
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Scrubs `scheme://user:pass@` credentials out of a string, whether the whole value is a
 * URL or a URL quoted inside a larger message.
 *
 * A monitor `url`, a `dockerDaemon` TCP endpoint and every entry of `rabbitmqNodes` carry
 * inline credentials that no field NAME reveals, and a heartbeat `msg` can echo the
 * monitor's own URL mid-sentence ("connect ETIMEDOUT to http://admin:s3cret@host"). One
 * regex covers both: it masks the userinfo of every occurrence and leaves the scheme, host
 * and surrounding text byte-for-byte intact, so the endpoint stays readable and a
 * `rabbitmqNodes` entry stays a valid URL. Working on the raw string rather than parsing it
 * also means a value that is not a clean URL still has its credentials scrubbed.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+)@/gi;
export function redactUrlCredentials(value: string): string {
  return value.replace(URL_USERINFO, (_match, scheme: string, userinfo: string) => {
    const masked = userinfo.includes(':') ? `${SECRET_MARKER}:${SECRET_MARKER}` : SECRET_MARKER;
    return `${scheme}${masked}@`;
  });
}

/**
 * Recursive copy with secret-named fields replaced by the marker.
 *
 * Recursion is not decoration: `kafkaProducerSaslOptions` is an OBJECT holding
 * `{mechanism, username, password}`. Masking it wholesale would hide the mechanism
 * and violate its own schema, so the password inside it is masked and the rest kept.
 */
export function redactSecrets<T>(value: T, keyHint?: string): T {
  if (typeof value === 'string') {
    return redactUrlCredentials(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, keyHint)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined || v === '') {
      // An unset secret is not a secret, and reporting "***" for an empty field
      // would claim a credential exists where none does.
      out[k] = v;
    } else if (isSecretKey(k)) {
      out[k] = SECRET_MARKER;
    } else {
      out[k] = redactSecrets(v, k);
    }
  }
  return out as unknown as T;
}

/**
 * The heartbeat's declared fields, and the allowlist its output is projected onto.
 * Derived from the schema so the two cannot drift apart.
 */
const HEARTBEAT_FIELDS: ReadonlySet<string> = new Set(Object.keys(HeartbeatSchema.shape));

/**
 * Redacts one heartbeat on the way out of the read tools (issue #59, finding #3).
 *
 * A heartbeat is a STATUS record, but `HeartbeatSchema` used to `.passthrough()`, so any
 * undeclared column Uptime Kuma sends — `response` most of all, which carries the monitored
 * service's own response body — reached the tool surface untouched. `redactSecrets` cannot
 * help there: `response` is not a secret-NAMED field and its body is arbitrary content, not a
 * `user:pass@` URL. So this first PROJECTS the heartbeat onto its declared fields, dropping
 * `response` and anything else passthrough used to admit, then runs `redactSecrets` over what
 * survives to scrub a credential the `msg` may quote as a URL.
 *
 * The projection has to happen on the DATA, not just the schema: the tools stringify the object
 * into their text block, which no output schema touches.
 */
export function redactHeartbeat<T>(heartbeat: T): T {
  const source = heartbeat as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (HEARTBEAT_FIELDS.has(key)) projected[key] = source[key];
  }
  return redactSecrets(projected) as T;
}

/**
 * Notification `config` blobs use an ALLOWLIST rather than the denylist above.
 *
 * The set of notification providers is large and each one names its credential
 * differently, so a denylist is a promise to keep up with upstream forever. The
 * fields below are the ones every provider shares and none of them is a secret;
 * everything else is withheld and NAMED in `redactedConfigKeys`, which is enough
 * to see that a field is set and to ask for it explicitly.
 *
 * Widening this is a one-line change per field, and safe as long as the field is
 * common to all providers.
 */
const NOTIFICATION_CONFIG_ALLOW = new Set(
  ['type', 'name', 'isdefault', 'applyexisting', 'active', 'id'].map(normaliseKey)
);

export interface RedactedNotification extends Record<string, unknown> {
  redactedConfigKeys?: string[];
}

/**
 * Applies the allowlist to one notification row.
 *
 * The row's own columns (`id`, `name`, `type`, `active`, `isDefault`) are not secret
 * and are kept as-is. `config` is a JSON STRING holding the provider-specific fields,
 * and is where every credential lives. It is returned as a JSON string of the
 * allowlisted subset so the field keeps its shape, alongside `redactedConfigKeys`
 * naming what was withheld.
 */
export function redactNotification(notification: Record<string, unknown>): RedactedNotification {
  const out: RedactedNotification = {};
  for (const [k, v] of Object.entries(notification)) {
    if (k !== 'config') out[k] = v;
  }

  const raw = notification['config'];
  let parsed: Record<string, unknown> | undefined;
  if (typeof raw === 'string') {
    try {
      const candidate: unknown = JSON.parse(raw);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Unparseable config could be anything, so it is withheld in full rather
      // than guessed at.
      out['config'] = SECRET_MARKER;
      out.redactedConfigKeys = [];
      return out;
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>;
  }

  if (!parsed) {
    if (raw !== undefined) out['config'] = raw;
    return out;
  }

  const kept: Record<string, unknown> = {};
  const withheld: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (NOTIFICATION_CONFIG_ALLOW.has(normaliseKey(k))) {
      kept[k] = v;
    } else {
      withheld.push(k);
    }
  }

  out['config'] = typeof raw === 'string' ? JSON.stringify(kept) : kept;
  out.redactedConfigKeys = withheld;
  return out;
}

export function redactNotifications(notifications: Record<string, unknown>[]): RedactedNotification[] {
  return notifications.map(redactNotification);
}

/**
 * Restores values the caller was never shown, instead of writing the marker over them.
 *
 * This is the half of #59 that decides whether redaction is safe to ship at all. The
 * natural agent loop is read → edit one field → write the whole object back, and after
 * a read the object it holds says `smtpPassword: "***"`. Without this, renaming a
 * notification channel would replace its password with three asterisks.
 *
 * Mutates `incoming` in place — every caller passes an object it just built.
 *
 * Passing `stored` as undefined turns this into a pure check: every marker is reported as
 * `missing`, which is what the CREATE paths want. There is nothing to restore on a create,
 * so a marker there would persist three asterisks as a real credential.
 *
 * Known trade-off: a credential whose real value is literally `***` cannot be set through
 * an update, because it is indistinguishable from the marker. Passing it on create still
 * fails for the same reason. Both are preferable to the alternative — silently writing the
 * marker over a working secret is the failure this exists to prevent.
 */
export function rehydrateSecrets(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | undefined
): { preserved: string[]; missing: string[] } {
  const preserved: string[] = [];
  const missing: string[] = [];

  for (const [k, v] of Object.entries(incoming)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = stored?.[k];
      const result = rehydrateSecrets(
        v as Record<string, unknown>,
        nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : undefined
      );
      preserved.push(...result.preserved.map((p) => `${k}.${p}`));
      missing.push(...result.missing.map((p) => `${k}.${p}`));
      continue;
    }
    if (v !== SECRET_MARKER) continue;

    const previous = stored?.[k];
    if (previous === undefined || previous === null || previous === '') {
      // Nothing to put back. Writing the marker would be worse than refusing:
      // it creates a credential that looks set and cannot work.
      missing.push(k);
    } else {
      incoming[k] = previous;
      preserved.push(k);
    }
  }

  return { preserved, missing };
}

/**
 * Restores inline URL credentials that a redacted read scrubbed to the marker.
 *
 * `redactUrlCredentials` turns `http://user:pass@host` into `http://***:***@host`, and that
 * scrubbed form is NOT the bare `***` that `rehydrateSecrets` recognises — the marker lives
 * inside the URL's userinfo, not as the whole field value. A `dockerDaemon` TCP endpoint is the
 * field that carries this, and `updateDockerHost` writes the whole value back, so without this a
 * read-edit-write loop persists `***:***@host` and wipes the credential — the exact clobber
 * `rehydrateSecrets` prevents for monitors and notifications.
 *
 * Returns the restored URL and whether a marker was restored (`preserved`) or had nothing behind
 * it (`missing` — a create, or a stored URL that never had that credential). A URL with no marker
 * in its userinfo, or a non-URL string, is returned unchanged.
 */
export function rehydrateUrlCredentials(
  incoming: string,
  stored: string | undefined
): { value: string; preserved: boolean; missing: boolean } {
  if (typeof incoming !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(incoming)) {
    return { value: incoming, preserved: false, missing: false };
  }

  let url: URL;
  try {
    url = new URL(incoming);
  } catch {
    return { value: incoming, preserved: false, missing: false };
  }

  if (url.username !== SECRET_MARKER && url.password !== SECRET_MARKER) {
    return { value: incoming, preserved: false, missing: false };
  }

  let storedUrl: URL | undefined;
  if (typeof stored === 'string') {
    try {
      storedUrl = new URL(stored);
    } catch {
      storedUrl = undefined;
    }
  }

  let preserved = false;
  let missing = false;

  if (url.username === SECRET_MARKER) {
    const previous = storedUrl?.username;
    if (previous) {
      url.username = previous;
      preserved = true;
    } else {
      missing = true;
    }
  }
  if (url.password === SECRET_MARKER) {
    const previous = storedUrl?.password;
    if (previous) {
      url.password = previous;
      preserved = true;
    } else {
      missing = true;
    }
  }

  return { value: url.toString(), preserved, missing };
}

/**
 * Shared wording for the opt-in, so every tool describes it the same way.
 */
export const INCLUDE_SECRETS_DESCRIPTION =
  'Return credentials in full instead of "***". Off by default: this output is persisted in ' +
  'conversation transcripts and logs. Can also be enabled globally with UPTIME_KUMA_INCLUDE_SECRETS=true.';
