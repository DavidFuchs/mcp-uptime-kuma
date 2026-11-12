# Credential Redaction

Read tools return `***` in place of secrets rather than the values themselves.

Uptime Kuma's socket API returns configuration verbatim - its web UI masks credentials at
render time. That is fine for a browser and not fine for an MCP server, whose output lands
in an LLM's context window and is then persisted in conversation transcripts, logs and
synced history. Asking "what am I monitoring?" should not write a live SMTP password or a
third-party API key into storage you may not control.

What is withheld:

| Tool | Withheld |
|---|---|
| `listNotifications` | everything in `config` except `type`/`name`/`isDefault`/`applyExisting`. The withheld field names are listed in `redactedConfigKeys` |
| `listMonitors`, `getMonitor` | `pushToken`, `basic_auth_pass`, `bearer_token`, `oauth_client_secret`, `radiusPassword`, `radiusSecret`, `mqttPassword`, `rabbitmqPassword`, `gamedigToken`, `sshPassword`, `sshPrivateKey`, `sshPassphrase`, the password inside `kafkaProducerSaslOptions`, `user:pass@` inside `rabbitmqNodes`, `tlsCert`/`tlsKey`/`tlsCa`, `databaseConnectionString`, `headers`, `grpcMetadata`, plus anything matching `/pass|secret|token|apikey|auth(oriz\|entic)|bearer|credential|private.?key|jwt/i` |
| `listDockerHosts` | `user:password@` inside a `dockerDaemon` URL |
| `getHeartbeats`, `listHeartbeats` | any column Uptime Kuma returns beyond the declared heartbeat fields (e.g. `response`, which can carry a service's response body) is dropped, and `user:password@` inside a URL quoted in the status message is scrubbed |
| `getSettings` | any secret-named field Uptime Kuma returns (e.g. `steamAPIKey`) |
| `getMonitorSummary` | nothing - it returns no credentials to begin with |

`hostname`, `port`, `url`, `authMethod`, `oauth_token_url`, `oauth_scopes` and usernames stay
visible: hiding useful configuration is how a redaction feature gets switched off.

To get the real values, either pass `includeSecrets: true` on the call:

```
listNotifications({ includeSecrets: true })
```

or enable it globally:

```
UPTIME_KUMA_INCLUDE_SECRETS=true
```

The per-call parameter wins over the environment variable in both directions, so a
permissive deployment can still ask one call to redact.

**Writing `***` back is safe.** `updateMonitor` and `updateNotification` restore the stored
value when a field arrives as the marker, and report which fields they preserved. This
matters most for `updateNotification`: Uptime Kuma replaces the notification row rather than
merging it, so without this a read-edit-write round trip would replace a working password
with three asterisks. If there is no stored value to restore, the call fails rather than
writing a credential that looks set and cannot work.

**Push tokens are returned by the call that sets them up.** `createMonitor` returns the
token and ping URL of a new push monitor, and `updateMonitor` does the same when it changes
a monitor's type to push, because the sender cannot be wired up without them. Later reads
redact the token like any other secret.

Credentials written inline in a URL get the same protection: the `url` of a monitor, the
entries of `rabbitmqNodes`, and the `dockerDaemon` of a docker host. A `http://***:***@host:2375`
read back from a read tool has its userinfo restored from the stored URL rather than persisted
verbatim, so editing the path or scheme without re-entering the credentials does not wipe them.

**Stored credentials are only restored onto the host and port they were stored for.** Sending
`http://***:***@another-host` is refused rather than restored, because that would hand a
password you were never shown to an address of the caller's choosing. To point a monitor or
docker host at a new address, pass the real credentials along with it.

The MCP logging channel gets the same rule. The debug log for a live heartbeat reports the
monitored service's status message by length only (`msgLength=...`), never its content, since
that message can echo a target URL with an embedded `user:password@` or a slice of a response
body, and on the stdio transport those log notifications reach the client.
