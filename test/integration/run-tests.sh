#!/bin/bash

set -e

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

# Check if .env file exists
if [ ! -f ".env.test" ]; then
    echo -e "${YELLOW}⚠️  Warning: .env.test file not found${NC}"
    echo "Creating template .env.test file..."
    cat > .env.test << 'EOF'
# Uptime Kuma test instance configuration
UPTIME_KUMA_URL=http://localhost:3001
UPTIME_KUMA_USERNAME=admin
UPTIME_KUMA_PASSWORD=your_password_here
# UPTIME_KUMA_JWT_TOKEN=your_jwt_token_here
EOF
    echo ""
    echo -e "${YELLOW}Please edit .env.test with your test credentials and run again${NC}"
    exit 1
fi

# Load environment variables
source .env.test

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
docker-compose -f docker-compose.test.yml up -d

# Wait for Uptime Kuma to be ready
if ! wait_for_uptime_kuma; then
    echo -e "${RED}❌ Failed to start test infrastructure${NC}"
    docker-compose -f docker-compose.test.yml logs
    exit 1
fi

echo ""
echo "📝 Setup Instructions:"
echo "   =============================================="
echo "   IMPORTANT: Set up Uptime Kuma BEFORE running tests!"
echo "   =============================================="
echo ""
echo "   1. Open http://localhost:3001 in your browser"
echo "   2. Create admin account (first-time setup)"
echo "   3. Update .env.test with your credentials:"
echo "      UPTIME_KUMA_USERNAME=<your_username>"
echo "      UPTIME_KUMA_PASSWORD=<your_password>"
echo "   4. (Optional) Create monitors for better test coverage"
echo ""
echo "   Current .env.test configuration:"
echo "   --------------------------------"
cat .env.test | grep -v "^#"
echo "   --------------------------------"
echo ""
echo "   5. Press Enter to continue with tests..."
echo ""
read -r

echo ""
echo "🧪 Running integration tests..."
echo ""

# Export environment variables for the test
export UPTIME_KUMA_URL
export UPTIME_KUMA_USERNAME
export UPTIME_KUMA_PASSWORD
export UPTIME_KUMA_JWT_TOKEN

# Run the tests
cd ../..
npx tsx test/integration/integration.test.ts

TEST_EXIT_CODE=$?

cd test/integration

# Cleanup
echo ""
echo "🧹 Cleaning up..."
docker-compose -f docker-compose.test.yml down

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Tests failed${NC}"
    exit $TEST_EXIT_CODE
fi
