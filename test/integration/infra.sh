#!/bin/bash
# Shared Docker test infrastructure for the integration and LLM eval runners.
#
# Source this file, then:
#   trap infra_down EXIT INT TERM
#   infra_up || exit 1
#
# Sourcing registers no traps and changes no directories.

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_REPO_ROOT="$(cd "$INFRA_DIR/../.." && pwd)"

# Compose v2 ships as a docker plugin ("docker compose"); fall back to the standalone binary.
if docker compose version > /dev/null 2>&1; then
    COMPOSE=(docker compose)
else
    COMPOSE=(docker-compose)
fi

INFRA_RED='\033[0;31m'
INFRA_GREEN='\033[0;32m'
INFRA_NC='\033[0m'

infra_down() {
    echo ""
    echo "🧹 Cleaning up..."
    "${COMPOSE[@]}" -f "$INFRA_DIR/docker-compose.test.yml" down --remove-orphans 2>/dev/null || true
}

# Function to check if Uptime Kuma is ready
infra_wait_for_uptime_kuma() {
    echo "⏳ Waiting for Uptime Kuma to be ready..."
    local max_attempts=30
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -q "200\|302"; then
            echo -e "${INFRA_GREEN}✅ Uptime Kuma is ready${INFRA_NC}"
            return 0
        fi
        echo "   Attempt $attempt/$max_attempts - waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done

    echo -e "${INFRA_RED}❌ Uptime Kuma failed to start within timeout${INFRA_NC}"
    return 1
}

# Make sure the credentials in .env.test can log in. On a fresh instance this creates the
# admin account from them, so no manual setup is needed.
infra_ensure_admin() {
    (cd "$INFRA_REPO_ROOT" && npx tsx test/integration/ensure-admin.ts)
}

infra_up() {
    # Check if docker is running
    if ! docker info > /dev/null 2>&1; then
        echo -e "${INFRA_RED}❌ Error: Docker is not running${INFRA_NC}"
        return 1
    fi

    # A clean checkout has no .env.test. The template's credentials are valid for a fresh test
    # instance, so copy it and carry on.
    if [ ! -f "$INFRA_DIR/.env.test" ]; then
        echo "📄 No .env.test found, creating it from .env.test.example"
        cp "$INFRA_DIR/.env.test.example" "$INFRA_DIR/.env.test"
    fi

    # Start test infrastructure
    echo "🐳 Starting test infrastructure..."
    "${COMPOSE[@]}" -f "$INFRA_DIR/docker-compose.test.yml" up -d || return 1

    # Wait for Uptime Kuma to be ready
    if ! infra_wait_for_uptime_kuma; then
        echo -e "${INFRA_RED}❌ Failed to start test infrastructure${INFRA_NC}"
        "${COMPOSE[@]}" -f "$INFRA_DIR/docker-compose.test.yml" logs
        return 1
    fi

    echo ""
    echo "🔑 Checking the admin account..."
    if ! infra_ensure_admin; then
        echo ""
        echo "   The credentials in test/integration/.env.test could not be used (reason above)."
        echo "   Either fix that file, or start from a clean instance and let the runner create"
        echo "   the admin account from it:"
        echo "     ${COMPOSE[*]} -f test/integration/docker-compose.test.yml down -v"
        echo ""
        # Only wait for a fix when someone is there to make it.
        if [ ! -t 0 ]; then
            return 1
        fi
        echo "   Fix .env.test, then press Enter to try again (Ctrl+C to stop)..."
        read -r
        if ! infra_ensure_admin; then
            return 1
        fi
    fi
    return 0
}
