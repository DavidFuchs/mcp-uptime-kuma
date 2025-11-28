import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as dotenvConfig } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.test file from the integration test directory
dotenvConfig({ path: join(__dirname, '.env.test') });

interface TestConfig {
  url: string;
  username?: string;
  password?: string;
  jwtToken?: string;
}

/**
 * Integration test suite for MCP Uptime Kuma server
 * 
 * Prerequisites:
 * 1. Start test Uptime Kuma instance: docker-compose -f test/integration/docker-compose.test.yml up -d
 * 2. Set up Uptime Kuma at http://localhost:3001 with username/password
 * 3. Create at least one monitor for testing
 * 4. Set environment variables: UPTIME_KUMA_URL, UPTIME_KUMA_USERNAME, UPTIME_KUMA_PASSWORD
 */
export class MCPIntegrationTest {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private config: TestConfig;

  constructor(config: TestConfig) {
    this.config = config;
    this.client = new Client(
      {
        name: 'mcp-uptime-kuma-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );
  }

  /**
   * Start the MCP server as a child process and connect via stdio
   */
  async connect(): Promise<void> {
    console.log('🚀 Starting MCP server...');
    
    const serverPath = join(__dirname, '../../src/index.ts');
    
    // Build environment, only including defined values
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      UPTIME_KUMA_URL: this.config.url,
      MCP_TEST_MODE: '1', // Prevent loading the root .env file
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
    
    // Create stdio transport - this will spawn the process
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', serverPath, '-t', 'stdio'],
      env,
    });

    // Connect the client
    try {
      await this.client.connect(this.transport);
      console.log('✅ Connected to MCP server');

      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Verify connection by listing tools
      await this.client.listTools();
      console.log('✅ Server authenticated and ready');
    } catch (error) {
      throw new Error('Failed to connect to MCP server. Check credentials and server availability.');
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.client.close();
      this.transport = null;
    }
    
    console.log('👋 Disconnected from MCP server');
  }

  /**
   * Test: List all available tools
   */
  async testListTools(): Promise<void> {
    console.log('\n📋 Test: List Tools');
    
    const tools = await this.client.listTools();
    console.log(`Found ${tools.tools.length} tools:`);
    tools.tools.forEach(tool => {
      console.log(`  - ${tool.name}: ${tool.description}`);
    });

    if (tools.tools.length === 0) {
      throw new Error('No tools found!');
    }

    // Verify expected tools exist
    const expectedTools = [
      'getMonitor',
      'listMonitors',
      'getMonitorSummary',
      'getHeartbeats',
      'getSettings',
      'listHeartbeats',
      'pauseMonitor',
      'resumeMonitor',
    ];

    for (const expectedTool of expectedTools) {
      const found = tools.tools.find(t => t.name === expectedTool);
      if (!found) {
        throw new Error(`Expected tool '${expectedTool}' not found!`);
      }
    }

    console.log('✅ All expected tools found');
  }

