import { describe, it, expect } from 'vitest';
import {
  SECRET_MARKER,
  isSecretKey,
  redactSecrets,
  redactUrlCredentials,
  redactNotification,
  redactNotifications,
  rehydrateSecrets,
  rehydrateUrlCredentials,
} from '../../src/redact.js';

describe('redact - key classification', () => {
  it('catches the fields named in issue #59', () => {
    for (const key of [
      'pushToken',
      'push_token',
      'basic_auth_pass',
      'bearer_token',
      'oauth_client_secret',
      'radiusPassword',
      'radiusSecret',
      'mqttPassword',
      'rabbitmqPassword',
      'smtpPassword',
      'ntfypassword',
      'databaseConnectionString',
      'headers',
      'tlsCert',
      'tlsKey',
      'tlsCa',
    ]) {
      expect(isSecretKey(key), `${key} should be treated as secret`).toBe(true);
    }
  });

  it('treats snake_case and camelCase spellings as the same field', () => {
    expect(isSecretKey('push_token')).toBe(isSecretKey('pushToken'));
    expect(isSecretKey('database_connection_string')).toBe(isSecretKey('databaseConnectionString'));
    expect(isSecretKey('tls_key')).toBe(isSecretKey('tlsKey'));
  });

  it('catches unknown future fields via the pattern, not just the explicit list', () => {
    for (const key of ['someNewApiKey', 'providerSecretValue', 'x_credential', 'privateKey', 'jwtSigningKey']) {
      expect(isSecretKey(key), `${key} should be caught by the safety net`).toBe(true);
    }
  });

  it('does not hide configuration that merely sounds sensitive', () => {
    // The reason the `auth` alternative in the pattern is narrowed: these are useful,
    // and a redaction that hides them is one people switch off.
    for (const key of [
      'oauth_token_url',
      'authMethod',
      'oauth_auth_method',
      'oauth_scopes',
      'oauth_audience',
      'basic_auth_user',
      'mqttUsername',
      'radiusUsername',
      'hostname',
      'port',
      'url',
      'interval',
      'includeSensitiveData',
      'accepted_statuscodes',
    ]) {
      expect(isSecretKey(key), `${key} should stay visible`).toBe(false);
    }
  });
});

describe('redact - monitors', () => {
  const monitor = {
    id: 95,
    name: 'Melchior Backup Heartbeat',
    type: 'push',
    hostname: 'melchior.local',
    port: 8080,
    pushToken: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    basic_auth_user: 'reader',
    basic_auth_pass: 'hunter2',
    headers: '{"X-Api-Key":"live-arr-key"}',
    oauth_token_url: 'https://idp.example.com/token',
    authMethod: 'oauth2-cc',
  };

  it('masks credentials and keeps everything else', () => {
    const out = redactSecrets(monitor);
    expect(out.pushToken).toBe(SECRET_MARKER);
    expect(out.basic_auth_pass).toBe(SECRET_MARKER);
    expect(out.headers).toBe(SECRET_MARKER);

    expect(out.id).toBe(95);
    expect(out.name).toBe('Melchior Backup Heartbeat');
    expect(out.hostname).toBe('melchior.local');
    expect(out.port).toBe(8080);
    expect(out.basic_auth_user).toBe('reader');
    expect(out.oauth_token_url).toBe('https://idp.example.com/token');
    expect(out.authMethod).toBe('oauth2-cc');
  });

  it('does not mutate its input', () => {
    // This is the property that keeps updateMonitor safe: it merges over the cached row,
    // and the cached row is what redactSecrets was handed.
    const before = JSON.stringify(monitor);
    redactSecrets(monitor);
    expect(JSON.stringify(monitor)).toBe(before);
  });

  it('leaves unset fields unset instead of claiming a credential exists', () => {
    const out = redactSecrets({ pushToken: '', basic_auth_pass: null, bearer_token: undefined });
    expect(out.pushToken).toBe('');
    expect(out.basic_auth_pass).toBeNull();
    expect(out.bearer_token).toBeUndefined();
  });

  it('descends into nested objects rather than masking them wholesale', () => {
    // kafkaProducerSaslOptions is an object; masking it whole would hide the mechanism
    // and break its own schema.
    const out = redactSecrets({
      kafkaProducerSaslOptions: { mechanism: 'scram-sha-256', username: 'kafka', password: 'swordfish' },
    });
    expect(out.kafkaProducerSaslOptions).toEqual({
      mechanism: 'scram-sha-256',
      username: 'kafka',
      password: SECRET_MARKER,
    });
  });

  it('strips inline credentials from URLs, which no field name reveals', () => {
    expect(redactUrlCredentials('https://admin:s3cret@example.com/health')).toBe(
      `https://${SECRET_MARKER}:${SECRET_MARKER}@example.com/health`
    );
    expect(redactUrlCredentials('https://example.com/health')).toBe('https://example.com/health');
    expect(redactUrlCredentials('not a url')).toBe('not a url');
  });

  it('keeps rabbitmqNodes valid URLs after scrubbing', () => {
    const out = redactSecrets({ rabbitmqNodes: ['http://guest:guest@rabbit:15672'] });
    const [node] = out.rabbitmqNodes as string[];
    expect(() => new URL(node)).not.toThrow();
    expect(node).not.toContain('guest:guest');
  });
});

