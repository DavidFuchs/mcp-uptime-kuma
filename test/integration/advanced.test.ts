import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface TestConfig {
  url: string;
  username?: string;
  password?: string;
  jwtToken?: string;
}

/**
 * Advanced integration tests for pause/resume functionality
 * 
 * Warning: These tests will actually pause and resume monitors!
 * Only run against a test instance, not production.
 */
export class AdvancedIntegrationTest {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private config: TestConfig;

  constructor(config: TestConfig) {
    this.config = config;
    this.client = new Client(
      {
        name: 'mcp-uptime-kuma-advanced-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );
  }

  async connect(): Promise<void> {
    const serverPath = new URL('../../src/index.ts', import.meta.url).pathname;
    
    // Build environment, only including defined values
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      UPTIME_KUMA_URL: this.config.url,
      MCP_TEST_MODE: '1', // Prevent loading .env file
    };
    
    // Remove any JWT token from parent environment to avoid conflicts
    delete env.UPTIME_KUMA_JWT_TOKEN;
    
    if (this.config.username) {
      env.UPTIME_KUMA_USERNAME = this.config.username;
    }
    if (this.config.password) {
      env.UPTIME_KUMA_PASSWORD = this.config.password;
    }
    if (this.config.jwtToken) {
      env.UPTIME_KUMA_JWT_TOKEN = this.config.jwtToken;
    }
    
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverPath, '-t', 'stdio'],
      env,
    });

    await this.client.connect(this.transport);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.client.close();
      this.transport = null;
    }
  }

  /**
   * Test: Pause and resume a monitor
   */
  async testPauseResume(): Promise<void> {
    console.log('\n⏸️  Test: Pause and Resume Monitor');
    
    // Get list of active monitors
    const listResult = await this.client.callTool({
      name: 'listMonitors',
      arguments: { active: true },
    }) as CallToolResult;

    const textContent = (listResult.content as any[]).find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in list response');
    }

    const monitors = JSON.parse(textContent.text);
    
    if (monitors.length === 0) {
      console.log('⚠️  Skipping pause/resume test - no active monitors available');
      console.log('   Create at least one active monitor for this test');
      return;
    }

    const monitorID = monitors[0].id;
    const monitorName = monitors[0].name;
    console.log(`Testing with monitor: ${monitorName} (ID: ${monitorID})`);

    // Pause the monitor
    console.log('  → Pausing monitor...');
    const pauseResult = await this.client.callTool({
      name: 'pauseMonitor',
      arguments: { monitorID },
    }) as CallToolResult;

    const pauseContent = pauseResult.content.find((c: any) => c.type === 'text');
    if (!pauseContent || pauseContent.type !== 'text') {
      throw new Error('No text content in pause response');
    }
    console.log(`  ✓ ${pauseContent.text}`);

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify monitor is paused
    console.log('  → Verifying monitor is paused...');
    const verifyPausedResult = await this.client.callTool({
      name: 'getMonitor',
      arguments: { monitorID },
    }) as CallToolResult;

    const verifyContent = verifyPausedResult.content.find((c: any) => c.type === 'text');
    if (!verifyContent || verifyContent.type !== 'text') {
      throw new Error('No text content in verify response');
    }

    const pausedMonitor = JSON.parse(verifyContent.text);
    if (pausedMonitor.active !== false) {
      throw new Error('Monitor was not paused successfully!');
    }
    console.log('  ✓ Monitor is paused (active=false)');

    // Resume the monitor
    console.log('  → Resuming monitor...');
    const resumeResult = await this.client.callTool({
      name: 'resumeMonitor',
      arguments: { monitorID },
    }) as CallToolResult;

    const resumeContent = resumeResult.content.find((c: any) => c.type === 'text');
    if (!resumeContent || resumeContent.type !== 'text') {
      throw new Error('No text content in resume response');
    }
    console.log(`  ✓ ${resumeContent.text}`);

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify monitor is resumed
    console.log('  → Verifying monitor is resumed...');
    const verifyResumedResult = await this.client.callTool({
      name: 'getMonitor',
      arguments: { monitorID },
    }) as CallToolResult;

    const verifyResumedContent = verifyResumedResult.content.find((c: any) => c.type === 'text');
    if (!verifyResumedContent || verifyResumedContent.type !== 'text') {
      throw new Error('No text content in verify response');
    }

    const resumedMonitor = JSON.parse(verifyResumedContent.text);
    if (resumedMonitor.active !== true) {
      throw new Error('Monitor was not resumed successfully!');
    }
    console.log('  ✓ Monitor is resumed (active=true)');

    console.log('✅ Pause/Resume test passed');
  }

  /**
   * Test: Filter monitors by type
   */
  async testFilterByType(): Promise<void> {
    console.log('\n🔍 Test: Filter Monitors by Type');
    
    // Get all monitors
    const allResult = await this.client.callTool({
      name: 'listMonitors',
      arguments: {},
    }) as CallToolResult;

    const allContent = allResult.content.find((c: any) => c.type === 'text');
    if (!allContent || allContent.type !== 'text') {
      throw new Error('No text content');
    }

    const allMonitors = JSON.parse(allContent.text);
    
    if (allMonitors.length === 0) {
      console.log('⚠️  Skipping filter test - no monitors available');
      return;
    }

    // Get unique types
    const types = [...new Set(allMonitors.map((m: any) => m.type))];
    console.log(`Found monitor types: ${types.join(', ')}`);

    // Test filtering by first type
    if (types.length > 0) {
      const testType = types[0];
      console.log(`  → Filtering by type: ${testType}`);
      
      const filteredResult = await this.client.callTool({
        name: 'listMonitors',
        arguments: { type: testType },
      }) as CallToolResult;

      const filteredContent = filteredResult.content.find((c: any) => c.type === 'text');
      if (!filteredContent || filteredContent.type !== 'text') {
        throw new Error('No text content');
      }

      const filteredMonitors = JSON.parse(filteredContent.text);
      console.log(`  ✓ Found ${filteredMonitors.length} monitors of type ${testType}`);

      // Verify all returned monitors are of the correct type
      const wrongTypes = filteredMonitors.filter((m: any) => m.type !== testType);
      if (wrongTypes.length > 0) {
        throw new Error(`Filter returned monitors of wrong type: ${wrongTypes.map((m: any) => m.type).join(', ')}`);
      }
    }

    console.log('✅ Filter by type test passed');
  }

  /**
   * Test: Filter monitors by tags
   */
  async testFilterByTags(): Promise<void> {
    console.log('\n🏷️  Test: Filter Monitors by Tags');
    
    // Get all monitors
    const allResult = await this.client.callTool({
      name: 'listMonitors',
      arguments: {},
    }) as CallToolResult;

    const allContent = allResult.content.find((c: any) => c.type === 'text');
    if (!allContent || allContent.type !== 'text') {
      throw new Error('No text content');
    }

    const allMonitors = JSON.parse(allContent.text);
    
    // Find monitors with tags
    const monitorsWithTags = allMonitors.filter((m: any) => m.tags && m.tags.length > 0);
    
    if (monitorsWithTags.length === 0) {
      console.log('⚠️  Skipping tag filter test - no monitors with tags');
      console.log('   Add tags to monitors in Uptime Kuma for this test');
      return;
    }

    const firstTag = monitorsWithTags[0].tags[0];
    const tagFilter = firstTag.value ? `${firstTag.name}=${firstTag.value}` : firstTag.name;
    console.log(`  → Filtering by tag: ${tagFilter}`);

    const filteredResult = await this.client.callTool({
      name: 'listMonitors',
      arguments: { tags: tagFilter },
    }) as CallToolResult;

    const filteredContent = filteredResult.content.find((c: any) => c.type === 'text');
    if (!filteredContent || filteredContent.type !== 'text') {
      throw new Error('No text content');
    }

    const filteredMonitors = JSON.parse(filteredContent.text);
    console.log(`  ✓ Found ${filteredMonitors.length} monitors with tag ${tagFilter}`);

    console.log('✅ Filter by tags test passed');
  }

  async runAllTests(): Promise<void> {
    console.log('🧪 Starting Advanced MCP Uptime Kuma Integration Tests\n');
    console.log('⚠️  WARNING: These tests will modify monitor states!');
    console.log('   Only run against a test instance.\n');

    const tests = [
      this.testPauseResume,
      this.testFilterByType,
      this.testFilterByTags,
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
      try {
        await test.call(this);
        passed++;
      } catch (error) {
        failed++;
        console.error(`❌ Test failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    if (failed > 0) {
      throw new Error(`${failed} test(s) failed`);
    }
  }
}

// Main execution
async function main() {
  const config: TestConfig = {
    url: process.env.UPTIME_KUMA_URL || 'http://localhost:3001',
    username: process.env.UPTIME_KUMA_USERNAME,
    password: process.env.UPTIME_KUMA_PASSWORD,
    jwtToken: process.env.UPTIME_KUMA_JWT_TOKEN,
  };

  if (!config.username && !config.jwtToken) {
    console.error('❌ Error: UPTIME_KUMA_USERNAME or UPTIME_KUMA_JWT_TOKEN must be set');
    process.exit(1);
  }

  if (config.username && !config.password) {
    console.error('❌ Error: UPTIME_KUMA_PASSWORD must be set when using username authentication');
    process.exit(1);
  }

  const test = new AdvancedIntegrationTest(config);

  try {
    await test.connect();
    await test.runAllTests();
    console.log('\n✅ All advanced tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  } finally {
    await test.disconnect();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
