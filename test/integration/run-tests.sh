#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra.sh
source "$SCRIPT_DIR/infra.sh"

# Ensure containers are torn down on exit (success, failure, or interrupt)
trap infra_down EXIT
# Exit on Ctrl+C rather than carrying on (e.g. polling for readiness); EXIT then tears down once.
trap 'exit 130' INT TERM

echo "🧪 MCP Uptime Kuma Integration Test Runner"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

if ! infra_up; then
    exit 1
fi

echo ""
echo "🧪 Running integration tests..."
echo ""

# Run the tests (environment loaded from .env.test by the test file itself)
cd "$INFRA_REPO_ROOT"
set +e
npx tsx test/integration/run-all.ts "$@"
TEST_EXIT_CODE=$?
set -e

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Tests failed${NC}"
    exit $TEST_EXIT_CODE
fi
