# mcp-uptime-kuma

A Model Context Protocol (MCP) server for [Uptime Kuma](https://github.com/louislam/uptime-kuma) *version 2*, built with TypeScript and supporting both stdio and streamable HTTP transports.

## Features

- **Uptime Kuma Integration**: Real-time access to monitors and heartbeats via WebSocket connection. This MCP server is immediately notified of status changes in Uptime Kuma.
- **Context-Friendly**: Carefully controls the amount of data returned to avoid overwhelming the LLM context window. Tools default to returning only essential fields and recent heartbeats, with options to request more when needed.
- **Multiple Transports**: Supports both stdio (for local integration) and streamable HTTP (for remote access).
- **MCP SDK**: Uses the official `@modelcontextprotocol/sdk` package
- **Comprehensive Tools**: Retrieve monitor configurations and status data (heartbeats)

## Available Tools

### getMonitorSummary
Retrieves a summarized list of all monitors with essential information and their current status.

- **Input**:
  - `keywords` (string, optional): Space-separated keywords to filter monitors by pathName (case-insensitive). All keywords must match for a monitor to be included.
- **Output**: Array of monitor summaries with:
  - Monitor ID, name, pathName
  - Active and maintenance state
  - Most recent heartbeat status (0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE)
  - Status message from the most recent heartbeat
  - Total count of matching monitors

### getMonitor
Retrieves detailed information about a specific monitor by its ID.

- **Input**: 
  - `monitorID` (number): The ID of the monitor to retrieve
  - `includeAdditionalFields` (boolean, optional): Include all additional fields from Uptime Kuma (default: false)
- **Output**: Monitor configuration object with details like URL, type, check interval, notification settings, etc.

### listMonitors
Retrieves the full list of all monitors the user has access to.

- **Input**:
  - `includeAdditionalFields` (boolean, optional): Include all additional fields from Uptime Kuma (default: false)
- **Output**: Array of monitor objects with count

### getHeartbeats
Retrieves heartbeats (status checks) for a specific monitor.

- **Input**:
  - `monitorID` (number): The ID of the monitor to get heartbeats for
  - `maxHeartbeats` (number, optional): Maximum number of most recent heartbeats to return (1-100). Default: 1
- **Output**: Object containing:
  - `monitorID`: The monitor ID
  - `heartbeats`: Array of heartbeat objects with status, response time, timestamps, etc.
  - `count`: Number of heartbeats returned

### listHeartbeats
Retrieves the heartbeats for all monitors.

- **Input**:
  - `maxHeartbeats` (number, optional): Maximum number of most recent heartbeats per monitor (1-100). Default: 1
- **Output**: Object containing:
  - `heartbeats`: Map of monitor IDs to their heartbeat arrays
  - `monitorCount`: Number of monitors
  - `totalHeartbeatCount`: Total number of heartbeats across all monitors

## Usage Notes

- **Monitors** contain configuration information (URLs, check intervals, notification settings, etc.)
- **Heartbeats** contain actual status data (up/down status, response times, timestamps, etc.)
- To check if something is **up or down**, use the heartbeat tools, not the monitor tools
- Use **getMonitorSummary** for a quick overview of all monitors and their current status
- By default, monitor tools return only essential fields. Set `includeAdditionalFields=true` to get all available data
- By default, heartbeat tools return only the most recent heartbeat. Use `maxHeartbeats` to retrieve more historical data

## Prerequisites

- Node.js (v18 or higher)
- An Uptime Kuma instance with credentials
- Environment variables for configuration (see Configuration section)

## Production Usage

This MCP server supports both stdio and streamable HTTP transports.

### For the stdio Transport

For Claude Code, VS Code, or other MCP clients, you can configure the server as follows:

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

If you're using LibreChat (librechat.yaml), you can configure it like this:

```yaml
mcpServers:
  uptime-kuma:                                                       
    command: npx                                                     
    args: ["-y", "@davidfuchs/mcp-uptime-kuma"]                      
    customUserVars:                                                  
      UPTIME_KUMA_URL:                                               
        title: "Uptime Kuma URL"                                     
        description: "The URL to log into Uptime Kuma."              
      UPTIME_KUMA_USERNAME:                                          
        title: "Uptime Kuma Username"                                
        description: "The username to log into Uptime Kuma."         
      UPTIME_KUMA_PASSWORD:                                          
        title: "Uptime Kuma Password"                                
        description: "The password to log into Uptime Kuma."         
    env:                                                             
      UPTIME_KUMA_URL: "{{UPTIME_KUMA_URL}}"                          
      UPTIME_KUMA_USERNAME: "{{UPTIME_KUMA_USERNAME}}"               
      UPTIME_KUMA_PASSWORD: "{{UPTIME_KUMA_PASSWORD}}"               
    serverInstructions: true
    startup: false 
```

If you're the only one using the LibreChat server, you can remove `customUserVars` and set the environment variables directly in the `env` section. You can also remove `startup: false` - that's only in there because without it, LibreChat tries to start the mcp-uptime-kuma MCP server immediately on startup, which fails because the user-provided credentials aren't available yet.

### For the Streamable HTTP Transport

The recommended way to run the MCP server using streamable HTTP is to run it as a Docker container.

A docker-compose file is provided in the Github repository. Grab it, update the included environment variables as needed for your Uptime Kuma deployment, and run:

`docker compose up -d`

The MCP endpoint will be available on your Docker host at port 3000 (configurable via `PORT` environment variable).

If you'd prefer to run it directly on your host machine, see the Development Usage section below.

## Development Usage

To run locally, clone the repository and follow these steps:

### Install dependencies

```bash
npm install
```

### Create the environment configuration

Configure the required environment variables either directly in your environment, or by creating a `.env` file in the project root.

These are the required variables:

```env
UPTIME_KUMA_URL=http://your-uptime-kuma-instance:3001
UPTIME_KUMA_USERNAME=your_username
UPTIME_KUMA_PASSWORD=your_password
PORT=3000  # Optional, only for HTTP transport
```

## Building

Build the TypeScript code to JavaScript:

```bash
npm run build
```

For development with auto-rebuild:

```bash
npm run watch
```

## Running

### Default (stdio Transport)

Run in production mode (requires build first):

```bash
npm start
```

or

```bash
npm run start:stdio
```

This mode is designed to be spawned by MCP clients (like Claude Desktop, VS Code, etc.) that communicate via standard input/output.

### Streamable HTTP Transport (for remote access)

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

You can test the server using the MCP Inspector:

```bash
npm run inspector
```

### For HTTP transport:
Start the HTTP server:
```bash
npm run dev:http
```

Then use the MCP Inspector:
```bash
npx @modelcontextprotocol/inspector
```
Connect to: `http://localhost:3000/mcp`

## Project Structure

```
mcp-uptime-kuma/
├── src/
│   ├── index.ts                # Main entry point with transport selection
│   ├── server.ts               # Core MCP server configuration with tools
│   ├── uptime-kuma-client.ts   # WebSocket client for Uptime Kuma API
│   └── types.ts                # TypeScript type definitions
├── dist/                       # Compiled JavaScript (generated)
├── docker-compose.yml          # Docker Compose configuration
├── Dockerfile                  # Docker image definition
├── package.json                # Project dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── .env                        # Environment configuration (create this)
├── LICENSE                     # License file
└── README.md                   # This file
```

## Development

To add new tools or modify existing ones, edit `src/server.ts`. The Uptime Kuma client in `src/uptime-kuma-client.ts` handles the WebSocket connection and retrieves monitor and heartbeat data.

## Learn More

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
