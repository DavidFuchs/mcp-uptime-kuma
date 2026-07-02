import {
  createTestClient,
  loadTestConfig,
  validateTestConfig,
  runTestSuite,
  TestContext,
} from './helpers.js';
import { settingsTests } from './settings.test.js';
import { monitorTests } from './monitors.test.js';
import { heartbeatTests } from './heartbeats.test.js';
import { tagTests } from './tags.test.js';
import { maintenanceTests } from './maintenance.test.js';
import { notificationTests } from './notifications.test.js';
import { dockerHostTests } from './docker-hosts.test.js';
import { statusPageTests } from './status-pages.test.js';

/**
 * Unified integration test runner.
 *
 * Runs all domain test suites against a live Uptime Kuma instance.
 * Requires .env.test to be configured with connection credentials.
 *
 * Usage:
 *   npx tsx test/integration/run-all.ts
 *   npx tsx test/integration/run-all.ts --suite monitors
 *   npx tsx test/integration/run-all.ts --suite tags --suite maintenance
 */

const ALL_SUITES: Record<string, { name: string; tests: Array<{ name: string; fn: any }> }> = {
  settings: { name: 'Settings & Discovery', tests: settingsTests },
  monitors: { name: 'Monitors', tests: monitorTests },
  heartbeats: { name: 'Heartbeats', tests: heartbeatTests },
  tags: { name: 'Tags', tests: tagTests },
  maintenance: { name: 'Maintenance', tests: maintenanceTests },
  notifications: { name: 'Notifications', tests: notificationTests },
  'docker-hosts': { name: 'Docker Hosts', tests: dockerHostTests },
  'status-pages': { name: 'Status Pages', tests: statusPageTests },
};

async function main() {
  const config = loadTestConfig();
  validateTestConfig(config);

  // Parse --suite arguments for selective runs
  const args = process.argv.slice(2);
  const selectedSuites: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite' && args[i + 1]) {
      selectedSuites.push(args[++i]);
    }
  }

  const suitesToRun = selectedSuites.length > 0
    ? selectedSuites.filter(s => ALL_SUITES[s])
    : Object.keys(ALL_SUITES);

  if (selectedSuites.length > 0) {
    const invalid = selectedSuites.filter(s => !ALL_SUITES[s]);
    if (invalid.length > 0) {
      console.error(`❌ Unknown suites: ${invalid.join(', ')}`);
      console.error(`   Available: ${Object.keys(ALL_SUITES).join(', ')}`);
      process.exit(1);
    }
  }

  console.log('🧪 MCP Uptime Kuma Integration Tests');
  console.log('='.repeat(60));
  console.log(`Server: ${config.url}`);
  console.log(`Auth: ${config.jwtToken ? 'JWT' : config.username ? 'username/password' : 'none'}`);
  console.log(`Suites: ${suitesToRun.join(', ')}`);
  console.log('='.repeat(60));

  // Connect
  console.log('\n🚀 Connecting to MCP server...');
  const { client, transport } = await createTestClient(config);
  console.log('✅ Connected and authenticated\n');

  const ctx: TestContext = { client, config };

  let totalPassed = 0;
  let totalFailed = 0;

  try {
    for (const suiteKey of suitesToRun) {
      const suite = ALL_SUITES[suiteKey];
      const { passed, failed } = await runTestSuite(suite.name, suite.tests, ctx);
      totalPassed += passed;
      totalFailed += failed;
    }
  } finally {
    await client.close();
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log(`📊 TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  console.log('='.repeat(60));

  if (totalFailed > 0) {
    console.error(`\n❌ ${totalFailed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