  /**
   * Test: Get monitor summary
   */
  async testGetMonitorSummary(): Promise<void> {
    console.log('\n📊 Test: Get Monitor Summary');
    
    const result = await this.client.callTool({
      name: 'getMonitorSummary',
      arguments: {},
    }) as CallToolResult;

    console.log('Result:', JSON.stringify(result, null, 2));

    if (!result.content || result.content.length === 0) {
      throw new Error('No content returned from getMonitorSummary');
    }

    const textContent = result.content.find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    if (result.isError) {
      throw new Error(`MCP error: ${textContent.text}`);
    }

    const summaries = JSON.parse(textContent.text);
    console.log(`Found ${summaries.length} monitors`);

    if (summaries.length === 0) {
      console.warn('⚠️  No monitors found. Create at least one monitor in Uptime Kuma for better testing.');
    } else {
      console.log('Monitor summaries:', summaries.map((s: any) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        status: s.status,
      })));
    }

    console.log('✅ getMonitorSummary works');
  }

  /**
   * Test: List monitors with filters
   */
  async testListMonitors(): Promise<void> {
    console.log('\n📝 Test: List Monitors');
    
    const result = await this.client.callTool({
      name: 'listMonitors',
      arguments: {},
    }) as CallToolResult;

    if (!result.content || result.content.length === 0) {
      throw new Error('No content returned from listMonitors');
    }

    const textContent = result.content.find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    if (result.isError) {
      throw new Error(`MCP error: ${textContent.text}`);
    }

    const monitors = JSON.parse(textContent.text);
    console.log(`Found ${monitors.length} monitors`);

    if (monitors.length > 0) {
      console.log('First monitor:', {
        id: monitors[0].id,
        name: monitors[0].name,
        type: monitors[0].type,
        url: monitors[0].url,
      });
    }

    console.log('✅ listMonitors works');
  }

  /**
   * Test: Get specific monitor
   */
  async testGetMonitor(): Promise<void> {
    console.log('\n🔍 Test: Get Monitor');
    
    // First, get list of monitors to find an ID
    const listResult = await this.client.callTool({
      name: 'listMonitors',
      arguments: {},
    }) as CallToolResult;

    const textContent = (listResult.content as any[]).find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in list response');
    }

    if (listResult.isError) {
      throw new Error(`MCP error: ${textContent.text}`);
    }

    const monitors = JSON.parse(textContent.text);
    
    if (monitors.length === 0) {
      console.log('⚠️  Skipping getMonitor test - no monitors available');
      return;
    }

    const monitorID = monitors[0].id;
    console.log(`Testing with monitor ID: ${monitorID}`);

    const result = await this.client.callTool({
      name: 'getMonitor',
      arguments: { monitorID },
    }) as CallToolResult;

    if (!result.content || result.content.length === 0) {
      throw new Error('No content returned from getMonitor');
    }

    const monitorContent = result.content.find((c: any) => c.type === 'text');
    if (!monitorContent || monitorContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    if (result.isError) {
      throw new Error(`MCP error: ${monitorContent.text}`);
    }

    const monitor = JSON.parse(monitorContent.text);
    console.log('Monitor details:', {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
    });

    console.log('✅ getMonitor works');
  }

  /**
   * Test: Get heartbeats
   */
  async testGetHeartbeats(): Promise<void> {
    console.log('\n💓 Test: Get Heartbeats');
    
    // First, get list of monitors to find an ID
    const listResult = await this.client.callTool({
      name: 'listMonitors',
      arguments: {},
    }) as CallToolResult;

    const textContent = (listResult.content as any[]).find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in list response');
    }

    if (listResult.isError) {
      throw new Error(`MCP error: ${textContent.text}`);
    }

    const monitors = JSON.parse(textContent.text);
    
    if (monitors.length === 0) {
      console.log('⚠️  Skipping getHeartbeats test - no monitors available');
      return;
    }

    const monitorID = monitors[0].id;
    console.log(`Testing with monitor ID: ${monitorID}, requesting 5 heartbeats`);

    const result = await this.client.callTool({
      name: 'getHeartbeats',
      arguments: { 
        monitorID,
        maxHeartbeats: 5,
      },
    }) as CallToolResult;

    if (!result.content || result.content.length === 0) {
      throw new Error('No content returned from getHeartbeats');
    }

    const heartbeatContent = result.content.find((c: any) => c.type === 'text');
    if (!heartbeatContent || heartbeatContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    if (result.isError) {
      throw new Error(`MCP error: ${heartbeatContent.text}`);
    }

    const heartbeats = JSON.parse(heartbeatContent.text);
    console.log(`Retrieved ${heartbeats.length} heartbeats`);

    if (heartbeats.length > 0) {
      console.log('Latest heartbeat:', {
        time: heartbeats[0].time,
        status: heartbeats[0].status,
        ping: heartbeats[0].ping,
      });
    }

    console.log('✅ getHeartbeats works');
  }

  /**
   * Test: Get settings
   */
  async testGetSettings(): Promise<void> {
    console.log('\n⚙️  Test: Get Settings');
    
    const result = await this.client.callTool({
      name: 'getSettings',
      arguments: {},
    }) as CallToolResult;

    if (!result.content || result.content.length === 0) {
      throw new Error('No content returned from getSettings');
    }

    const textContent = result.content.find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    if (result.isError) {
      throw new Error(`MCP error: ${textContent.text}`);
    }

    let settings;
    try {
      settings = JSON.parse(textContent.text);
    } catch (error) {
      console.error('Failed to parse settings response:', textContent.text);
      throw new Error(`Invalid JSON response: ${textContent.text.substring(0, 100)}`);
    }
    
    console.log('Settings retrieved:', {
      checkUpdate: settings.checkUpdate,
      primaryBaseURL: settings.primaryBaseURL,
      serverTimezone: settings.serverTimezone,
    });

    console.log('✅ getSettings works');
  }

  /**
   * Test: List heartbeats for all monitors
   */
  async testListHeartbeats(): Promise<void> {
    console.log('\n💓 Test: List Heartbeats (All Monitors)');
    
    const result = await this.client.callTool({
      name: 'listHeartbeats',
      arguments: {
        maxHeartbeats: 3,
      },
    }) as CallToolResult;

    if (!result.content || result.content.length === 0) {
      throw new Error('No content returned from listHeartbeats');
    }

    const textContent = result.content.find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    if (result.isError) {
      throw new Error(`MCP error: ${textContent.text}`);
    }

    const heartbeatData = JSON.parse(textContent.text);
    const monitorCount = Object.keys(heartbeatData).length;
    console.log(`Retrieved heartbeats for ${monitorCount} monitors`);

    console.log('✅ listHeartbeats works');
  }

  /**
   * Run all tests
   */
  async runAllTests(): Promise<void> {
    console.log('🧪 Starting MCP Uptime Kuma Integration Tests\n');
    console.log('Configuration:', {
      url: this.config.url,
      username: this.config.username ? '***' : undefined,
      hasPassword: !!this.config.password,
      hasJwtToken: !!this.config.jwtToken,
    });

    const tests = [
      this.testListTools,
      this.testGetMonitorSummary,
      this.testListMonitors,
      this.testGetMonitor,
      this.testGetHeartbeats,
      this.testListHeartbeats,
      this.testGetSettings,
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

  if (config.username && !config.password) {
    console.error('❌ Error: UPTIME_KUMA_PASSWORD must be set when using username authentication');
    process.exit(1);
  }

  const test = new MCPIntegrationTest(config);

  try {
    await test.connect();
    await test.runAllTests();
    console.log('\n✅ All tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  } finally {
    await test.disconnect();
  }
}

// Run if executed directly
if (import.meta.url.endsWith('integration.test.ts') || import.meta.url === `file://${process.argv[1]}`) {
  main();
}
