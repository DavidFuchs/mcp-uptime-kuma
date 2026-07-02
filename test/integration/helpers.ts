import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config as dotenvConfig } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: join(__dirname, '.env.test') });

export interface TestConfig {
  url: string;
  username?: string;
  password?: string;
  jwtToken?: string;
}

export type TestFn = (ctx: TestContext) => Promise<void>;

export interface TestContext {
  client: Client;
  config: TestConfig;
}

/**
 * Creates and connects an MCP client for integration testing.
 */
export async function createTestClient(config: TestConfig): Promise<{ client: Client; transport: StdioClientTransport }> {
  const client = new Client(
    { name: 'mcp-uptime-kuma-integration-test', version: '1.0.0' },
    { capabilities: {} }
  );

  const serverPath = join(__dirname, '../../src/index.ts');

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    UPTIME_KUMA_URL: config.url,
    MCP_TEST_MODE: '1',
  };

  delete env.UPTIME_KUMA_JWT_TOKEN;

  if (config.username) env.UPTIME_KUMA_USERNAME = config.username;
  if (config.password) env.UPTIME_KUMA_PASSWORD = config.password;
  if (config.jwtToken) env.UPTIME_KUMA_JWT_TOKEN = config.jwtToken;

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath, '-t', 'stdio'],
    env,
  });

  await client.connect(transport);
  await new Promise(resolve => setTimeout(resolve, 2000));
  await client.listTools();

  return { client, transport };
}

/**
 * Loads the test config from environment variables.
 */
export function loadTestConfig(): TestConfig {
  return {
    url: process.env.UPTIME_KUMA_URL || 'http://localhost:3001',
    username: process.env.UPTIME_KUMA_USERNAME,
    password: process.env.UPTIME_KUMA_PASSWORD,
    jwtToken: process.env.UPTIME_KUMA_JWT_TOKEN,
  };
}

/**
 * Validates test config and exits if insufficient.
 */
export function validateTestConfig(config: TestConfig): void {
  if (!config.username && !config.jwtToken) {
    console.error('❌ Error: UPTIME_KUMA_USERNAME or UPTIME_KUMA_JWT_TOKEN must be set');
    process.exit(1);
  }
  if (config.username && !config.password) {
    console.error('❌ Error: UPTIME_KUMA_PASSWORD must be set when using username authentication');
    process.exit(1);
  }
}

/**
 * Extracts text content from an MCP tool result. Throws on error.
 */
export function extractText(result: CallToolResult, toolName: string): string {
  const textContent = (result.content as any[])?.find((c: any) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error(`No text content in ${toolName} response`);
  }
  if (result.isError) {
    throw new Error(`${toolName} returned error: ${textContent.text}`);
  }
  return textContent.text;
}

/**
 * Extracts a numeric ID from a tool result's structuredContent or text.
 * Looks in structuredContent first (monitorID, maintenanceID, tagID, id),
 * then falls back to regex matching on the text content.
 */
export function extractID(result: CallToolResult, toolName: string, idField?: string): number {
  // Try structuredContent first
  const sc = (result as any).structuredContent;
  if (sc) {
    const fields = idField ? [idField] : ['monitorID', 'maintenanceID', 'tagID', 'id'];
    for (const f of fields) {
      if (sc[f] != null) return Number(sc[f]);
    }
    // Check nested: e.g. { tag: { id: 5 } }
    if (sc.tag?.id != null) return Number(sc.tag.id);
  }

  // Try parsing text content as JSON
  const text = extractText(result, toolName);
  try {
    const parsed = JSON.parse(text);
    const fields = idField ? [idField] : ['monitorID', 'maintenanceID', 'tagID', 'id'];
    for (const f of fields) {
      if (parsed[f] != null) return Number(parsed[f]);
    }
    if (parsed.tag?.id != null) return Number(parsed.tag.id);
  } catch {
    // Not JSON — try regex
  }

  const match = text.match(/ID\s*[:=]?\s*(\d+)/i);
  if (match) return parseInt(match[1]);

  throw new Error(`Could not extract ID from ${toolName} response: ${text.substring(0, 100)}`);
}

/**
 * Runs a suite of named tests, printing results.
 */
export async function runTestSuite(
  suiteName: string,
  tests: Array<{ name: string; fn: TestFn }>,
  ctx: TestContext,
): Promise<{ passed: number; failed: number }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 ${suiteName}`);
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test.fn(ctx);
      passed++;
    } catch (error) {
      failed++;
      console.error(`  ❌ ${test.name}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(`\n  📊 ${suiteName}: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
