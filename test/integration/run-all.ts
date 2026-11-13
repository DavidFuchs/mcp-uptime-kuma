import {
  createTestClient,
  loadTestConfig,
  validateTestConfig,
  runTestSuite,
  type TestContext,
} from './helpers.js';
import { settingsTests } from './settings.test.js';
import { monitorTests } from './monitors.test.js';
import { heartbeatTests } from './heartbeats.test.js';
import { tagTests } from './tags.test.js';
import { maintenanceTests } from './maintenance.test.js';
import { notificationTests } from './notifications.test.js';
import { dockerHostTests } from './docker-hosts.test.js';
import { statusPageTests } from './status-pages.test.js';
import { strictSchemaTests } from './strict-schema.test.js';
import { redactionTests } from './redaction.test.js';
import { monitorTypeFieldTests } from './monitor-type-fields.test.js';
import { startupTests } from './startup.test.js';
import { monitorHistoryTests } from './monitor-history.long.test.js';

/**
 * Unified integration test runner.
 *
 * Runs all domain test suites against a live Uptime Kuma instance.
 * Requires .env.test to be configured with connection credentials.
 *
 * The short suites run by default. The long suites wait for Uptime Kuma to run real checks,
 * so they only run when asked for, after the short ones.
 *
 * Usage:
 *   npx tsx test/integration/run-all.ts                  (short suites)
 *   npx tsx test/integration/run-all.ts --long           (short suites, then long suites)
 *   npx tsx test/integration/run-all.ts --suite monitors
 *   npx tsx test/integration/run-all.ts --suite tags --suite monitor-history
 */

type Suite = { name: string; tests: Array<{ name: string; fn: any }> };

const SHORT_SUITES: Record<string, Suite> = {
  settings: { name: 'Settings & Discovery', tests: settingsTests },
  monitors: { name: 'Monitors', tests: monitorTests },
  heartbeats: { name: 'Heartbeats', tests: heartbeatTests },
  tags: { name: 'Tags', tests: tagTests },
  maintenance: { name: 'Maintenance', tests: maintenanceTests },
  notifications: { name: 'Notifications', tests: notificationTests },
  'docker-hosts': { name: 'Docker Hosts', tests: dockerHostTests },
  'status-pages': { name: 'Status Pages', tests: statusPageTests },
  'strict-schema': { name: 'Strict Input Schemas', tests: strictSchemaTests },
  redaction: { name: 'Credential Redaction', tests: redactionTests },
  'monitor-type-fields': { name: 'Type-specific Monitor Fields', tests: monitorTypeFieldTests },
  startup: { name: 'Fresh Server Startup', tests: startupTests },
};

const LONG_SUITES: Record<string, Suite> = {
  'monitor-history': { name: 'Monitor History (long)', tests: monitorHistoryTests },
};

const ALL_SUITES: Record<string, Suite> = { ...SHORT_SUITES, ...LONG_SUITES };

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

  const defaultSuites = args.includes('--long') ? ALL_SUITES : SHORT_SUITES;
  const suitesToRun = selectedSuites.length > 0
    ? selectedSuites.filter(s => ALL_SUITES[s])
    : Object.keys(defaultSuites);

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
  const { client } = await createTestClient(config);
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
