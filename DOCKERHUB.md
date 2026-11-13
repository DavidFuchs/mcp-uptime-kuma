# mcp-uptime-kuma

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Uptime Kuma](https://github.com/louislam/uptime-kuma) *version 2*. It lets an AI assistant read and manage your monitors, notification channels, tags, maintenance windows, status pages and Docker hosts.

This image runs the server over streamable HTTP so several machines or people can share one instance. Full documentation, client setup and the tool list are in the [GitHub README](https://github.com/DavidFuchs/mcp-uptime-kuma#readme).

## Quick Start

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

Clients then connect to `http://your-docker-host:3000/mcp` and send `MCP_AUTH_TOKEN` as a bearer token. A [docker-compose.yml](https://github.com/DavidFuchs/mcp-uptime-kuma/blob/main/docker-compose.yml) is also provided.

## Requirements

- **Uptime Kuma 2.0 or later.** Version 1.x is not supported.
- **Your Uptime Kuma URL and a way to log in.** A username and password work. Use a JWT token if you have 2FA.

## More

- [Setup for each AI client](https://github.com/DavidFuchs/mcp-uptime-kuma#setup)
- [Available tools](https://github.com/DavidFuchs/mcp-uptime-kuma#available-tools)
- [Configuration reference](https://github.com/DavidFuchs/mcp-uptime-kuma#configuration-reference)
- [Authentication methods](https://github.com/DavidFuchs/mcp-uptime-kuma#authentication-methods)
- [Read-only mode](https://github.com/DavidFuchs/mcp-uptime-kuma#read-only-mode)
- [Securing the HTTP endpoint](https://github.com/DavidFuchs/mcp-uptime-kuma#securing-the-http-endpoint)
- [Troubleshooting](https://github.com/DavidFuchs/mcp-uptime-kuma#troubleshooting)

Also available on npm as [@davidfuchs/mcp-uptime-kuma](https://www.npmjs.com/package/@davidfuchs/mcp-uptime-kuma). MIT licensed.
