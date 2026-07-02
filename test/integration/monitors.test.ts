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
];