describe('redact - notifications (allowlist)', () => {
  const smtp = {
    id: 2,
    name: 'My Email Alert',
    active: true,
    isDefault: true,
    config: JSON.stringify({
      type: 'smtp',
      smtpHost: 'email-smtp.ap-southeast-2.amazonaws.com',
      smtpPort: 587,
      smtpUsername: 'AKIAEXAMPLE',
      smtpPassword: 'super-secret',
      smtpFrom: 'alerts@example.com',
    }),
  };

  it('withholds every config field outside the allowlist', () => {
    const out = redactNotification(smtp);
    const config = JSON.parse(out.config as string);

    expect(config.type).toBe('smtp');
    expect(config.smtpPassword).toBeUndefined();
    expect(config.smtpUsername).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('super-secret');
    expect(JSON.stringify(out)).not.toContain('AKIAEXAMPLE');
  });

  it('names what it withheld, so a caller can see the field is set', () => {
    const out = redactNotification(smtp);
    expect(out.redactedConfigKeys).toEqual(
      expect.arrayContaining(['smtpHost', 'smtpPort', 'smtpUsername', 'smtpPassword', 'smtpFrom'])
    );
  });

  it('keeps the row columns needed to attach a channel to a monitor', () => {
    // notificationIDList only ever needs the id — the credentials are incidental
    // to every workflow in the issue.
    const out = redactNotification(smtp);
    expect(out.id).toBe(2);
    expect(out.name).toBe('My Email Alert');
    expect(out.active).toBe(true);
    expect(out.isDefault).toBe(true);
  });

  it('withholds an unparseable config in full rather than guessing', () => {
    const out = redactNotification({ id: 9, name: 'Broken', config: 'not json' });
    expect(out.config).toBe(SECRET_MARKER);
  });

  it('preserves the config field shape (string in, string out)', () => {
    expect(typeof redactNotification(smtp).config).toBe('string');
    expect(typeof redactNotification({ id: 1, config: { type: 'slack', webhookURL: 'x' } }).config).toBe('object');
  });

  it('does not mutate the cached rows it is handed', () => {
    // getNotificationList() returns references straight out of notificationListCache.
    const before = JSON.stringify(smtp);
    redactNotifications([smtp]);
    expect(JSON.stringify(smtp)).toBe(before);
  });
});

