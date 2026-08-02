import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TestFn, extractText, extractID } from './helpers.js';

/**
 * Integration tests for monitor CRUD and lifecycle operations.
 * Covers: createMonitor, getMonitor, updateMonitor, deleteMonitor,
 *         listMonitors, listMonitorTypes, getMonitorSummary,
 *         pauseMonitor, resumeMonitor
 *
 * Issue coverage:
 * - #42: Docker monitor docker_container/docker_host fields
 * - #43: updateMonitor preserves retryInterval when omitted
 */

export const monitorTests: Array<{ name: string; fn: TestFn }> = [
  {
    name: 'listMonitors returns array',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'listMonitors', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'listMonitors');
      const monitors = JSON.parse(text);
      if (!Array.isArray(monitors)) throw new Error('Expected array');
      console.log(`  ✓ listMonitors: ${monitors.length} monitors`);
    },
  },
  {
    name: 'listMonitorTypes returns supported types',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'listMonitorTypes', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'listMonitorTypes');
      const types = JSON.parse(text);
      if (!Array.isArray(types) || types.length === 0) throw new Error('Expected non-empty array of types');
      if (!types.some((t: any) => t.type === 'http' || t === 'http')) {
        throw new Error('Expected "http" type in list');
      }
      console.log(`  ✓ listMonitorTypes: ${types.length} types`);
    },
  },
  {
    name: 'getMonitorSummary returns summaries',
    fn: async ({ client }) => {
      const result = await client.callTool({ name: 'getMonitorSummary', arguments: {} }) as CallToolResult;
      const text = extractText(result, 'getMonitorSummary');
      const summaries = JSON.parse(text);
      if (!Array.isArray(summaries)) throw new Error('Expected array');
      console.log(`  ✓ getMonitorSummary: ${summaries.length} summaries`);
    },
  },
  {
    name: 'createMonitor → getMonitor → deleteMonitor lifecycle',
    fn: async ({ client }) => {
      // Create
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - HTTP',
          type: 'http',
          url: 'https://example.com',
          interval: 120,
          retryInterval: 30,
          maxretries: 2,
        },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        // Get
        const getResult = await client.callTool({
          name: 'getMonitor',
          arguments: { monitorID },
        }) as CallToolResult;
        const monitor = JSON.parse(extractText(getResult, 'getMonitor'));
        if (monitor.name !== 'Integration Test - HTTP') throw new Error('Name mismatch');
        if (monitor.type !== 'http') throw new Error('Type mismatch');

        console.log(`  ✓ create/get lifecycle: monitor ID ${monitorID}`);
      } finally {
        // Delete
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
        console.log(`  ✓ deleteMonitor: cleaned up ID ${monitorID}`);
      }
    },
  },
  {
    name: '#43: updateMonitor preserves retryInterval when omitted',
    fn: async ({ client }) => {
      // Create with explicit retryInterval
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - Issue 43',
          type: 'http',
          url: 'https://example.com',
          interval: 60,
          retryInterval: 45,
        },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        // Update only URL — omit retryInterval
        const updateResult = await client.callTool({
          name: 'updateMonitor',
          arguments: { monitorID, url: 'https://example.org' },
        }) as CallToolResult;
        extractText(updateResult, 'updateMonitor'); // throws if error

        // Verify retryInterval preserved
        const getResult = await client.callTool({
          name: 'getMonitor',
          arguments: { monitorID, includeTypeSpecificFields: true },
        }) as CallToolResult;
        const monitor = JSON.parse(extractText(getResult, 'getMonitor'));

        if (monitor.url !== 'https://example.org') throw new Error(`URL not updated: ${monitor.url}`);
        if (monitor.retryInterval !== 45) throw new Error(`retryInterval not preserved: ${monitor.retryInterval}`);

        console.log(`  ✓ #43: updateMonitor preserved retryInterval=45 when omitted`);
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: '#42: createMonitor accepts docker_container and docker_host fields',
    fn: async ({ client }) => {
      // The schema should accept docker_container and docker_host
      // Even with an invalid docker_host ID, the MCP layer should pass them through
      // (the error should come from Kuma, not schema validation)
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - Docker Issue 42',
          type: 'docker',
          docker_container: 'test-container',
          docker_host: 999,
        },
      }) as CallToolResult;

      const textContent = (createResult.content as any[])?.find((c: any) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text content');
      }

      // If it succeeded, clean up
      if (!createResult.isError) {
        try {
          const monitorID = extractID(createResult, 'createMonitor', 'monitorID');
          await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
        } catch { /* ignore cleanup failure */ }
        console.log(`  ✓ #42: docker monitor created and cleaned up`);
        return;
      }

      // If it errored, it should be a Kuma error (not a schema validation error)
      if (textContent.text.includes('validation error') || textContent.text.includes('Invalid input')) {
        throw new Error(`Schema rejected docker fields: ${textContent.text}`);
      }

      // Kuma-level error (e.g., "docker host not found") is acceptable
      console.log(`  ✓ #42: docker fields accepted by schema (Kuma rejected: expected with invalid host)`);
    },
  },
  {
    name: 'pauseMonitor and resumeMonitor',
    fn: async ({ client }) => {
      // Create a monitor to pause/resume
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - Pause/Resume',
          type: 'http',
          url: 'https://example.com',
          interval: 300,
        },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        // Pause
        const pauseResult = await client.callTool({
          name: 'pauseMonitor',
          arguments: { monitorID },
        }) as CallToolResult;
        extractText(pauseResult, 'pauseMonitor');

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verify paused
        const getResult1 = await client.callTool({
          name: 'getMonitor',
          arguments: { monitorID },
        }) as CallToolResult;
        const paused = JSON.parse(extractText(getResult1, 'getMonitor'));
        if (paused.active !== false) throw new Error('Monitor not paused');

        // Resume
        const resumeResult = await client.callTool({
          name: 'resumeMonitor',
          arguments: { monitorID },
        }) as CallToolResult;
        extractText(resumeResult, 'resumeMonitor');

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verify resumed
        const getResult2 = await client.callTool({
          name: 'getMonitor',
          arguments: { monitorID },
        }) as CallToolResult;
        const resumed = JSON.parse(extractText(getResult2, 'getMonitor'));
        if (resumed.active !== true) throw new Error('Monitor not resumed');

        console.log(`  ✓ pauseMonitor/resumeMonitor lifecycle`);
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: '#58: createMonitor and updateMonitor persist description',
    fn: async ({ client }) => {
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - Issue 58',
          type: 'http',
          url: 'https://example.com',
          interval: 120,
          description: 'created with a description',
          active: false,
        },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        const created = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult,
          'getMonitor'
        ));
        if (created.description !== 'created with a description') {
          throw new Error(`description not persisted on create: got ${JSON.stringify(created.description)}`);
        }
        // `active` was also absent from createMonitor's schema, so a request to create a
        // paused monitor was silently ignored and it started checking immediately.
        if (created.active !== false) throw new Error('active:false not honoured on create');

        await client.callTool({ name: 'updateMonitor', arguments: { monitorID, description: 'edited' } });
        const edited = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult,
          'getMonitor'
        ));
        if (edited.description !== 'edited') {
          throw new Error(`description not persisted on update: got ${JSON.stringify(edited.description)}`);
        }
        console.log('  ✓ #58: description persists on create and update; active:false honoured');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: '#60: json-query monitors are fully configurable',
    fn: async ({ client }) => {
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: {
          name: 'Integration Test - Issue 60 json-query',
          type: 'json-query',
          url: 'https://example.com',
          interval: 300,
          active: false,
          jsonPath: '$.freeSpace',
          jsonPathOperator: '>',
          expectedValue: 161061273600,
        },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        const m = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID, includeTypeSpecificFields: true } }) as CallToolResult,
          'getMonitor'
        ));
        if (m.jsonPath !== '$.freeSpace') throw new Error(`jsonPath not persisted: ${JSON.stringify(m.jsonPath)}`);
        if (m.jsonPathOperator !== '>') throw new Error(`jsonPathOperator not persisted: ${JSON.stringify(m.jsonPathOperator)}`);
        if (String(m.expectedValue) !== '161061273600') throw new Error(`expectedValue not persisted: ${JSON.stringify(m.expectedValue)}`);

        // snake_case aliases — the database column names, and the spelling used in #60
        await client.callTool({
          name: 'updateMonitor',
          arguments: { monitorID, json_path: '$.total', json_path_operator: '<', expected_value: '42' },
        });
        const m2 = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID, includeTypeSpecificFields: true } }) as CallToolResult,
          'getMonitor'
        ));
        if (m2.jsonPath !== '$.total' || m2.jsonPathOperator !== '<' || String(m2.expectedValue) !== '42') {
          throw new Error('snake_case aliases were not normalised onto the camelCase fields');
        }
        console.log('  ✓ #60: json-query triple persists, snake_case aliases normalised');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: '#60: push monitors are created with a usable token and ping URL',
    fn: async ({ client }) => {
      const createResult = await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'Integration Test - Issue 60 push', type: 'push', interval: 3600 },
      }) as CallToolResult;
      const monitorID = extractID(createResult, 'createMonitor', 'monitorID');

      try {
        const sc = (createResult as any).structuredContent;
        if (!sc?.pushToken || String(sc.pushToken).length !== 32) {
          throw new Error(`expected a 32-character generated push token, got ${JSON.stringify(sc?.pushToken)}`);
        }
        if (!sc?.pushURL || !String(sc.pushURL).includes('/api/push/')) {
          throw new Error(`expected a ping URL, got ${JSON.stringify(sc?.pushURL)}`);
        }
        // includeSecrets is required here (#59): pushToken reads "***" by default, and
        // comparing what was stored against what was returned needs the real value. This is
        // the canonical case for the opt-in — verifying a credential rather than listing it.
        const stored = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID, includeTypeSpecificFields: true, includeSecrets: true } }) as CallToolResult,
          'getMonitor'
        ));
        if (stored.pushToken !== sc.pushToken) throw new Error('stored push token does not match the returned one');

        // The whole point: the returned URL must actually be able to record a beat.
        const res = await fetch(`${String(sc.pushURL)}&msg=integration-test`);
        if (res.status !== 200) throw new Error(`push URL returned HTTP ${res.status}`);
        console.log('  ✓ #60: push token generated, stored, and the ping URL accepts a heartbeat');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
  {
    name: '#63/#65: updateMonitor re-parents, and listMonitors filters by parent',
    fn: async ({ client }) => {
      const groupID = extractID(await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'Integration Test - Issue 63 group', type: 'group', interval: 300, active: false },
      }) as CallToolResult, 'createMonitor', 'monitorID');
      const monitorID = extractID(await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'Integration Test - Issue 63 child', type: 'http', url: 'https://example.com', interval: 300, active: false },
      }) as CallToolResult, 'createMonitor', 'monitorID');

      try {
        await client.callTool({ name: 'updateMonitor', arguments: { monitorID, parent: groupID } });
        const moved = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult,
          'getMonitor'
        ));
        if (Number(moved.parent) !== groupID) {
          throw new Error(`re-parent did not persist: parent is ${JSON.stringify(moved.parent)}, expected ${groupID}`);
        }

        const listed = JSON.parse(extractText(
          await client.callTool({ name: 'listMonitors', arguments: { parentId: groupID } }) as CallToolResult,
          'listMonitors'
        ));
        if (!Array.isArray(listed) || listed.length !== 1 || Number(listed[0].id) !== monitorID) {
          throw new Error(`parentId filter returned ${Array.isArray(listed) ? listed.length : 'non-array'} monitors, expected exactly the one child`);
        }

        await client.callTool({ name: 'updateMonitor', arguments: { monitorID, parent: null } });
        const back = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult,
          'getMonitor'
        ));
        if (back.parent !== null) throw new Error('re-parent to top level did not persist');
        console.log('  ✓ #63/#65: re-parent works both ways; parentId returns direct children');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID: groupID } });
      }
    },
  },
  {
    name: 'timeout defaults to 0.8 x interval instead of being stored as 0',
    fn: async ({ client }) => {
      const monitorID = extractID(await client.callTool({
        name: 'createMonitor',
        arguments: { name: 'Integration Test - timeout default', type: 'http', url: 'https://example.com', interval: 300, active: false },
      }) as CallToolResult, 'createMonitor', 'monitorID');

      try {
        const m = JSON.parse(extractText(
          await client.callTool({ name: 'getMonitor', arguments: { monitorID } }) as CallToolResult,
          'getMonitor'
        ));
        if (Number(m.timeout) !== 240) {
          throw new Error(`expected timeout 240 (0.8 x 300), got ${JSON.stringify(m.timeout)}`);
        }
        console.log('  ✓ timeout defaulted to 240s rather than 0');
      } finally {
        await client.callTool({ name: 'deleteMonitor', arguments: { monitorID } });
      }
    },
  },
];
