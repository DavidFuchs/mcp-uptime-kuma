# mcp-uptime-kuma

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Uptime Kuma](https://github.com/louislam/uptime-kuma) *version 2*. Supports stdio and streamable HTTP transports.

![GitHub Stars](https://img.shields.io/github/stars/DavidFuchs/mcp-uptime-kuma?style=flat)
![GitHub Last Commit](https://img.shields.io/github/last-commit/DavidFuchs/mcp-uptime-kuma?style=flat)
![GitHub Repo Size](https://img.shields.io/github/repo-size/DavidFuchs/mcp-uptime-kuma?style=flat)

![GitHub Actions - npmjs](https://img.shields.io/github/actions/workflow/status/DavidFuchs/mcp-uptime-kuma/publish-npm.yml?style=flat&label=npmjs%20build&link=https://www.npmjs.com/package/@davidfuchs/mcp-uptime-kuma)
![npmjs Version](https://img.shields.io/npm/v/%40davidfuchs%2Fmcp-uptime-kuma?style=flat&label=npmjs%20package%20version)
![npmjs Downloads](https://img.shields.io/npm/d18m/%40davidfuchs%2Fmcp-uptime-kuma?style=flat&label=npmjs%20downloads&color=blue)

![GitHub Actions - DockerHub](https://img.shields.io/github/actions/workflow/status/DavidFuchs/mcp-uptime-kuma/publish-docker.yml?style=flat&label=docker%20build&link=https://www.npmjs.com/package/@davidfuchs/mcp-uptime-kuma)
![Docker Version](https://img.shields.io/docker/v/davidfuchs/mcp-uptime-kuma?style=flat&label=docker%20image%20version)
![Docker Pulls](https://img.shields.io/docker/pulls/davidfuchs/mcp-uptime-kuma?style=flat)

## Features

- **Real-time Monitoring**: Access monitors, heartbeats, uptime, and responsiveness metrics via Socket.IO with instant status change notifications.
- **Context-Friendly**: Returns only essential data by default to avoid overwhelming LLM context windows.
- **Multiple Transports**: Supports stdio (local) and streamable HTTP (remote) transports.

## Quick Start

### Using npx (stdio transport)

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "command": "npx",
      "args": ["-y", "@davidfuchs/mcp-uptime-kuma"],
      "env": {
        "UPTIME_KUMA_URL": "http://your-uptime-kuma-instance:3001",
        "UPTIME_KUMA_USERNAME": "your_username",
        "UPTIME_KUMA_PASSWORD": "your_password"
      }
    }
  }
}
```

### Using Docker (streamable HTTP transport)

**Option 1: Docker Run**

```bash
docker run -d \
  --name mcp-uptime-kuma \
  -p 3000:3000 \
  -e UPTIME_KUMA_URL=http://your-uptime-kuma-instance:3001 \
  -e UPTIME_KUMA_USERNAME=your_username \
  -e UPTIME_KUMA_PASSWORD=your_password \
  davidfuchs/mcp-uptime-kuma:latest \
  -t streamable-http
```

**Option 2: Docker Compose**

A [docker-compose.yml](docker-compose.yml) file is provided in the repository. Download it, configure your environment variables, and run:

```bash
docker compose up -d
```

Then configure your MCP client to connect to the endpoint:

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

See [Authentication Methods](#authentication-methods) for JWT token and anonymous authentication options.

## Example Conversation

![MCP server answering questions about Uptime Kuma monitors](.github/images/screenshot-1.png)
*Conversation in [LibreChat](https://github.com/danny-avila/LibreChat) where the `mcp-uptime-kuma` server is providing real-time information from Uptime Kuma.*

## Available Tools

| Tool | Purpose |
|------|---------|
| `getMonitorSummary` | Get a quick overview of all monitors with their current status. Supports filtering. |
| `listMonitors` | Get the full list of all monitors with configurations. Supports filtering. |
| `listMonitorTypes` | Get all available monitor types supported by Uptime Kuma. |
| `getMonitor` | Get detailed configuration for a specific monitor by ID. |
| `pauseMonitor` | Pause a monitor to stop performing checks. |
| `resumeMonitor` | Resume a paused monitor to restart checks. |
| `listHeartbeats` | Get status check history for all monitors. |
| `getHeartbeats` | Get status check history for a specific monitor. |
| `getSettings` | Get Uptime Kuma server settings. |

### Filtering

`getMonitorSummary` and `listMonitors` support filtering by:

- **keywords**: Space-separated keywords for fuzzy matching against monitor pathNames
- **type**: Monitor type(s), comma-separated (e.g., `"http"`, `"http,ping,dns"`)
- **active**: Filter by active (`true`) or inactive (`false`) monitors
- **maintenance**: Filter by maintenance mode status
- **tags**: Tag name and optional value, comma-separated (e.g., `"production"`, `"env=staging"`)
- **status** (getMonitorSummary only): Heartbeat status (`"0"`=DOWN, `"1"`=UP, `"2"`=PENDING, `"3"`=MAINTENANCE)

**Examples:**
```javascript
getMonitorSummary({ status: "0" })                    // All DOWN monitors
getMonitorSummary({ type: "http", maintenance: true }) // HTTP monitors in maintenance
listMonitors({ tags: "production,region=us-east" })    // Monitors with specific tags
```

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
npx -p @davidfuchs/mcp-uptime-kuma mcp-uptime-kuma-get-jwt http://localhost:3001 admin mypassword
```

**Using Docker:**
```bash
docker run --rm davidfuchs/mcp-uptime-kuma:latest get-jwt http://host.docker.internal:3001 admin mypassword
```

**From browser:** Open Developer Tools → Storage/Application → Local Storage → find `token` key.

## LibreChat Configuration

**stdio transport:**
```yaml
mcpServers:
  uptime-kuma:
    command: npx
    args: ["-y", "@davidfuchs/mcp-uptime-kuma"]
    env:
      UPTIME_KUMA_URL: "http://your-instance:3001"
      UPTIME_KUMA_USERNAME: "your_username"
      UPTIME_KUMA_PASSWORD: "your_password"
    serverInstructions: true
```

**streamable HTTP transport:**
```yaml
mcpServers:
  uptime-kuma:
    type: streamable-http
    url: "http://mcp-uptime-kuma:3000/mcp"
    serverInstructions: true
```

## Contributing

For development setup, building, testing, and project structure, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Learn More

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
