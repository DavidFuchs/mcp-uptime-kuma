import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { requiredId } from './schema.js';
import { IncidentSchema, INCIDENT_STYLES, type Incident } from '../types/index.js';

/** How many history pages updateIncident reads looking for an incident: 10 incidents each. */
const MAX_HISTORY_PAGES = 100;

/** Uptime Kuma's own wording for a missing page, made actionable. */
function explain(message: string, slug: string): string {
  return /slug is not found/i.test(message)
    ? `No status page with slug "${slug}" — call listStatusPages to see the slugs`
    : message;
}

/** The incident tools: the banners a status page shows while something is wrong. */
export function registerIncidentTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  const slugParam = z.string().describe('The status page slug. Find slugs with listStatusPages.');
  const style = z
    .enum(INCIDENT_STYLES)
    .describe('Banner color: primary (blue), info, warning (yellow), danger (red), light or dark');

  /**
   * Finds one incident by paging through the history, newest first. Uptime Kuma has no call
   * that reads a single incident, and editIncident needs the stored title, content and style
   * to change only some of them.
   */
  const findIncident = async (slug: string, incidentID: number): Promise<Incident> => {
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const response = await client.getIncidentHistory(slug, cursor);
      const found = (response.incidents ?? []).find((i) => i.id === incidentID);
      if (found) return found;
      if (!response.hasMore || !response.nextCursor) break;
      cursor = response.nextCursor;
    }
    throw new Error(
      `Incident ${incidentID} not found on status page "${slug}" — call listIncidents to see its incidents`
    );
  };

  server.registerTool(
    'listIncidents',
    {
      title: 'List Incidents',
      description:
        "Returns a status page's incidents, newest first, 10 per call, resolved ones included; pass nextCursor back as cursor for the next 10. An incident shows on the page while it is both pinned and active. getStatusPage also returns the ones showing now.",
      inputSchema: {
        slug: slugParam,
        cursor: z.string().optional().describe('nextCursor from the previous call, for the next page'),
      },
      outputSchema: {
        incidents: z.array(IncidentSchema),
        total: z.number().describe('Incidents on this page in all'),
        nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null on the last'),
        hasMore: z.boolean(),
      },
    },
    async ({ slug, cursor }) => {
      await authenticateClient();

      try {
        const response = await client.getIncidentHistory(slug, cursor);
        const result = {
          incidents: response.incidents ?? [],
          total: response.total ?? 0,
          nextCursor: response.nextCursor ?? null,
          hasMore: response.hasMore ?? false,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list incidents: ${explain(message, slug)}`);
      }
    }
  );

  server.registerTool(
    'createIncident',
    {
      title: 'Create Incident',
      description:
        'Posts an incident banner on a status page, for example "API degraded". It shows on the page at once, pinned and active, alongside any other active incidents. Follow up with updateIncident as things change, and resolveIncident when it is over.',
      inputSchema: {
        slug: slugParam,
        title: z.string().trim().min(1).describe('Headline of the banner'),
        content: z.string().trim().min(1).describe('Body of the banner, in Markdown'),
        style: style
          .optional()
          .describe('Banner color (default: primary). primary, info, warning, danger, light or dark'),
      },
      outputSchema: {
        ok: z.boolean(),
        incident: IncidentSchema.optional(),
      },
    },
    async ({ slug, title, content, style }) => {
      await authenticateClient();

      try {
        const response = await client.postIncident(slug, { title, content, style: style ?? 'primary' });
        return {
          content: [
            { type: 'text', text: `Incident ${response.incident?.id} posted on status page "${slug}": ${title}` },
          ],
          structuredContent: { ok: response.ok, incident: response.incident },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create incident: ${explain(message, slug)}`);
      }
    }
  );

  server.registerTool(
    'updateIncident',
    {
      title: 'Update Incident',
      description:
        'Changes an incident banner. Only the fields you pass change. pinned: false takes it off the page without resolving it; to end an incident use resolveIncident. Find the ID with listIncidents or getStatusPage.',
      inputSchema: {
        slug: slugParam,
        incidentID: requiredId('The ID of the incident to change'),
        title: z.string().trim().min(1).optional().describe('New headline'),
        content: z.string().trim().min(1).optional().describe('New body, in Markdown'),
        style: style.optional(),
        pinned: z.boolean().optional().describe('false takes the banner off the page; true puts it back'),
      },
      outputSchema: {
        ok: z.boolean(),
        incident: IncidentSchema.optional(),
        msg: z.string().optional(),
      },
    },
    async ({ slug, incidentID, title, content, style, pinned }) => {
      await authenticateClient();

      try {
        if ([title, content, style, pinned].every((v) => v === undefined)) {
          throw new Error('nothing to change — pass title, content, style or pinned');
        }
        // editIncident writes title, content and style from what it is sent, so the ones the
        // caller left out come from the stored incident.
        const existing = await findIncident(slug, incidentID);
        const response = await client.editIncident(slug, incidentID, {
          title: title ?? existing.title,
          content: content ?? existing.content,
          style: style ?? existing.style,
          pin: pinned ?? existing.pin,
        });
        return {
          content: [{ type: 'text', text: `Incident ${incidentID} on status page "${slug}" updated.` }],
          structuredContent: { ok: response.ok, incident: response.incident, msg: response.msg },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update incident: ${explain(message, slug)}`);
      }
    }
  );

  server.registerTool(
    'resolveIncident',
    {
      title: 'Resolve Incident',
      description:
        'Marks an incident as over: it leaves the status page but stays in listIncidents. To remove it from the history too, use deleteIncident. Find the ID with listIncidents or getStatusPage.',
      inputSchema: {
        slug: slugParam,
        incidentID: requiredId('The ID of the incident to resolve'),
      },
      outputSchema: {
        ok: z.boolean(),
        incident: IncidentSchema.optional(),
      },
    },
    async ({ slug, incidentID }) => {
      await authenticateClient();

      try {
        const response = await client.resolveIncident(slug, incidentID);
        return {
          content: [{ type: 'text', text: `Incident ${incidentID} on status page "${slug}" resolved.` }],
          structuredContent: { ok: response.ok, incident: response.incident },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to resolve incident: ${explain(message, slug)}`);
      }
    }
  );

  server.registerTool(
    'deleteIncident',
    {
      title: 'Delete Incident',
      description:
        'Permanently deletes an incident from a status page and its history. To end an incident but keep its record, use resolveIncident. Find the ID with listIncidents.',
      inputSchema: {
        slug: slugParam,
        incidentID: requiredId('The ID of the incident to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug, incidentID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteIncident(slug, incidentID);
        return {
          content: [{ type: 'text', text: `Incident ${incidentID} deleted from status page "${slug}".` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete incident: ${explain(message, slug)}`);
      }
    }
  );
}
