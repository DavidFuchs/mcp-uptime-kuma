#!/bin/bash

set -e

# Ensure containers are torn down on exit (success, failure, or interrupt)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Compose v2 ships as a docker plugin ("docker compose"); fall back to the standalone binary.
if docker compose version > /dev/null 2>&1; then
    COMPOSE=(docker compose)
else
    COMPOSE=(docker-compose)
fi

cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    "${COMPOSE[@]}" -f "$SCRIPT_DIR/docker-compose.test.yml" down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "🧪 MCP Uptime Kuma Integration Test Runner"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Docker is not running${NC}"
    exit 1
fi

# Navigate to test directory
cd "$(dirname "$0")"

# A clean checkout has no .env.test. The template's credentials are valid for a fresh test
# instance, so copy it and carry on.
if [ ! -f ".env.test" ]; then
    echo "📄 No .env.test found, creating it from .env.test.example"
    cp .env.test.example .env.test
fi

# Function to check if Uptime Kuma is ready
wait_for_uptime_kuma() {
    echo "⏳ Waiting for Uptime Kuma to be ready..."
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -q "200\|302"; then
            echo -e "${GREEN}✅ Uptime Kuma is ready${NC}"
            return 0
        fi
        echo "   Attempt $attempt/$max_attempts - waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}❌ Uptime Kuma failed to start within timeout${NC}"
    return 1
}

# Start test infrastructure
echo "🐳 Starting test infrastructure..."
"${COMPOSE[@]}" -f docker-compose.test.yml up -d

# Wait for Uptime Kuma to be ready
if ! wait_for_uptime_kuma; then
    echo -e "${RED}❌ Failed to start test infrastructure${NC}"
    "${COMPOSE[@]}" -f docker-compose.test.yml logs
    exit 1
fi

# Make sure the credentials in .env.test can log in. On a fresh instance this creates the
# admin account from them, so no manual setup is needed.
ensure_admin() {
    (cd ../.. && npx tsx test/integration/ensure-admin.ts)
}

echo ""
echo "🔑 Checking the admin account..."
if ! ensure_admin; then
    echo ""
    echo "   The credentials in test/integration/.env.test could not be used (reason above)."
    echo "   Either fix that file, or start from a clean instance and let the runner create"
    echo "   the admin account from it:"
    echo "     ${COMPOSE[*]} -f test/integration/docker-compose.test.yml down -v"
    echo ""
    # Only wait for a fix when someone is there to make it.
    if [ ! -t 0 ]; then
        exit 1
    fi
    echo "   Fix .env.test, then press Enter to try again (Ctrl+C to stop)..."
    read -r
    if ! ensure_admin; then
        exit 1
    fi
fi

echo ""
echo "🧪 Running integration tests..."
echo ""

# Run the tests (environment loaded from .env.test by the test file itself)
cd ../..
set +e
npx tsx test/integration/run-all.ts "$@"
TEST_EXIT_CODE=$?
set -e

cd test/integration

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Tests failed${NC}"
    exit $TEST_EXIT_CODE
fi
