# mcp-uptime-kuma

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Uptime Kuma](https://github.com/louislam/uptime-kuma) *version 2*. Supports stdio and streamable HTTP transports.

[![npm version](https://img.shields.io/npm/v/%40davidfuchs%2Fmcp-uptime-kuma?style=flat&label=npm)](https://www.npmjs.com/package/@davidfuchs/mcp-uptime-kuma)
[![npm downloads](https://img.shields.io/npm/d18m/%40davidfuchs%2Fmcp-uptime-kuma?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/@davidfuchs/mcp-uptime-kuma)
[![Docker pulls](https://img.shields.io/docker/pulls/davidfuchs/mcp-uptime-kuma?style=flat)](https://hub.docker.com/r/davidfuchs/mcp-uptime-kuma)
[![Release build](https://img.shields.io/github/actions/workflow/status/DavidFuchs/mcp-uptime-kuma/publish-npm.yml?style=flat&label=release%20build)](https://github.com/DavidFuchs/mcp-uptime-kuma/actions/workflows/publish-npm.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat)](https://github.com/DavidFuchs/mcp-uptime-kuma/blob/main/LICENSE)

**Contents:** [What You Can Ask](#what-you-can-ask) ·
[Features](#features) ·
[Setup](#setup) ·
[Available Tools](#available-tools) ·
[Configuration](#configuration-reference) ·
[Authentication](#authentication-methods) ·
[Read-Only Mode](#read-only-mode) ·
[Securing HTTP](#securing-the-http-endpoint) ·
[Credential Redaction](#credential-redaction) ·
[Troubleshooting](#troubleshooting)

## What You Can Ask

Once it's connected, you manage Uptime Kuma by asking your AI assistant in plain language:

- *"What's down right now, and since when?"*
- *"Which monitors have been flapping this week?"*
- *"Add an HTTP monitor for https://example.com/health that checks every 60 seconds and alerts the Discord channel."*
- *"Put the NAS monitors in maintenance tonight from 10 to 11pm."*
- *"Build a public status page with a group for each of my web services."*
- *"Pause everything tagged `staging`."*

## Features

- **Manage everything, not just read it.** 36 tools cover monitors of any type, notification
  channels, tags, maintenance windows, status pages and Docker hosts. See [Available Tools](#available-tools).
- **Live data.** The server keeps a Socket.IO connection open to Uptime Kuma, so status and
  heartbeats are current without polling.
- **Context-friendly.** Summaries come first and full detail only when asked for. The roughly
  85 type-specific monitor fields are looked up on demand instead of filling every conversation.
- **Credentials stay out of transcripts.** Read tools return `***` for passwords, tokens and
  API keys, and writing `***` back keeps the stored value. See [Credential Redaction](#credential-redaction).
- **Read-only mode.** One setting removes every tool that creates, changes or deletes. See
  [Read-Only Mode](#read-only-mode).
- **Annotated tools.** Every tool says whether it only reads, and whether it deletes or
  replaces, so your client can run reads unattended and ask before the rest.
- **Run it locally or share it.** Use stdio through `npx`, or streamable HTTP in Docker with
  bearer-token auth, `Origin` checks and rate limiting.

## Example Conversation

![MCP server answering questions about Uptime Kuma monitors](.github/images/screenshot-1.png)
*Conversation in [LibreChat](https://github.com/danny-avila/LibreChat) where the `mcp-uptime-kuma` server is providing real-time information from Uptime Kuma.*

## Setup

Setup takes two steps: pick how the server runs, then point your AI client at it.

### 1. Choose how to run it

| | **Local (stdio)** | **Shared server (Docker, streamable HTTP)** |
|---|---|---|
| How it runs | Your AI client starts it on your machine with `npx` and talks to it over stdin/stdout | One long-running container, usually next to Uptime Kuma, that clients reach at `http://<host>:3000/mcp` |
| Needs | Node.js 22+ on each machine that uses it | Docker on one host |
| Uptime Kuma credentials live | In each client's config | Only in the container |
| Best for | One person, one or two machines. The quickest way to try it. | Several machines or people, a homelab, or web clients such as claude.ai |

If you're not sure, start with **local**. Every client below supports it, and you can switch later.

Either way you need:

- **Uptime Kuma 2.0 or later.** The server talks to Uptime Kuma 2's socket API; 1.x is not supported.
- **Your Uptime Kuma URL and a way to log in to it.** A username and password work. Use a JWT
  token if you have 2FA, or nothing at all if authentication is disabled. See
  [Authentication Methods](#authentication-methods).

Trying it out for the first time? Add `UPTIME_KUMA_READ_ONLY=true` to the environment in any of
the examples below. The assistant can then look at everything but change nothing. Remove it
once you're comfortable. See [Read-Only Mode](#read-only-mode).

### 2. Start the shared server (Docker only)

Skip this step if you chose local.

Generate a secret that clients will present as a bearer token:

```bash
openssl rand -base64 32
```

Then start the container:

```bash
docker run -d \
  --name mcp-uptime-kuma \
  --restart unless-stopped \
  -p 3000:3000 \
  -e UPTIME_KUMA_URL=http://your-uptime-kuma-instance:3001 \
  -e UPTIME_KUMA_USERNAME=your_username \
  -e UPTIME_KUMA_PASSWORD=your_password \
  -e MCP_AUTH_TOKEN=your_generated_secret \
  davidfuchs/mcp-uptime-kuma:latest \
  -t streamable-http
```

Prefer Compose? Download the provided [docker-compose.yml](docker-compose.yml), fill in the
same variables, and run `docker compose up -d`.

Check it's up with `curl http://your-docker-host:3000/health`.

> **Don't skip `MCP_AUTH_TOKEN`.** Without it, anyone who can reach port 3000 gets full
> read/write control of your Uptime Kuma instance. Plain `http://` also sends the token
> unencrypted, so put the server behind a TLS reverse proxy before it leaves your LAN. See
> [Securing the HTTP Endpoint](#securing-the-http-endpoint).

In the client examples below, `UPTIME_KUMA_MCP_TOKEN` is an environment variable on the
machine running the client. It holds the same value as `MCP_AUTH_TOKEN`. Clients that can't
read environment variables take the token directly.

### 3. Connect your client

Jump to your client:

- [Claude Code](#claude-code)
- [Claude Desktop and claude.ai](#claude-desktop-and-claudeai)
- [GitHub Copilot (VS Code and Copilot CLI)](#github-copilot-vs-code-and-copilot-cli)
- [Codex and ChatGPT](#codex-and-chatgpt)
- [Cursor](#cursor)
- [LibreChat](#librechat)
- [Other clients](#other-clients)

The server is also listed in the official [MCP Registry](https://registry.modelcontextprotocol.io/)
as `io.github.DavidFuchs/mcp-uptime-kuma`. Clients and directories that read the registry can
find it and show its settings for you to fill in.

Every local example runs `@davidfuchs/mcp-uptime-kuma@latest`. Keep the `@latest` suffix.
Without it, npx reuses whatever version it cached the first time it ran and never picks up
new releases.

After connecting, ask something like *"How are my monitors doing?"* to check it works. If it
doesn't, see [Troubleshooting](#troubleshooting).

#### Claude Code

**Local:**

```bash
claude mcp add --scope user \
  --env UPTIME_KUMA_URL=http://your-uptime-kuma-instance:3001 \
  --env UPTIME_KUMA_USERNAME=your_username \
  --env UPTIME_KUMA_PASSWORD=your_password \
  --transport stdio uptime-kuma \
  -- npx -y @davidfuchs/mcp-uptime-kuma@latest
```

**Shared server:**

```bash
claude mcp add --scope user --transport http uptime-kuma \
  http://your-docker-host:3000/mcp \
  --header "Authorization: Bearer your_generated_secret"
```

`--scope user` makes the server available in every project. Leave it off to add the server to
the current project only, or use `--scope project` to write it to a `.mcp.json` you can commit.
A committed file should reference the token as `"Bearer ${UPTIME_KUMA_MCP_TOKEN}"` rather than
contain it. Run `/mcp` inside Claude Code to check the connection.

#### Claude Desktop and claude.ai

**Local (Claude Desktop only):** open *Settings → Developer → Edit Config* to open
`claude_desktop_config.json`, add the server, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "npx",
      "args": ["-y", "@davidfuchs/mcp-uptime-kuma@latest"],
      "env": {
        "UPTIME_KUMA_URL": "http://your-uptime-kuma-instance:3001",
        "UPTIME_KUMA_USERNAME": "your_username",
        "UPTIME_KUMA_PASSWORD": "your_password"
      }
    }
  }
}
```

**Shared server, reachable from the internet (claude.ai, Claude Desktop, mobile):** go to
*Customize → Connectors*, click *+ Add*, then *Add custom connector*. Give it a name and
enter `https://your-public-host/mcp`. Under *Authentication* choose *No sign in*, and under
*Request headers* add `Authorization: Bearer your_generated_secret`. On a Team or Enterprise
plan, an owner adds it for everyone under *Organization settings → Connectors*. Claude
connects from Anthropic's cloud, not from your computer. The server must therefore be
reachable over public HTTPS, for example through a reverse proxy or Cloudflare Tunnel. A
`localhost` or LAN address won't work.

**Shared server on your LAN (Claude Desktop):** connectors can't reach a private address.
Instead, bridge to it from `claude_desktop_config.json` with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote). `--allow-http` is only needed for a
plain `http://` URL that isn't `localhost`.

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://your-docker-host:3000/mcp",
        "--allow-http",
        "--header", "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer your_generated_secret"
      }
    }
  }
}
```

#### GitHub Copilot (VS Code and Copilot CLI)

Copilot reads `~/.copilot/mcp-config.json`, which VS Code's Copilot Chat and the `copilot` CLI
share. You can also use a `.mcp.json` at the root of a workspace. Values written as `${NAME}`
come from the environment of the machine running the server.

**Local:**

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@davidfuchs/mcp-uptime-kuma@latest"],
      "env": {
        "UPTIME_KUMA_URL": "http://your-uptime-kuma-instance:3001",
        "UPTIME_KUMA_USERNAME": "your_username",
        "UPTIME_KUMA_PASSWORD": "${UPTIME_KUMA_PASSWORD}"
      },
      "tools": ["*"]
    }
  }
}
```

**Shared server:**

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "type": "http",
      "url": "http://your-docker-host:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${UPTIME_KUMA_MCP_TOKEN}"
      },
      "tools": ["*"]
    }
  }
}
```

Older VS Code setups keep servers in `.vscode/mcp.json` or the profile `mcp.json` instead.
Those use a top-level `"servers"` key rather than `"mcpServers"`, and VS Code is phasing
them out. On a Business or Enterprise plan, an admin may first need to turn on the
*MCP servers in Copilot* policy.

#### Codex and ChatGPT

The Codex CLI, the Codex IDE extension and the ChatGPT desktop app share one configuration
file, `~/.codex/config.toml`.

**Local:**

```bash
codex mcp add uptime-kuma \
  --env UPTIME_KUMA_URL=http://your-uptime-kuma-instance:3001 \
  --env UPTIME_KUMA_USERNAME=your_username \
  --env UPTIME_KUMA_PASSWORD=your_password \
  -- npx -y @davidfuchs/mcp-uptime-kuma@latest
```

That command writes this to `config.toml`, which you can also edit by hand:

```toml
[mcp_servers.uptime-kuma]
command = "npx"
args = ["-y", "@davidfuchs/mcp-uptime-kuma@latest"]

[mcp_servers.uptime-kuma.env]
UPTIME_KUMA_URL = "http://your-uptime-kuma-instance:3001"
UPTIME_KUMA_USERNAME = "your_username"
UPTIME_KUMA_PASSWORD = "your_password"
```

**Shared server:** add this to `config.toml`, and set `UPTIME_KUMA_MCP_TOKEN` in the
environment Codex starts from:

```toml
[mcp_servers.uptime-kuma]
url = "http://your-docker-host:3000/mcp"
bearer_token_env_var = "UPTIME_KUMA_MCP_TOKEN"
```

Either way, you can add `default_tools_approval_mode = "writes"` to the server's table. Codex
then runs the read-only tools unattended and asks before anything that changes your
instance, using the [tool annotations](#features) this server provides.

**ChatGPT on the web** isn't supported. Its custom connectors call the server from OpenAI's
cloud and authenticate with OAuth or not at all, so they can't send the bearer token this
server requires. Use the ChatGPT desktop app or Codex instead.

#### Cursor

Add this to `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one project.

**Local:**

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "npx",
      "args": ["-y", "@davidfuchs/mcp-uptime-kuma@latest"],
      "env": {
        "UPTIME_KUMA_URL": "http://your-uptime-kuma-instance:3001",
        "UPTIME_KUMA_USERNAME": "your_username",
        "UPTIME_KUMA_PASSWORD": "your_password"
      }
    }
  }
}
```

**Shared server:**

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "url": "http://your-docker-host:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${env:UPTIME_KUMA_MCP_TOKEN}"
      }
    }
  }
}
```

#### LibreChat

Add this to `librechat.yaml`.

**Local:**

```yaml
mcpServers:
  uptime-kuma:
    command: npx
    args: ["-y", "@davidfuchs/mcp-uptime-kuma@latest"]
    env:
      UPTIME_KUMA_URL: "http://your-instance:3001"
      UPTIME_KUMA_USERNAME: "your_username"
      UPTIME_KUMA_PASSWORD: "your_password"
    serverInstructions: true
```

**Shared server:** LibreChat blocks MCP connections to private addresses by default, and that
includes `localhost`, LAN IPs and a container name on a Docker network. List the host from the
URL under `allowedDomains` to allow it. Once `allowedDomains` is set, it's a strict allowlist:
list your other MCP servers' hosts there too, or they'll stop connecting.

```yaml
mcpServers:
  uptime-kuma:
    type: streamable-http
    url: "http://mcp-uptime-kuma:3000/mcp"
    headers:
      Authorization: "Bearer ${UPTIME_KUMA_MCP_TOKEN}"
    serverInstructions: true

mcpSettings:
  allowedDomains:
    - 'mcp-uptime-kuma'
```

LibreChat runs in a browser. If you set `ALLOWED_ORIGIN` on the server, include your
LibreChat origin in it.

#### Other clients

Most other clients, including Windsurf, Cline, Zed and Gemini CLI, accept some variation of
the standard `mcpServers` block. Check your client's docs for the file location and the key it
uses for HTTP servers (`url`, `serverUrl` or `httpUrl`).

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "npx",
      "args": ["-y", "@davidfuchs/mcp-uptime-kuma@latest"],
      "env": { "UPTIME_KUMA_URL": "http://your-uptime-kuma-instance:3001" }
    }
  }
}
```

For a shared server, use `"url": "http://your-docker-host:3000/mcp"` and
`"headers": { "Authorization": "Bearer your_generated_secret" }` instead of `command`/`args`/`env`.

No Node.js on the machine? Clients can run the server locally through Docker instead of npx,
because the image speaks stdio by default:

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "UPTIME_KUMA_URL", "-e", "UPTIME_KUMA_USERNAME", "-e", "UPTIME_KUMA_PASSWORD",
        "davidfuchs/mcp-uptime-kuma:latest"
      ],
      "env": {
        "UPTIME_KUMA_URL": "http://your-uptime-kuma-instance:3001",
        "UPTIME_KUMA_USERNAME": "your_username",
        "UPTIME_KUMA_PASSWORD": "your_password"
      }
    }
  }
}
```

## Available Tools

### Monitors

| Tool | Purpose |
|------|---------|
| `getMonitorSummary` | Get a quick overview of all monitors with their current status. Supports filtering. |
| `listMonitors` | Get the full list of all monitors with configurations. Supports filtering. |
| `listMonitorTypes` | Get all available monitor types supported by Uptime Kuma. |
| `getMonitorTypeFields` | Get the required and optional fields of one monitor type: what each means and accepts, whether it is passed at the top level or in `typeFields`, and the defaults applied. |
| `getMonitor` | Get detailed configuration for a specific monitor by ID. |
| `createMonitor` | Create a new monitor of any type (requires name, type, and whatever that type checks, e.g. `url` for http or `hostname` for ping). Type-specific fields, including HTTP authentication, go in `typeFields`. |
| `updateMonitor` | Update an existing monitor's configuration, including changing its type in place (keeps the ID and history). |
| `deleteMonitor` | Permanently delete a monitor and all its heartbeat history. |
| `pauseMonitor` | Pause a monitor to stop performing checks. |
| `resumeMonitor` | Resume a paused monitor to restart checks. |

### Heartbeats

| Tool | Purpose |
|------|---------|
| `listHeartbeats` | Get status check history for all monitors. |
| `getHeartbeats` | Get status check history for a specific monitor. |

### Notifications

| Tool | Purpose |
|------|---------|
| `listNotifications` | List all configured notification channels (Slack, Discord, email, webhooks, etc.). |
| `addNotification` | Create a new notification channel. |
| `updateNotification` | Update an existing notification channel. |
| `deleteNotification` | Permanently delete a notification channel. |

### Tags

| Tool | Purpose |
|------|---------|
| `listTags` | List all tags defined in Uptime Kuma. |
| `addTag` | Create a new tag that can be assigned to monitors. |
| `deleteTag` | Permanently delete a tag (removes it from all monitors). |

### Maintenance

| Tool | Purpose |
|------|---------|
| `getMaintenanceWindows` | List all maintenance windows, with the monitors each one covers. |
| `createMaintenance` | Schedule a new maintenance window and attach the monitors it suppresses. |
| `updateMaintenance` | Change a maintenance window's schedule, details, or monitor list. |
| `pauseMaintenance` | Switch a maintenance window off (ends a manual window). |
| `resumeMaintenance` | Switch a paused maintenance window back on (starts a manual window). |
| `deleteMaintenance` | Permanently delete a maintenance window. |

### Status Pages

| Tool | Purpose |
|------|---------|
| `listStatusPages` | List all configured status pages with their slug, title, visibility, and custom domains. |
| `getStatusPage` | Get one status page by slug, including its groups, the monitors in each group, and active incidents. Works for unpublished pages too. |
| `createStatusPage` | Create a new, empty status page with a title and slug. Follow up with `updateStatusPage` to add groups and monitors. |
| `updateStatusPage` | Change a status page's settings (description, theme, published, custom domains, CSS, …) and, optionally, replace its groups and their monitors. |
| `deleteStatusPage` | Permanently delete a status page; its URL stops working. |

### Docker Hosts

| Tool | Purpose |
|------|---------|
| `listDockerHosts` | List the docker daemon connections that docker container monitors use. |
| `testDockerHost` | Check that a docker daemon is reachable, without saving it. Reports the number of containers on success. |
| `addDockerHost` | Add a docker daemon connection, over a unix socket or TCP (e.g. a docker socket proxy). |
| `updateDockerHost` | Change an existing docker daemon connection. Fields you don't pass keep their values. |
| `deleteDockerHost` | Permanently delete a docker daemon connection. Monitors that used it are kept but lose their docker host. |

### Settings

| Tool | Purpose |
|------|---------|
| `getSettings` | Get Uptime Kuma server settings, such as timezone, primary base URL, and data retention. |

### Type-specific monitor fields

`createMonitor` and `updateMonitor` declare the fields most monitors use (`url`, `hostname`,
`port`, `keyword`, `interval`, …) as ordinary arguments. Everything specific to one kind of
monitor goes in a single `typeFields` object:

```
createMonitor({ name: "API", type: "http", url: "https://api.example.com/health",
                typeFields: { bearer_token: "…" } })
createMonitor({ name: "Broker", type: "mqtt", hostname: "mqtt://broker.example.com", port: 1883,
                typeFields: { mqttTopic: "sensors/#" } })
```

`getMonitorTypeFields({ type })` lists what a type needs and accepts. The fields are kept out
of the tool definitions on purpose: there are about 85 of them, and tool definitions are loaded
into every conversation whether or not a monitor is ever created. `typeFields` is still
validated — an unknown name or a bad value is refused, with the accepted spelling suggested.

`getMonitor` returns these fields at the top level of the monitor, as Uptime Kuma stores them.
To change one, pass it inside `typeFields`.

### Filtering

`getMonitorSummary` and `listMonitors` support filtering by:

- **keywords**: Space-separated keywords for fuzzy matching against monitor pathNames
- **type**: Monitor type(s), comma-separated (e.g., `"http"`, `"http,ping,dns"`)
- **active**: Filter by active (`true`) or inactive (`false`) monitors
- **maintenance**: Filter by maintenance mode status
- **tags**: Tag name and optional value, comma-separated (e.g., `"production"`, `"env=staging"`)
- **parentId**: Group monitor ID, returning that group's **direct** children. Pass `null` for top-level monitors (those with no parent). Not recursive — to walk deeper, use each child group's own `childrenIDs`.
- **status** (getMonitorSummary only): Heartbeat status (`"0"`=DOWN, `"1"`=UP, `"2"`=PENDING, `"3"`=MAINTENANCE)

**Examples:**
```javascript
getMonitorSummary({ status: "0" })                     // All DOWN monitors
getMonitorSummary({ type: "http", maintenance: true }) // HTTP monitors in maintenance
getMonitorSummary({ parentId: 12, status: "0" })       // What's down inside group 12
listMonitors({ tags: "production,region=us-east" })    // Monitors with specific tags
listMonitors({ parentId: 12 })                         // Direct children of group 12
listMonitors({ parentId: null })                       // Top-level monitors only
```

## Configuration Reference

Every setting is an environment variable. The sections after this table explain the ones that
need more than a line.

**Connecting to Uptime Kuma** (both transports)

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPTIME_KUMA_URL` | *required* | Address of your Uptime Kuma 2 instance, e.g. `http://192.168.1.10:3001`. |
| `UPTIME_KUMA_USERNAME` | unset | Username to log in with. See [Authentication Methods](#authentication-methods). |
| `UPTIME_KUMA_PASSWORD` | unset | Password to log in with. |
| `UPTIME_KUMA_2FA_TOKEN` | unset | Current 2FA code. It expires within seconds, so prefer `UPTIME_KUMA_JWT_TOKEN` when 2FA is on. |
| `UPTIME_KUMA_JWT_TOKEN` | unset | JWT to log in with instead of a username and password. Takes precedence over them. |
| `UPTIME_KUMA_HEADERS` | unset | JSON object of extra headers sent on every request, for an [authenticating proxy](#behind-an-authenticating-proxy-cloudflare-access-etc) in front of Uptime Kuma. |

**What the server exposes** (both transports)

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPTIME_KUMA_READ_ONLY` | `false` | `true` registers only the tools that read. See [Read-Only Mode](#read-only-mode). |
| `UPTIME_KUMA_INCLUDE_SECRETS` | `false` | `true` returns passwords, tokens and API keys in tool output instead of `***`. See [Credential Redaction](#credential-redaction). |

**HTTP endpoint** (`-t streamable-http` only)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_AUTH_TOKEN` | unset (no auth) | Shared secret clients must send as `Authorization: Bearer <token>`. See [Securing the HTTP Endpoint](#securing-the-http-endpoint). |
| `ALLOWED_ORIGIN` | `*` (no check) | Comma-separated browser origins allowed to call `/mcp`. |
| `HOST` | `0.0.0.0` | Address to bind. |
| `PORT` | `3000` | Port to listen on. |
| `TRUST_PROXY` | unset (no trust) | Trust `X-Forwarded-For` from a reverse proxy: a hop count, `true`/`false`, or an IP/subnet list. |
| `RATE_LIMIT_MAX` | `1000` | Requests per client IP every 15 minutes. `0` turns the limit off. |

The transport itself is a command-line option, not a variable: `-t stdio` (the default) or
`-t streamable-http`.

## Authentication Methods

### Anonymous Authentication
If authentication is disabled on your Uptime Kuma instance, only `UPTIME_KUMA_URL` is required.

### Username/Password Authentication
```
UPTIME_KUMA_URL=http://your-instance:3001
UPTIME_KUMA_USERNAME=your_username
UPTIME_KUMA_PASSWORD=your_password
UPTIME_KUMA_2FA_TOKEN=123456  # Optional, only if 2FA is enabled
```

### JWT Token Authentication
Recommended for 2FA users. Takes precedence over username/password if both are provided.

```
UPTIME_KUMA_URL=http://your-instance:3001
UPTIME_KUMA_JWT_TOKEN=your_jwt_token
```

#### Obtaining Your JWT Token

**Using the CLI utility (recommended):**
```bash
npx -p @davidfuchs/mcp-uptime-kuma@latest mcp-uptime-kuma-get-jwt http://localhost:3001 admin mypassword
```

**Using Docker:**
```bash
docker run --rm davidfuchs/mcp-uptime-kuma:latest get-jwt http://host.docker.internal:3001 admin mypassword
```

**From browser:** Open Developer Tools → Storage/Application → Local Storage → find `token` key.

### Behind an Authenticating Proxy (Cloudflare Access, etc.)

If Uptime Kuma sits behind a proxy that demands its own credentials — a Cloudflare Zero Trust
Access application, oauth2-proxy, an API gateway — set `UPTIME_KUMA_HEADERS` to a JSON object of
headers to send on every request. It combines with any of the methods above, which still handle
logging in to Uptime Kuma itself.

For Cloudflare Access, create a service token, add a *Service Auth* policy to the application that
allows it, then:

```
UPTIME_KUMA_URL=https://uptime.example.com
UPTIME_KUMA_HEADERS={"CF-Access-Client-Id":"<client-id>.access","CF-Access-Client-Secret":"<client-secret>"}
UPTIME_KUMA_USERNAME=your_username
UPTIME_KUMA_PASSWORD=your_password
```

In an MCP client's JSON config the value is a string, so the inner quotes need escaping:

```json
"UPTIME_KUMA_HEADERS": "{\"CF-Access-Client-Id\":\"<client-id>.access\",\"CF-Access-Client-Secret\":\"<client-secret>\"}"
```

`mcp-uptime-kuma-get-jwt` reads the same variable. A malformed value stops the server at startup
with an error naming the offending header; header values are never logged.

## Read-Only Mode

To expose only the tools that report, and none that create, change, pause or delete, set:

```
UPTIME_KUMA_READ_ONLY=true
```

The write tools are then not registered at all, so they cannot be called and take up no room in
the conversation. Thirteen tools remain: the `get…` and `list…` tools, minus
`getMonitorTypeFields`, which only serves the write tools. This limits what the MCP server
offers; it does not change what the Uptime Kuma account itself is allowed to do.

## Securing the HTTP Endpoint

Applies to `-t streamable-http` only. Anyone who can reach `/mcp` has full read/write control
of your Uptime Kuma instance, and the defaults are permissive so that upgrading can't break an
existing deployment. The server warns at startup when it's unprotected. For anything beyond
your own machine:

- **Set `MCP_AUTH_TOKEN`** to a long random secret (`openssl rand -base64 32`). Clients then
  send it as `Authorization: Bearer <token>`.
- **Set `ALLOWED_ORIGIN`** if you use a browser-based client. This blocks DNS rebinding
  attacks, which a token alone doesn't stop.
- **Put it behind a TLS reverse proxy** before it leaves your LAN. Set `TRUST_PROXY` then, so
  rate limiting sees real client IPs.

`/health` stays unauthenticated so container healthchecks keep working. It reports only
liveness. The image's own healthcheck probes it when the container runs the HTTP transport,
so `docker ps` shows the container as healthy or not; under stdio there is nothing to probe
and the check passes.

The details, including why `Origin` validation matters separately from the token and how
`TRUST_PROXY` can be abused, are in [docs/http-security.md](https://github.com/DavidFuchs/mcp-uptime-kuma/blob/main/docs/http-security.md).

## Credential Redaction

Read tools return `***` in place of passwords, tokens, API keys and HTTP headers. Tool output
lands in your conversation transcript, and asking "what am I monitoring?" shouldn't write a
live SMTP password into it.

- **Writing `***` back is safe.** `updateMonitor` and `updateNotification` keep the stored
  value when a field arrives as `***`, so the assistant can read, edit and write a
  configuration without wiping its credentials.
- **Push tokens are returned when they're created**, by `createMonitor` or by switching a
  monitor to push, since the sender can't be set up without them.
- **To see real values**, pass `includeSecrets: true` on a call, or set
  `UPTIME_KUMA_INCLUDE_SECRETS=true` for every call.

[docs/credential-redaction.md](https://github.com/DavidFuchs/mcp-uptime-kuma/blob/main/docs/credential-redaction.md) lists exactly what each tool
withholds and how credentials inside URLs are handled.

## Troubleshooting

**Where to look first.** In Claude Code or Codex, run `/mcp` to see whether the server
connected. The server writes its errors to stderr:

- **VS Code:** run *MCP: List Servers*, pick the server and choose *Show Output*.
- **Claude Desktop:** look for `mcp-server-uptime-kuma.log` in its logs folder:
  `~/Library/Logs/Claude` on macOS, `%APPDATA%\Claude\logs` on Windows,
  `~/.config/Claude/logs` on Linux.
- **Docker:** run `docker logs mcp-uptime-kuma`.

**The server connects but every tool call fails.** The server stays up even when it can't log
in to Uptime Kuma. That way it recovers on its own when Uptime Kuma restarts. Look for
`Initial authentication failed, will retry on demand` in the logs. It is followed by the reason:

- *Can't reach the address.* Check `UPTIME_KUMA_URL` from the machine the server runs on.
  Inside a container, `localhost` is the container itself. Use the host's LAN IP, the Uptime
  Kuma container's name on a shared Docker network, or `host.docker.internal` (Docker Desktop).
- *`authInvalidToken`.* The JWT is wrong or no longer valid. Generate a new one with
  `mcp-uptime-kuma-get-jwt` (see [Obtaining Your JWT Token](#obtaining-your-jwt-token)).
- *Login fails with 2FA on.* `UPTIME_KUMA_2FA_TOKEN` is a one-time code that's only valid for
  a few seconds, so a value saved in a config file works once at most. Use a JWT instead.

**The client gets `401` from the shared server.** The token the client sends doesn't match
`MCP_AUTH_TOKEN`. Check for a missing `Bearer ` prefix, stray whitespace or quotes copied
along with the secret, and that the client's environment variable is set where the client
starts. A GUI app launched from the Dock or Start menu doesn't see variables exported in your
shell profile.

**A browser-based client gets `403`.** Its origin isn't listed in `ALLOWED_ORIGIN`. Add it
exactly as the browser sends it, with scheme and port, for example `http://localhost:5173`.

**You get `429 Too Many Requests`.** One client IP made more than `RATE_LIMIT_MAX` requests
in 15 minutes. Behind a reverse proxy, every client usually shares the proxy's IP. Set
`TRUST_PROXY` (see [Running behind a reverse proxy](https://github.com/DavidFuchs/mcp-uptime-kuma/blob/main/docs/http-security.md#running-behind-a-reverse-proxy)), or
raise the limit.

**A new release's tools or fixes don't show up.** npx is running a cached older version.
Make sure the package is written as `@davidfuchs/mcp-uptime-kuma@latest`, then restart the
client. With Docker, run `docker pull davidfuchs/mcp-uptime-kuma:latest` and recreate the
container.

**The assistant can't create or change anything.** Check whether `UPTIME_KUMA_READ_ONLY` is
set. If it is, the write tools aren't registered at all.

## Contributing

For development setup, building, testing, and project structure, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Learn More

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Specification](https://modelcontextprotocol.io/specification/latest)

## Security

To report a vulnerability, please see [SECURITY.md](SECURITY.md).

## Disclaimer

This is a personal, free, open-source side project provided "as is" under the
[MIT License](LICENSE), without warranty of any kind. You install and run it
yourself, and it connects to an Uptime Kuma instance that you control. The
author is not responsible for any damage, data loss, downtime, or other
consequences arising from its use. Use at your own risk.

## License

Licensed under the [MIT License](LICENSE).
