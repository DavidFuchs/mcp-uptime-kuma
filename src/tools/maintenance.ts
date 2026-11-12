import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { MaintenanceSchema } from '../types/index.js';
import { numeric, requiredId } from './schema.js';

/** The maintenance window tools. */
export function registerMaintenanceTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  const MAINTENANCE_STRATEGIES = ['single', 'recurring-interval', 'recurring-weekday', 'recurring-day-of-month', 'cron', 'manual'] as const;

  // The schedule fields shared by createMaintenance and updateMaintenance. Each tool applies
  // its own optionality: create requires title and strategy, update requires neither.
  const maintenanceScheduleFields = {
    description: z.string().optional().describe('Description or reason for the maintenance'),
    timezone: z.string().optional().describe('Timezone the dates and times are in (e.g. "America/New_York", "UTC"). Omit to follow the server timezone.'),
    dateRange: z.array(z.string()).optional().describe('[start, end] as local wall-clock times in the window\'s timezone, e.g. ["2026-10-08T10:00", "2026-10-08T12:00"] — the format Uptime Kuma\'s own UI stores. Required for single; optional bounds for recurring strategies; ignored for manual.'),
    timeRange: z.array(z.object({ hours: numeric(z.number().int().min(0).max(23)), minutes: numeric(z.number().int().min(0).max(59)) })).optional()
      .describe('Daily [{hours, minutes}, {hours, minutes}] start and end. Required for the recurring-* strategies, ignored otherwise.'),
    weekdays: z.array(numeric(z.number().int().min(0).max(6))).optional()
      .describe('Days of week (0=Sunday … 6=Saturday) for recurring-weekday strategy'),
    daysOfMonth: z.array(numeric(z.number().int().min(1).max(31))).optional()
      .describe('Days of month (1-31) for recurring-day-of-month strategy'),
    intervalDay: numeric(z.number().int().positive()).optional()
      .describe('Interval in days for recurring-interval strategy'),
    cron: z.string().optional()
      .describe('Cron expression for when the window starts, e.g. "30 3 * * *" (03:30 daily), for the cron strategy'),
    durationMinutes: numeric(z.number().int().positive()).optional()
      .describe('How long each window lasts, in minutes, for the cron strategy'),
    monitorIDs: z.array(numeric(z.number().int().nonnegative())).optional()
      .describe('IDs of the monitors this window suppresses. A window with no monitors suppresses nothing. On update this REPLACES the current list; pass [] to detach all.'),
  };

  /**
   * Turns tool input into the object Uptime Kuma's Maintenance.jsonToBean() expects.
   *
   * jsonToBean() reads every field unconditionally, so anything left out is not "unchanged"
   * or "defaulted" — it is an error or a NULL:
   *   - dateRange missing → "Cannot read properties of undefined (reading '0')", which made
   *     manual and recurring windows impossible to create without inventing dates.
   *   - active missing → "NOT NULL constraint failed: maintenance.active", despite the
   *     schema promising a default of true.
   *   - timezone is not read at all; the column is filled from `timezoneOption`. Passing
   *     timezone silently produced a window in the server timezone.
   *   - a recurring-* strategy without a timeRange throws while generating its cron.
   */
  const toKumaMaintenance = (fields: Record<string, unknown>): Record<string, unknown> => {
    const strategy = fields.strategy as string;
    const dateRange = (fields.dateRange as Array<string | null> | undefined) ?? [];
    const timeRange = fields.timeRange as Array<{ hours: number; minutes: number } | null> | undefined;

    if (strategy === 'single' && !(dateRange[0] && dateRange[1])) {
      throw new Error('A single maintenance window needs dateRange: [start, end].');
    }
    if (strategy.startsWith('recurring-') && !(timeRange?.length === 2 && timeRange[0] && timeRange[1])) {
      throw new Error(`A ${strategy} maintenance window needs timeRange: [{hours, minutes}, {hours, minutes}].`);
    }
    if (strategy === 'recurring-weekday' && !(fields.weekdays as number[] | undefined)?.length) {
      throw new Error('A recurring-weekday maintenance window needs at least one entry in weekdays.');
    }
    if (strategy === 'recurring-day-of-month' && !(fields.daysOfMonth as number[] | undefined)?.length) {
      throw new Error('A recurring-day-of-month maintenance window needs at least one entry in daysOfMonth.');
    }
    if (strategy === 'recurring-interval' && !fields.intervalDay) {
      throw new Error('A recurring-interval maintenance window needs intervalDay.');
    }
    if (strategy === 'cron' && !(fields.cron && fields.durationMinutes)) {
      throw new Error('A cron maintenance window needs cron and durationMinutes.');
    }

    const out: Record<string, unknown> = {
      title: fields.title,
      description: fields.description ?? '',
      strategy,
      active: fields.active ?? true,
      intervalDay: fields.intervalDay ?? null,
      dateRange,
      weekdays: fields.weekdays ?? [],
      daysOfMonth: fields.daysOfMonth ?? [],
      timezoneOption: fields.timezone ?? null,
    };
    if (timeRange) out.timeRange = timeRange;
    // jsonToBean reads these only for the cron strategy, and then unconditionally: a missing
    // cron fails validation and a missing durationMinutes stores a NaN duration.
    if (strategy === 'cron') {
      out.cron = fields.cron;
      out.durationMinutes = fields.durationMinutes;
    }
    if (fields.id !== undefined) out.id = fields.id;
    return out;
  };

  /** Strips nulls so [start] and [start, null] and [null] compare the way Kuma stores them. */
  const presentDates = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string' && d !== '') : [];

  /**
   * Reads the window back and reports every requested field that did not persist.
   * Same contract as verifyMonitorWrite(): returns the problem rather than throwing, because
   * the write has already happened and the caller still has to report the window's ID.
   */
  const verifyMaintenanceWrite = async (
    maintenanceID: number,
    requested: Record<string, unknown>,
    operation: string
  ): Promise<string | null> => {
    let fresh: Record<string, unknown>;
    try {
      fresh = await client.fetchMaintenance(maintenanceID);
    } catch (verifyError) {
      const m = verifyError instanceof Error ? verifyError.message : String(verifyError);
      return `Maintenance window ${maintenanceID} was ${operation}, but the write could NOT be verified: ${m}. Do not assume it applied.`;
    }

    const recurring = String(fresh.strategy ?? '').startsWith('recurring-');
    const mismatches: string[] = [];
    const check = (field: string, wanted: unknown, stored: unknown) => {
      if (JSON.stringify(wanted) !== JSON.stringify(stored)) {
        mismatches.push(`${field}: asked for ${JSON.stringify(wanted)}, server reports ${JSON.stringify(stored)}`);
      }
    };

    for (const field of ['title', 'description', 'strategy', 'intervalDay', 'active'] as const) {
      if (field in requested) check(field, requested[field] ?? null, fresh[field] ?? null);
    }
    if ('timezone' in requested) check('timezone', requested.timezone ?? null, fresh.timezoneOption ?? null);
    if ('dateRange' in requested && fresh.strategy !== 'manual') {
      check('dateRange', presentDates(requested.dateRange), presentDates(fresh.dateRange));
    }
    if (recurring) {
      if ('timeRange' in requested) {
        const hm = (v: unknown) =>
          Array.isArray(v) ? v.map((t) => (t ? { hours: Number(t.hours), minutes: Number(t.minutes) } : null)) : null;
        check('timeRange', hm(requested.timeRange), hm(fresh.timeRange));
      }
      if ('weekdays' in requested) check('weekdays', requested.weekdays, fresh.weekdays);
      if ('daysOfMonth' in requested) check('daysOfMonth', requested.daysOfMonth, fresh.daysOfMonth);
    }
    if (fresh.strategy === 'cron') {
      if ('cron' in requested) check('cron', requested.cron, fresh.cron);
      if ('durationMinutes' in requested) check('durationMinutes', requested.durationMinutes, fresh.durationMinutes);
    }

    if (mismatches.length === 0) return null;
    return (
      `Maintenance window ${maintenanceID} was ${operation} and Uptime Kuma acknowledged it, but the following did NOT persist:\n` +
      `  - ${mismatches.join('\n  - ')}`
    );
  };

  /**
   * Sets the window's monitor list (a full replace) and reads it back. Returns the problem
   * as a string, like verifyMaintenanceWrite().
   */
  const setAndVerifyMaintenanceMonitors = async (
    maintenanceID: number,
    monitorIDs: number[],
    operation: string
  ): Promise<string | null> => {
    const wanted = [...new Set(monitorIDs)].sort((a, b) => a - b);
    try {
      await client.setMonitorMaintenance(maintenanceID, wanted);
    } catch (linkError) {
      const m = linkError instanceof Error ? linkError.message : String(linkError);
      return `Maintenance window ${maintenanceID} was ${operation}, but setting its monitors to [${wanted.join(', ')}] failed: ${m}`;
    }

    let stored: number[];
    try {
      stored = (await client.getMonitorMaintenance(maintenanceID)).sort((a, b) => a - b);
    } catch (verifyError) {
      const m = verifyError instanceof Error ? verifyError.message : String(verifyError);
      return `Maintenance window ${maintenanceID} was ${operation}, but its monitor list could NOT be verified: ${m}. Do not assume it applied.`;
    }

    if (JSON.stringify(stored) !== JSON.stringify(wanted)) {
      return (
        `Maintenance window ${maintenanceID} was ${operation} and Uptime Kuma acknowledged the monitor list, ` +
        `but it covers [${stored.join(', ')}] rather than the requested [${wanted.join(', ')}].`
      );
    }
    return null;
  };

  /**
   * Uptime Kuma answers a write to a missing window with either `ok: true` (delete) or a raw
   * "Cannot read properties of null" (edit, pause, resume). Check first so the caller gets
   * "not found" instead of a false success or a stack-trace fragment.
   */
  const requireMaintenance = async (maintenanceID: number): Promise<void> => {
    const list = await client.refreshMaintenanceList();
    if (!list.some((w) => w.id === maintenanceID)) {
      throw new Error(`Maintenance window ${maintenanceID} not found. Use getMaintenanceWindows to list the windows that exist.`);
    }
  };

  const errorResult = (problem: string, text: string, structuredContent: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: `${problem}\n\n${text}` }],
    structuredContent,
    isError: true,
  });

  server.registerTool(
    'getMaintenanceWindows',
    {
      title: 'Get Maintenance Windows',
      description: 'Returns all maintenance windows defined in Uptime Kuma, each with monitorIDs — the monitors it suppresses. A window with an empty monitorIDs list suppresses nothing.',
      inputSchema: {},
      outputSchema: {
        maintenanceWindows: z.array(MaintenanceSchema).describe('Array of maintenance windows'),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const maintenanceWindows = await Promise.all(
          client.getMaintenanceList().map(async (w) => ({
            ...w,
            monitorIDs: w.id === undefined ? [] : await client.getMonitorMaintenance(w.id),
          }))
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(maintenanceWindows) }],
          structuredContent: { maintenanceWindows, count: maintenanceWindows.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get maintenance windows: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createMaintenance',
    {
      title: 'Create Maintenance',
      description: 'Schedules a new maintenance window. During maintenance, the monitors in monitorIDs are suppressed and show MAINTENANCE status instead of DOWN. A window created without monitorIDs suppresses nothing. Use strategy "manual" for a window you switch on and off with resumeMaintenance / pauseMaintenance.',
      inputSchema: {
        title: z.string().describe('Title of the maintenance window'),
        strategy: z.enum(MAINTENANCE_STRATEGIES)
          .describe('Scheduling strategy: single=one-time, recurring-interval=every N days, recurring-weekday=specific weekdays, recurring-day-of-month=specific dates, cron=starts on a cron expression and lasts durationMinutes, manual=on whenever active'),
        active: z.boolean().optional().describe('Whether the window is active (default: true). For a manual window, active means in maintenance right now.'),
        ...maintenanceScheduleFields,
      },
      outputSchema: {
        ok: z.boolean(),
        maintenanceID: z.number().optional(),
        monitorIDs: z.array(z.number()).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ monitorIDs, ...input }) => {
      await authenticateClient();

      try {
        const response = await client.createMaintenance(toKumaMaintenance(input));
        const maintenanceID = response.maintenanceID;
        const structuredContent: Record<string, unknown> = { ok: response.ok, maintenanceID, msg: response.msg };
        let text = `Maintenance window created with ID ${maintenanceID}`;

        if (maintenanceID !== undefined) {
          const problems = [
            await verifyMaintenanceWrite(maintenanceID, input, 'created'),
            monitorIDs ? await setAndVerifyMaintenanceMonitors(maintenanceID, monitorIDs, 'created') : null,
          ].filter((p): p is string => p !== null);

          if (problems.length > 0) {
            return errorResult(
              `${problems.join('\n\n')}\n\nMaintenance window ${maintenanceID} EXISTS — do not create it again. ` +
                `Fix it with updateMaintenance, or remove it with deleteMaintenance ${maintenanceID}.`,
              text,
              structuredContent
            );
          }
        }

        if (monitorIDs && monitorIDs.length > 0) {
          structuredContent.monitorIDs = [...new Set(monitorIDs)].sort((a, b) => a - b);
          text += `, covering monitors ${(structuredContent.monitorIDs as number[]).join(', ')}.`;
        } else {
          text += '. It has no monitors, so it suppresses nothing — add them with updateMaintenance (monitorIDs).';
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create maintenance window: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateMaintenance',
    {
      title: 'Update Maintenance',
      description: 'Updates an existing maintenance window. Only the fields you provide are changed (the server merges them with the stored window). monitorIDs replaces the full monitor list. To switch a window on or off use pauseMaintenance / resumeMaintenance.',
      inputSchema: {
        maintenanceID: requiredId('The ID of the maintenance window to update'),
        title: z.string().optional().describe('Title of the maintenance window'),
        strategy: z.enum(MAINTENANCE_STRATEGIES).optional().describe('Scheduling strategy (see createMaintenance)'),
        ...maintenanceScheduleFields,
      },
      outputSchema: {
        ok: z.boolean(),
        maintenanceID: z.number(),
        monitorIDs: z.array(z.number()).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ maintenanceID, monitorIDs, ...rest }) => {
      await authenticateClient();

      try {
        const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        if (Object.keys(defined).length === 0 && monitorIDs === undefined) {
          throw new Error('Nothing to update — pass at least one field to change, or monitorIDs.');
        }

        await requireMaintenance(maintenanceID);
        const structuredContent: Record<string, unknown> = { ok: true, maintenanceID };
        const problems: string[] = [];

        if (Object.keys(defined).length > 0) {
          const existing = await client.fetchMaintenance(maintenanceID);
          // timezoneOption is the stored choice (null = follow the server); `timezone` in the
          // read model is the RESOLVED zone. Carrying `timezone` over would pin a window that
          // follows the server to whatever the server happens to use today.
          const current = {
            id: maintenanceID,
            title: existing.title,
            description: existing.description,
            strategy: existing.strategy,
            active: existing.active,
            intervalDay: existing.intervalDay,
            dateRange: existing.dateRange,
            timeRange: existing.timeRange,
            weekdays: existing.weekdays,
            daysOfMonth: existing.daysOfMonth,
            cron: existing.cron,
            durationMinutes: existing.durationMinutes,
            timezone: existing.timezoneOption ?? undefined,
          };
          const response = await client.editMaintenance(toKumaMaintenance({ ...current, ...defined }));
          structuredContent.msg = response.msg;
          const problem = await verifyMaintenanceWrite(maintenanceID, defined, 'saved');
          if (problem) problems.push(problem);
        }

        if (monitorIDs !== undefined) {
          const problem = await setAndVerifyMaintenanceMonitors(maintenanceID, monitorIDs, 'updated');
          if (problem) problems.push(problem);
          else structuredContent.monitorIDs = [...new Set(monitorIDs)].sort((a, b) => a - b);
        }

        const changed = [...Object.keys(defined), ...(monitorIDs !== undefined ? ['monitorIDs'] : [])];
        const text = `Maintenance window ${maintenanceID} updated (${changed.join(', ')}).`;
        if (problems.length > 0) {
          structuredContent.ok = false;
          return errorResult(problems.join('\n\n'), text, structuredContent);
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update maintenance window: ${errorMessage}`);
      }
    }
  );

  const registerMaintenanceToggle = (name: string, title: string, description: string, active: boolean) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          maintenanceID: requiredId(`The ID of the maintenance window to ${active ? 'resume' : 'pause'}`),
        },
        outputSchema: {
          ok: z.boolean(),
          maintenanceID: z.number(),
          active: z.boolean(),
          msg: z.string().optional(),
        },
      },
      async ({ maintenanceID }) => {
        await authenticateClient();

        try {
          await requireMaintenance(maintenanceID);
          const response = active
            ? await client.resumeMaintenance(maintenanceID)
            : await client.pauseMaintenance(maintenanceID);
          const text = `Maintenance window ${maintenanceID} ${active ? 'resumed' : 'paused'}.`;
          const structuredContent = { ok: response.ok, maintenanceID, active, msg: response.msg };

          const problem = await verifyMaintenanceWrite(maintenanceID, { active }, active ? 'resumed' : 'paused');
          if (problem) return errorResult(problem, text, { ...structuredContent, ok: false });

          return {
            content: [{ type: 'text', text }],
            structuredContent,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          throw new McpError(ErrorCode.InternalError, `Failed to ${active ? 'resume' : 'pause'} maintenance window: ${errorMessage}`);
        }
      }
    );
  };

  registerMaintenanceToggle(
    'pauseMaintenance',
    'Pause Maintenance',
    'Switches a maintenance window off: it stops suppressing its monitors and its schedule stops until resumed. For a manual window this ends the maintenance.',
    false
  );

  registerMaintenanceToggle(
    'resumeMaintenance',
    'Resume Maintenance',
    'Switches a paused maintenance window back on. For a manual window this starts the maintenance immediately; a scheduled window resumes following its schedule.',
    true
  );

  server.registerTool(
    'deleteMaintenance',
    {
      title: 'Delete Maintenance',
      description: 'Permanently deletes a maintenance window. Its monitors return to normal alerting. Use getMaintenanceWindows to find the ID.',
      inputSchema: {
        maintenanceID: requiredId('The ID of the maintenance window to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ maintenanceID }) => {
      await authenticateClient();

      try {
        await requireMaintenance(maintenanceID);
        const response = await client.deleteMaintenance(maintenanceID);
        const text = `Maintenance window ${maintenanceID} deleted.`;

        const remaining = await client.refreshMaintenanceList();
        if (remaining.some((w) => w.id === maintenanceID)) {
          return errorResult(
            `Uptime Kuma acknowledged deleting maintenance window ${maintenanceID}, but it is still listed.`,
            text,
            { ok: false, msg: response.msg }
          );
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete maintenance window: ${errorMessage}`);
      }
    }
  );
}
