# Integration Testing for MCP Uptime Kuma

## Overview

This integration test suite verifies that the MCP Uptime Kuma server works correctly with real MCP clients and a real Uptime Kuma instance.

## Test Structure

```
test/integration/
├── docker-compose.test.yml    # Test infrastructure (Uptime Kuma instance)
├── integration.test.ts        # Basic integration tests (read-only)
├── advanced.test.ts           # Advanced tests (pause/resume, filters)
├── run-tests.sh              # Automated test runner
├── .env.test.example         # Template for test configuration
└── README.md                 # Documentation
```

## Quick Start

```bash
# Make test runner executable
chmod +x test/integration/run-tests.sh

# Run all tests
npm run test:integration
```

## What Gets Tested

### Basic Tests (`integration.test.ts`)
- ✅ MCP server connection and authentication
- ✅ Tool discovery (all expected tools present)
- ✅ `getMonitorSummary` - Status overview
- ✅ `listMonitors` - List all monitors
- ✅ `getMonitor` - Get specific monitor
- ✅ `getHeartbeats` - Get heartbeat history
- ✅ `listHeartbeats` - Get heartbeats for all monitors
- ✅ `getSettings` - Get server settings

### Advanced Tests (`advanced.test.ts`)
- ✅ `pauseMonitor` / `resumeMonitor` - State management
- ✅ Filter by monitor type
- ✅ Filter by tags

## Test Infrastructure

The test suite uses Docker Compose to spin up a real Uptime Kuma instance:
- Runs on port 3001 (to avoid conflicts)
- Uses a separate data volume for isolation
- Includes health checks
- Automatically cleaned up after tests

## Configuration

Create `test/integration/.env.test`:
```bash
UPTIME_KUMA_URL=http://localhost:3001
UPTIME_KUMA_USERNAME=admin
UPTIME_KUMA_PASSWORD=your_test_password
```

## Running Tests

### Automated (Recommended)
```bash
npm run test:integration
```

The script will:
1. Start Uptime Kuma test instance
2. Wait for it to be ready
3. Prompt you to set up credentials
4. Run all tests
5. Clean up resources

### Manual
```bash
# Start test infrastructure
cd test/integration
docker-compose -f docker-compose.test.yml up -d

# Set up Uptime Kuma
# 1. Open http://localhost:3001
# 2. Create admin account
# 3. Add monitors (optional, but recommended)

# Set environment variables
export UPTIME_KUMA_URL=http://localhost:3001
export UPTIME_KUMA_USERNAME=admin
export UPTIME_KUMA_PASSWORD=your_password

# Run tests
npx tsx test/integration/integration.test.ts
npx tsx test/integration/advanced.test.ts

# Clean up
docker-compose -f docker-compose.test.yml down
```

## Best Practices

### For Comprehensive Testing
1. **Create monitors** in Uptime Kuma before running tests
   - At least one HTTP monitor
   - Monitors with different types (http, ping, etc.)
   - Monitors with tags
   
2. **Let monitors run** for a few minutes to accumulate heartbeat data

3. **Use a dedicated test instance** - never run against production

### CI/CD Integration
```yaml
# GitHub Actions example
- name: Run Integration Tests
  env:
    UPTIME_KUMA_USERNAME: admin
    UPTIME_KUMA_PASSWORD: ${{ secrets.TEST_PASSWORD }}
  run: |
    chmod +x test/integration/run-tests.sh
    ./test/integration/run-tests.sh
```

## Troubleshooting

### "Connection refused"
- Ensure Docker is running
- Check if Uptime Kuma started: `docker ps | grep uptime-kuma`
- Wait longer for startup (can take 30+ seconds)

### "No monitors found" warnings
- Tests will skip monitor-specific scenarios
- Create monitors in the UI for full test coverage

### Authentication failures
- Verify credentials in `.env.test`
- Check that you've set up the admin account at http://localhost:3001

### Port conflicts
- If port 3001 is in use, modify `docker-compose.test.yml`
- Update `UPTIME_KUMA_URL` in `.env.test` accordingly

## Test Architecture

The tests use the MCP SDK Client to:
1. Spawn the MCP server as a child process
2. Connect via stdio transport (same as production)
3. Call tools and verify responses
4. Check structured responses match expected schemas

This approach ensures tests verify the actual MCP protocol implementation, not just internal functions.

## Future Enhancements

Potential additions:
- [ ] Test monitor creation/modification (would need API support)
- [ ] Test notification settings
- [ ] Test with multiple concurrent clients
- [ ] Performance/load testing
- [ ] Test JWT authentication path
- [ ] Test HTTP transport in addition to stdio
