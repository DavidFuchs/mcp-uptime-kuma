import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText, extractID } from './helpers.js';

/**
 * Integration tests for strict input schemas.
 *
 * Issue coverage:
 * - #65: a misspelled `monitorId` reported "expected number, received nan" for `monitorID`,
 *        blaming a field the caller never got wrong.
 * - The shared mechanism behind #58 / #60 / #63: an undeclared field was stripped before the
 *   handler ran, refilled from the existing config, and the call still reported success.
 */

/** Runs a tool and returns the error message, or throws if the call unexpectedly succeeded. */
async function expectToolError(client: any, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    if (!result.isError) {
      throw new Error(`${name} accepted arguments it should have rejected: ${JSON.stringify(args)}`);
    }
    const textContent = (result.content as any[])?.find((c: any) => c.type === 'text');
    return String(textContent?.text ?? '');
  } catch (err) {
    // The SDK surfaces validation failures as a thrown McpError rather than isError.
    const message = err instanceof Error ? err.message : String(err);
    if (/accepted arguments it should have rejected/.test(message)) throw err;
    return message;
  }
}

export const strictSchemaTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: '#65: a misspelled key is named, instead of being stripped and blamed on another field',
    fn: async ({ client }) => {
      const message = await expectToolError(client, 'getMonitor', { monitorId: 1 });

      if (!message.includes('monitorId')) {
        throw new Error(`error does not name the offending key: ${message}`);
      }
      if (!/Accepted fields/.test(message)) {
        throw new Error(`error does not list the accepted fields: ${message}`);
      }
      // The NaN complaint used to appear underneath the unknown-key error, because the
      // required IDs were `z.coerce.number()` and coercion turns the now-absent `monitorID`
      // into NaN. Those are now declared with `requiredId`, so the absence is reported as an
      // absence and the NaN line is gone entirely rather than merely demoted.
      if (/nan/i.test(message)) {
        throw new Error(`the NaN complaint is still present: ${message}`);
      }
      console.log('  ✓ #65: unknown key named first, accepted fields listed, no NaN complaint');
    },
  },
  {
    name: 'an undeclared write field is rejected rather than silently dropped',
    fn: async ({ client }) => {
      const monitorID = extractID(await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - strict schema',
          type: 'http',
          url: 'https://example.com',
          interval: 300,
        },
      }) as CallToolResult, 'createMonitor', 'monitorID');

      try {
        // Previously this returned {"ok":true,"msg":"Saved."} having written nothing.
        const message = await expectToolError(client, 'updateMonitor', {
          monitorID,
          thisFieldDoesNotExist: 'value',
        });
        if (!message.includes('thisFieldDoesNotExist')) {
          throw new Error(`error does not name the unknown field: ${message}`);
        }
        console.log('  ✓ undeclared field rejected and named');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: 'declared fields still work — strictness does not break valid calls',
    fn: async ({ client }) => {
      const monitorID = extractID(await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - strict schema valid',
          type: 'http',
          url: 'https://example.com',
          interval: 300,
          retryInterval: 60,
          maxretries: 2,
        },
      }) as CallToolResult, 'createMonitor', 'monitorID');

      try {
        await client.callTool({ name: 'updateMonitor', arguments: { monitorID, name: 'renamed' } });
        const monitor = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult,
          'getMonitor'
        ));
        if (monitor.name !== 'renamed') throw new Error('valid update did not apply');
        console.log('  ✓ valid calls unaffected');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: 'tools/list advertises additionalProperties:false',
    fn: async ({ client }) => {
      const { tools } = await client.listTools();
      const loose = tools
        .filter((t: any) => t.inputSchema?.additionalProperties !== false)
        .map((t: any) => t.name);
      if (loose.length > 0) {
        throw new Error(`these tools still advertise an open schema: ${loose.join(', ')}`);
      }
      console.log(`  ✓ all ${tools.length} tools advertise additionalProperties:false`);
    },
  },
];
