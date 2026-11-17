import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

/** A byte count as people read it: 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** The database's size and type, and shrinking it. */
export function registerDatabaseTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  /**
   * The database type Uptime Kuma reported, or failing that what the size implies: it answers
   * 0 for anything but SQLite, and an SQLite file is never empty.
   */
  const dbTypeOf = (size: number): string | null => client.getServerInfo().dbType ?? (size > 0 ? 'sqlite' : null);

  server.registerTool(
    'getDatabaseInfo',
    {
      title: 'Get Database Info',
      description:
        "Returns which database Uptime Kuma stores its data in (sqlite, mariadb or embedded-mariadb), the SQLite file's size, and how many days of monitor history it keeps (keepDataPeriodDays). Uptime Kuma can only measure and shrink SQLite; for MariaDB the size is null.",
      inputSchema: {},
      outputSchema: {
        dbType: z.string().nullable().describe('sqlite, mariadb or embedded-mariadb; null if Uptime Kuma did not say'),
        sizeBytes: z.number().nullable().describe('Size of the SQLite file; null for MariaDB'),
        size: z.string().nullable().describe('sizeBytes in KB / MB / GB'),
        canShrink: z.boolean().describe('Whether shrinkDatabase does anything on this database'),
        keepDataPeriodDays: z
          .number()
          .nullable()
          .describe(
            'Days of heartbeats and daily statistics kept before the nightly cleanup deletes them; 0 keeps them forever. Change it with updateSettings.'
          ),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const sizeBytes = await client.getDatabaseSize();
        const dbType = dbTypeOf(sizeBytes);
        const sqlite = dbType === 'sqlite';
        // The retention period is what decides how large the database grows. It is extra here,
        // so a failure to read it does not fail the call.
        let keepDataPeriodDays: number | null = null;
        try {
          const days = Number((await client.getSettings()).data?.keepDataPeriodDays);
          if (Number.isFinite(days)) keepDataPeriodDays = days;
        } catch {
          // leave it null
        }

        const result = {
          dbType,
          sizeBytes: sqlite ? sizeBytes : null,
          size: sqlite ? formatBytes(sizeBytes) : null,
          canShrink: sqlite,
          keepDataPeriodDays,
        };
        const text = sqlite
          ? `SQLite database, ${result.size}.`
          : `${dbType ?? 'Unknown'} database: Uptime Kuma does not report its size.`;
        return {
          content: [{ type: 'text', text: `${text} ${JSON.stringify(result)}` }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get the database info: ${message}`);
      }
    }
  );

  server.registerTool(
    'shrinkDatabase',
    {
      title: 'Shrink Database',
      description:
        "Gives the space of deleted history back to the disk by rewriting the SQLite file (VACUUM). Run it after clearing history or lowering keepDataPeriodDays; it frees nothing otherwise. While it runs, Uptime Kuma cannot record checks, and it needs free disk space about the database's size. A large database takes minutes. SQLite only: refused on MariaDB, where Uptime Kuma has nothing to do. Returns the size before and after.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        sizeBefore: z.number().describe('Bytes before shrinking'),
        sizeAfter: z.number().describe('Bytes after shrinking'),
        freed: z.string().describe('The difference, in KB / MB / GB'),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const sizeBefore = await client.getDatabaseSize();
        const dbType = dbTypeOf(sizeBefore);
        if (dbType !== 'sqlite') {
          throw new Error(
            `Uptime Kuma can only shrink SQLite, and this server uses ${dbType ?? 'a database it did not name'} — nothing to do`
          );
        }
        const response = await client.shrinkDatabase();
        const sizeAfter = await client.getDatabaseSize();
        const freed = formatBytes(Math.max(0, sizeBefore - sizeAfter));
        return {
          content: [
            {
              type: 'text',
              text: `Database shrunk from ${formatBytes(sizeBefore)} to ${formatBytes(sizeAfter)} (${freed} freed).`,
            },
          ],
          structuredContent: { ok: response.ok, sizeBefore, sizeAfter, freed },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to shrink the database: ${message}`);
      }
    }
  );
}
