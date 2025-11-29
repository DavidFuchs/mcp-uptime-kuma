# Contributing to mcp-uptime-kuma

This guide covers how to set up your development environment, build, test, and contribute to mcp-uptime-kuma.

## Prerequisites

- Node.js (v18 or higher)
- An Uptime Kuma instance (version 2) for testing

## Getting Started

Clone the repository and install dependencies:

```bash
git clone https://github.com/DavidFuchs/mcp-uptime-kuma.git
cd mcp-uptime-kuma
npm install
```

### Environment Configuration

Copy [.env.example](.env.example) to `.env` and configure the required environment variables for your Uptime Kuma instance (URL and authentication method).

## Building

Build the TypeScript code to JavaScript:

```bash
npm run build
```

For development with auto-rebuild:

```bash
npm run watch
```

## Running Locally

### stdio Transport (default)

Run in production mode (requires build first):

```bash
npm start
```

or

```bash
npm run start:stdio
```

This mode is designed to be spawned by MCP clients (like Claude Desktop, VS Code, etc.) that communicate via standard input/output.

### Streamable HTTP Transport

Run in production mode (requires build first):

```bash
npm run start:http
```

By default, the HTTP server runs on port 3000. You can change this with the `PORT` environment variable:

```bash
PORT=8080 npm run start:http
```

The MCP endpoint will be available at `http://localhost:3000/mcp`

## Testing

### Using MCP Inspector

You can test the server using the MCP Inspector:

```bash
npm run inspector
```

### HTTP Transport Testing

Start the HTTP server:
```bash
npm run dev:http
```

Then use the MCP Inspector:
```bash
npx @modelcontextprotocol/inspector
```
Connect to: `http://localhost:3000/mcp`

### Integration Tests

Run the full integration test suite (recommended):

```bash
npm run test:integration
```

This uses the `run-tests.sh` script which automatically spins up an Uptime Kuma instance via Docker, runs the tests, and cleans up afterwards.

**Running tests against your own instance:**

If you already have an Uptime Kuma instance running, you can run the tests directly:

```bash
export UPTIME_KUMA_URL=http://localhost:3001
export UPTIME_KUMA_USERNAME=admin
export UPTIME_KUMA_PASSWORD=your_password
npm run test:integration:direct
```

See [test/TESTING.md](test/TESTING.md) for detailed testing documentation.

## Project Structure

```
mcp-uptime-kuma/
├── src/
│   ├── index.ts                # Main entry point with transport selection
│   ├── server.ts               # Core MCP server configuration with tools
│   ├── uptime-kuma-client.ts   # WebSocket client for Uptime Kuma API
│   ├── types/                  # TypeScript type definitions
│   └── version.ts              # Runtime version information
├── test/                       # Test files and infrastructure
├── .github/                    # GitHub workflows and configurations
├── docker-compose.yml          # Docker Compose configuration
├── Dockerfile                  # Docker image definition
├── .env.example                # Example environment configuration
├── package.json                # Project dependencies and scripts
└── tsconfig.json               # TypeScript configuration
```

## Development Tips

- To add new tools or modify existing ones, edit `src/server.ts`
- The Uptime Kuma client in `src/uptime-kuma-client.ts` handles the WebSocket connection and retrieves monitor and heartbeat data
- Use `npm run dev` or `npm run dev:http` for development with hot reload

## Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests to ensure everything works
5. Submit a pull request

## Learn More

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
