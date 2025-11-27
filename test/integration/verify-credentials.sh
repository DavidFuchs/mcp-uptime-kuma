#!/bin/bash

# Quick test to verify Uptime Kuma credentials work

set -e

if [ ! -f ".env.test" ]; then
    echo "Error: .env.test file not found"
    exit 1
fi

source .env.test

echo "Testing connection to Uptime Kuma..."
echo "URL: $UPTIME_KUMA_URL"
echo "Username: $UPTIME_KUMA_USERNAME"
echo ""

# Quick test by trying to connect
cd ../..

# Make sure project is built
if [ ! -d "dist" ]; then
    echo "Building project..."
    npm run build
fi

node --input-type=module -e "
import { UptimeKumaClient } from './dist/uptime-kuma-client.js';

async function test() {
  const client = new UptimeKumaClient('$UPTIME_KUMA_URL');
  try {
    await client.connect();
    console.log('✅ Connected to Uptime Kuma');
    
    await client.login('$UPTIME_KUMA_USERNAME', '$UPTIME_KUMA_PASSWORD');
    console.log('✅ Authentication successful!');
    
    const settings = await client.getSettings();
    console.log('✅ Got settings - Primary URL:', settings.data.primaryBaseURL || 'not set');
    
    client.disconnect();
    console.log('');
    console.log('✅ Credentials are valid! You can now run the integration tests.');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('');
    console.log('Please check:');
    console.log('1. Uptime Kuma is running at $UPTIME_KUMA_URL');
    console.log('2. You have set up an admin account in the web UI');
    console.log('3. The credentials in .env.test match your admin account');
    process.exit(1);
  }
}

test();
"
