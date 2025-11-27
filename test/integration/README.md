# Integration Testing

This directory contains integration tests for the MCP Uptime Kuma server.

## Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ installed
- Project dependencies installed (`npm install`)

## Quick Start

1. Make the test runner executable:
   ```bash
   chmod +x test/integration/run-tests.sh
   ```

2. Run the test suite:
   ```bash
   ./test/integration/run-tests.sh
   ```

   On first run, this will:
   - Create a `.env.test` template file
   - Ask you to configure your test credentials

3. Edit `.env.test` with your test credentials:
   ```bash
   UPTIME_KUMA_URL=http://localhost:3001
   UPTIME_KUMA_USERNAME=admin
   UPTIME_KUMA_PASSWORD=your_password_here
   ```

4. Run the tests again:
   ```bash
   ./test/integration/run-tests.sh
   ```

## What Gets Tested

The integration tests verify:

1. **Connection & Authentication** - Server can connect to Uptime Kuma and authenticate
2. **Tool Discovery** - All expected tools are available
3. **getMonitorSummary** - Can retrieve status overview of all monitors
4. **listMonitors** - Can list all monitors with configuration details
5. **getMonitor** - Can retrieve specific monitor by ID
6. **getHeartbeats** - Can retrieve historical heartbeat data for a monitor
7. **listHeartbeats** - Can retrieve heartbeats for all monitors
8. **getSettings** - Can retrieve Uptime Kuma server settings

## Manual Testing

You can also run tests manually:

1. Start the test Uptime Kuma instance:
   ```bash
   cd test/integration
   docker-compose -f docker-compose.test.yml up -d
   ```

2. Set up Uptime Kuma:
   - Open http://localhost:3001
   - Create admin account
   - Add some monitors

3. Set environment variables:
   ```bash
   export UPTIME_KUMA_URL=http://localhost:3001
   export UPTIME_KUMA_USERNAME=admin
   export UPTIME_KUMA_PASSWORD=your_password
   ```

4. Run the test:
   ```bash
   npx tsx test/integration/integration.test.ts
   ```

5. Clean up:
   ```bash
   docker-compose -f docker-compose.test.yml down
   ```

## Test Configuration

The test suite uses environment variables for configuration:

- `UPTIME_KUMA_URL` - URL of the test Uptime Kuma instance (default: http://localhost:3001)
- `UPTIME_KUMA_USERNAME` - Username for authentication
- `UPTIME_KUMA_PASSWORD` - Password for authentication
- `UPTIME_KUMA_JWT_TOKEN` - JWT token (alternative to username/password)

### Authentication failures ("authInvalidToken")
- Verify credentials in `.env.test` match your Uptime Kuma admin account
- Check that you've set up the admin account at http://localhost:3001
- Note: Tests run with `MCP_TEST_MODE=1` which prevents loading the root `.env` file

### Port conflicts

### "No monitors found" warnings
- The tests will run but skip monitor-specific tests
- For comprehensive testing, create at least one monitor in Uptime Kuma UI

### Docker-related issues
- Ensure Docker daemon is running
- Check Docker logs: `docker-compose -f test/integration/docker-compose.test.yml logs`

## CI/CD Integration

To integrate these tests into your CI/CD pipeline:

1. Ensure Docker is available in your CI environment
2. Set the required environment variables
3. Run: `./test/integration/run-tests.sh`

Example GitHub Actions:
```yaml
- name: Run Integration Tests
  env:
    UPTIME_KUMA_USERNAME: admin
    UPTIME_KUMA_PASSWORD: ${{ secrets.TEST_PASSWORD }}
  run: |
    chmod +x test/integration/run-tests.sh
    ./test/integration/run-tests.sh
```
