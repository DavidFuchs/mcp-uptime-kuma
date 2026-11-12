# Securing the HTTP Endpoint

Applies to `-t streamable-http` only. The stdio transport has no listener to protect and
takes its credentials from the environment, as the MCP specification prescribes.

Anyone who can reach `/mcp` has full read/write control of your Uptime Kuma instance,
including deleting monitors. Two settings guard it, and both default to permissive so that
upgrading cannot break an existing deployment - the server warns at startup in that state.

The settings involved are `MCP_AUTH_TOKEN`, `ALLOWED_ORIGIN`, `HOST`, `PORT`, `TRUST_PROXY`
and `RATE_LIMIT_MAX`. The [Configuration Reference](../README.md#configuration-reference) lists
their defaults. The sections below explain the choices that matter.

`/health` is deliberately left unauthenticated so container healthchecks and load balancer
probes keep working. It reports nothing but liveness.

## Setting a token

Generate a high-entropy secret - this is a password, and it is compared in constant time,
so length is the only thing protecting it:

```bash
openssl rand -base64 32
```

```bash
docker run -d \
  --name mcp-uptime-kuma \
  -p 3000:3000 \
  -e UPTIME_KUMA_URL=http://your-uptime-kuma-instance:3001 \
  -e UPTIME_KUMA_JWT_TOKEN=your_jwt_token \
  -e MCP_AUTH_TOKEN=your_generated_secret \
  davidfuchs/mcp-uptime-kuma:latest \
  -t streamable-http
```

Clients then send it as a header:

```json
{
  "mcpServers": {
    "uptime-kuma": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your_generated_secret"
      }
    }
  }
}
```

## Why `Origin` validation matters separately

A shared secret stops anyone who cannot present it. It does not stop a website your browser
already trusts. Under a DNS rebinding attack a page on `evil.example` resolves its own
hostname to `127.0.0.1`, so the browser treats requests to your local server as same-origin
- no preflight happens and CORS never applies. The server comparing the `Origin` header it
was sent against a list of expected origins is the only check left standing, which is why
the MCP specification makes it a MUST rather than a SHOULD.

If you only use native clients, leaving `ALLOWED_ORIGIN` unset costs you nothing; those
clients send no `Origin` header. If you use a browser-based client, list its origin:

```
ALLOWED_ORIGIN=https://librechat.example.com,http://localhost:5173
```

## Running behind a reverse proxy

Without `TRUST_PROXY`, Express sees every request as coming from the proxy's IP, so the
rate limiter puts all of your clients in one shared bucket (`RATE_LIMIT_MAX`) and starts
returning spurious `429`s once traffic from any of them adds up.

Set `TRUST_PROXY` to the number of proxy hops in front of the server so it reads the
real client IP from `X-Forwarded-For` instead:

```
TRUST_PROXY=1
```

Only set this when a proxy you control is actually there to strip and re-set that
header. If the server is reachable directly as well, or the proxy passes through
whatever `X-Forwarded-For` it receives, a client can forge that header to get a fresh
rate-limit bucket on every request, defeating the limiter entirely.
