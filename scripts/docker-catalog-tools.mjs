#!/usr/bin/env node
// Writes docker-mcp-catalog/uptime-kuma/tools.json, the tool list the Docker MCP Catalog
// shows for this server.
//
// The catalog normally learns a server's tools by starting it and calling tools/list. This
// server needs a working Uptime Kuma login before it is useful, so the catalog reads the list
// from tools.json instead, and that file has to be kept in step with the tools the server
// registers. This script asks the built server for its tools over stdio and converts them to
// the catalog's format, so the file never has to be edited by hand.
//
// Usage (after `npm run build`):
//   node scripts/docker-catalog-tools.mjs          rewrite tools.json
//   node scripts/docker-catalog-tools.mjs --check  exit 1 if tools.json is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'docker-mcp-catalog', 'uptime-kuma', 'tools.json');
const check = process.argv.includes('--check');

// Tools register without a reachable Uptime Kuma: the initial login failure is not fatal.
// A closed local port fails fast instead of waiting on a network timeout.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'index.js'), '-t', 'stdio'],
  env: { ...process.env, UPTIME_KUMA_URL: 'http://127.0.0.1:9', UPTIME_KUMA_READ_ONLY: '' },
  stderr: 'ignore',
});
const client = new Client({ name: 'docker-catalog-tools', version: '1.0.0' });
await client.connect(transport);
const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

// The catalog's argument model is flat: one JSON type per argument, and an item type for
// arrays. Reduce each JSON Schema property to that, keeping the first non-null type of a
// union so that a nullable field still reads as what it carries.
function schemaType(schema) {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== 'null') ?? 'string';
  for (const branch of schema.anyOf ?? schema.oneOf ?? []) {
    const t = schemaType(branch);
    if (t !== 'null') return t;
  }
  if (schema.enum) return typeof schema.enum[0] === 'number' ? 'number' : 'string';
  return 'object';
}

const problems = [];
const catalogTools = tools
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((tool) => {
    const schema = tool.inputSchema ?? {};
    const required = new Set(schema.required ?? []);
    const args = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
      // The catalog's validator rejects an argument without a description, so a missing
      // one is reported here, where it can be fixed in the tool's own schema.
      if (!prop.description) problems.push(`${tool.name}.${name} has no description`);
      const arg = { name, type: schemaType(prop), desc: prop.description ?? '' };
      if (arg.type === 'array' && prop.items) arg.items = { type: schemaType(prop.items) };
      if (!required.has(name)) arg.optional = true;
      return arg;
    });
    const entry = { name: tool.name, description: tool.description ?? '' };
    if (args.length) entry.arguments = args;
    // The MCP SDK puts a tool's display title on the tool itself; the catalog keeps it with
    // the hints. False hints are left out, as the catalog drops them anyway (Go omitempty).
    const a = {};
    const title = tool.title ?? tool.annotations?.title;
    if (title) a.title = title;
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (tool.annotations?.[key]) a[key] = tool.annotations[key];
    }
    if (Object.keys(a).length) entry.annotations = a;
    return entry;
  });

if (problems.length) {
  console.error(`Arguments the Docker MCP Catalog would reject:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const json = `${JSON.stringify(catalogTools, null, 2)}\n`;
if (check) {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (current !== json) {
    console.error('docker-mcp-catalog/uptime-kuma/tools.json is out of date. Run: npm run docker-catalog:tools');
    process.exit(1);
  }
  console.log(`tools.json is up to date (${catalogTools.length} tools).`);
} else {
  writeFileSync(outPath, json);
  console.log(`Wrote ${catalogTools.length} tools to docker-mcp-catalog/uptime-kuma/tools.json`);
}
