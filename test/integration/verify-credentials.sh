#!/bin/bash

# Checks that the credentials in .env.test can log in to the test Uptime Kuma instance,
# without running any tests. On a fresh instance (no admin account yet) it creates the
# account from .env.test, the same as the test runner does.

set -e

cd "$(dirname "$0")"

if [ ! -f ".env.test" ]; then
    echo "Error: .env.test file not found"
    exit 1
fi

cd ../..
npx tsx test/integration/ensure-admin.ts