describe('rehydrateSecrets - the read-edit-write loop', () => {
  it('restores a stored value when the marker is sent back', () => {
    const incoming = { name: 'Renamed', smtpPassword: SECRET_MARKER };
    const stored = { name: 'Original', smtpPassword: 'super-secret' };

    const { preserved, missing } = rehydrateSecrets(incoming, stored);

    expect(incoming.smtpPassword).toBe('super-secret');
    expect(incoming.name).toBe('Renamed');
    expect(preserved).toEqual(['smtpPassword']);
    expect(missing).toEqual([]);
  });

  it('reports a marker with nothing behind it instead of writing it', () => {
    const incoming = { pushToken: SECRET_MARKER };
    const { preserved, missing } = rehydrateSecrets(incoming, { pushToken: '' });

    expect(missing).toEqual(['pushToken']);
    expect(preserved).toEqual([]);
    // Left as-is for the caller to reject on; writing it would create a credential
    // that looks set and cannot work.
    expect(incoming.pushToken).toBe(SECRET_MARKER);
  });

  it('leaves real values alone', () => {
    const incoming = { smtpPassword: 'a-new-password' };
    const { preserved } = rehydrateSecrets(incoming, { smtpPassword: 'old' });
    expect(incoming.smtpPassword).toBe('a-new-password');
    expect(preserved).toEqual([]);
  });

  it('descends into nested objects and reports a dotted path', () => {
    const incoming = { kafkaProducerSaslOptions: { mechanism: 'plain', password: SECRET_MARKER } };
    const stored = { kafkaProducerSaslOptions: { mechanism: 'plain', password: 'swordfish' } };

    const { preserved } = rehydrateSecrets(incoming, stored);

    expect(incoming.kafkaProducerSaslOptions.password).toBe('swordfish');
    expect(preserved).toEqual(['kafkaProducerSaslOptions.password']);
  });

  it('reports every marker as missing when there is no stored object (the create path)', () => {
    // createMonitor / addNotification have nothing to restore from, so a marker there must
    // be refused rather than saved as the credential.
    const incoming = { name: 'Cloned', smtpPassword: SECRET_MARKER, smtpHost: 'smtp.example.com' };
    const { preserved, missing } = rehydrateSecrets(incoming, undefined);

    expect(missing).toEqual(['smtpPassword']);
    expect(preserved).toEqual([]);
    expect(incoming.smtpHost).toBe('smtp.example.com');
  });

  it('round-trips a redacted read without destroying the secret', () => {
    // The whole point of the pairing: what redaction hands out must survive being
    // handed straight back.
    const stored = { type: 'smtp', smtpHost: 'smtp.example.com', smtpPassword: 'super-secret' };
    const shown = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    for (const k of Object.keys(shown)) {
      if (isSecretKey(k)) shown[k] = SECRET_MARKER;
    }

    shown.smtpHost = 'smtp2.example.com';
    rehydrateSecrets(shown, stored);

    expect(shown.smtpPassword).toBe('super-secret');
    expect(shown.smtpHost).toBe('smtp2.example.com');
  });
});

describe('rehydrateUrlCredentials - the dockerDaemon read-edit-write loop', () => {
  // redactUrlCredentials scrubs user:pass to "***:***@host", which is NOT the bare "***"
  // marker rehydrateSecrets matches. updateDockerHost writes the whole URL back, so this is
  // the counterpart that keeps that path from clobbering the credential.
  const stored = 'http://admin:s3cret@dockerd.local:2375';

  it('restores both userinfo halves a redacted read scrubbed', () => {
    const shown = redactUrlCredentials(stored); // http://***:***@dockerd.local:2375/
    const { value, preserved, missing } = rehydrateUrlCredentials(shown, stored);

    // URL serialization normalises an empty path to "/", the same normalisation
    // redactUrlCredentials already applied on the way out — the credential is what matters.
    expect(value).toBe('http://admin:s3cret@dockerd.local:2375/');
    expect(preserved).toBe(true);
    expect(missing).toBe(false);
  });

  it('restores credentials even when the caller changed the endpoint', () => {
    // The realistic edit: read the redacted host, repoint it, write it back. The
    // credentials must ride along to the new endpoint rather than being wiped.
    const { value, preserved } = rehydrateUrlCredentials('http://***:***@new-host:2375', stored);
    expect(value).toBe('http://admin:s3cret@new-host:2375/');
    expect(preserved).toBe(true);
  });

  it('reports missing when there is no stored credential to restore', () => {
    // A create, or a host that never had inline credentials. Writing "***" would save an
    // endpoint that looks authenticated and cannot connect.
    const withoutCreds = rehydrateUrlCredentials('http://***:***@new-host:2375', 'http://dockerd.local:2375');
    expect(withoutCreds.missing).toBe(true);
    expect(withoutCreds.preserved).toBe(false);

    const noStored = rehydrateUrlCredentials('http://***:***@new-host:2375', undefined);
    expect(noStored.missing).toBe(true);
  });

  it('leaves a URL without the marker untouched', () => {
    const realEdit = 'http://newuser:newpass@dockerd.local:2375';
    const { value, preserved, missing } = rehydrateUrlCredentials(realEdit, stored);
    expect(value).toBe(realEdit);
    expect(preserved).toBe(false);
    expect(missing).toBe(false);
  });

  it('leaves non-URL values (a unix socket path) untouched', () => {
    const socket = '/var/run/docker.sock';
    expect(rehydrateUrlCredentials(socket, undefined)).toEqual({
      value: socket,
      preserved: false,
      missing: false,
    });
  });

  it('restores a password-only userinfo', () => {
    const { value, preserved } = rehydrateUrlCredentials('http://:***@dockerd.local:2375', 'http://:s3cret@dockerd.local:2375');
    expect(value).toBe('http://:s3cret@dockerd.local:2375/');
    expect(preserved).toBe(true);
  });
});
