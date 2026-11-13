import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { StatusPageSchema } from '../types/index.js';

/**
 * The config to send to saveStatusPage: the caller's changes over the stored page (Uptime
 * Kuma's StatusPage.toJSON()), in the shape the handler checks.
 *
 * - slug is always set: the handler reads config.slug, not its own slug argument.
 * - logo: the handler stores config.logo as the icon, while toJSON returns it as `icon`.
 * - analyticsType must be null or a known provider, so a missing or empty one becomes null
 *   (an unknown provider is left for Uptime Kuma to refuse by name).
 * - domainNameList must be an array.
 */
export function mergeStatusPageConfig(
  slug: string,
  stored: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored, ...changes, slug };
  merged.logo = changes.logo ?? changes.icon ?? stored.icon;
  if (merged.analyticsType === undefined || merged.analyticsType === '') merged.analyticsType = null;
  const domains = merged.domainNameList;
  merged.domainNameList = Array.isArray(domains) ? domains : typeof domains === 'string' && domains ? [domains] : [];
  return merged;
}

/** The groups a status page has now, in the shape saveStatusPage takes, so they survive a save. */
function keepGroups(groups: unknown[]): Array<Record<string, unknown>> {
  return groups.map((raw) => {
    const g = raw as Record<string, unknown>;
    const monitors = Array.isArray(g.monitorList) ? (g.monitorList as Array<Record<string, unknown>>) : [];
    return {
      id: g.id,
      name: g.name,
      monitorList: monitors.map((m) => ({
        id: m.id,
        ...(m.sendUrl !== undefined ? { sendUrl: m.sendUrl } : {}),
        ...(m.url !== undefined ? { url: m.url } : {}),
      })),
    };
  });
}

/** The status page tools. */
export function registerStatusPageTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  server.registerTool(
    'listStatusPages',
    {
      title: 'List Status Pages',
      description:
        'Returns all configured status pages with their slug, title, visibility, and custom domain settings. Uptime Kuma only sends this list when a client logs in, so a page created or deleted by another client (or the web UI) since then may be missing or still listed; changes made through this server are reflected at once. getStatusPage with a slug always reads the page fresh.',
      inputSchema: {},
      outputSchema: {
        statusPages: z.array(StatusPageSchema).describe('Array of status page configurations'),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const statusPages = client.getStatusPageList();
        return {
          content: [{ type: 'text', text: JSON.stringify(statusPages) }],
          structuredContent: { statusPages, count: statusPages.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list status pages: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'getStatusPage',
    {
      title: 'Get Status Page',
      description:
        'Returns the full configuration of a status page by slug, including the ordered list of groups, the monitors inside each group, and active incidents. Works for unpublished pages too.',
      inputSchema: {
        slug: z.string().describe('The status page slug (the URL-safe identifier)'),
      },
      outputSchema: {
        ok: z.boolean(),
        config: StatusPageSchema.optional(),
        publicGroupList: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('Ordered groups with their monitorList'),
        incidents: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('Active incidents on the status page'),
        msg: z.string().optional(),
      },
    },
    async ({ slug }) => {
      await authenticateClient();

      try {
        const response = await client.getStatusPage(slug);
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: {
            ok: response.ok,
            config: response.config,
            publicGroupList: response.publicGroupList as Array<Record<string, unknown>> | undefined,
            incidents: response.incidents as Array<Record<string, unknown>> | undefined,
            msg: response.msg,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to get status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createStatusPage',
    {
      title: 'Create Status Page',
      description:
        'Creates a new (empty) status page with the given title and slug. After creating, call updateStatusPage to set the description, theme, groups, and monitors. Slug must be lowercase letters, digits, and dashes only.',
      inputSchema: {
        title: z.string().describe('Display title of the status page'),
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .describe('URL slug (lowercase letters, digits, and dashes only)'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ title, slug }) => {
      await authenticateClient();

      try {
        const response = await client.createStatusPage(title, slug);
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} created` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to create status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateStatusPage',
    {
      title: 'Update Status Page',
      description:
        "Updates an existing status page. config holds only the settings to change; everything else keeps its stored value. publicGroupList, when given, replaces all of the page's groups (a group not in it is deleted; include a group's id to keep it rather than recreate it); omit it to keep the groups as they are. Each group has a name and a monitorList of [{id}]. Use getStatusPage first to read current state before modifying.",
      inputSchema: {
        slug: z.string().describe('The status page slug (immutable identifier)'),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'The settings to change, merged onto the stored page: title, description, theme, published, showTags, showPoweredBy, domainNameList, customCSS, footerText, icon, etc. Omit to change only the groups.'
          ),
        publicGroupList: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Ordered groups, replacing all current ones. Each: {id?, name, monitorList: [{id}]}. Omit to keep the current groups.'
          ),
        imgDataUrl: z.string().optional().describe('Icon as data URL. Omit or pass empty string to keep existing.'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug, config, publicGroupList, imgDataUrl }) => {
      await authenticateClient();

      try {
        // Uptime Kuma's saveStatusPage replaces every field from config and every group from the
        // list, so a partial update has to be merged onto the stored page here.
        let stored: Record<string, unknown>;
        try {
          stored = await client.getStatusPageConfig(slug);
        } catch (e) {
          throw new Error(
            `status page "${slug}" not found (${e instanceof Error ? e.message : String(e)}). listStatusPages shows the slugs.`,
            { cause: e }
          );
        }
        const merged = mergeStatusPageConfig(slug, stored, config ?? {});

        let groups: Array<Record<string, unknown>>;
        if (publicGroupList) {
          groups = publicGroupList.map((g) => ({
            ...g,
            monitorList: Array.isArray(g.monitorList) ? g.monitorList : [],
          }));
        } else {
          let current: Awaited<ReturnType<typeof client.getStatusPage>>;
          try {
            current = await client.getStatusPage(slug);
          } catch (e) {
            throw new Error(
              `could not read the current groups of "${slug}" to keep them (${e instanceof Error ? e.message : String(e)}). ` +
                'Pass publicGroupList with every group the page should have: Uptime Kuma deletes the groups that are not in it.',
              { cause: e }
            );
          }
          groups = keepGroups(current.publicGroupList ?? []);
        }

        const response = await client.updateStatusPage(slug, merged, groups, imgDataUrl ?? '');
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} updated` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update status page: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteStatusPage',
    {
      title: 'Delete Status Page',
      description: 'Permanently deletes a status page by slug. The status page URL will no longer be accessible.',
      inputSchema: {
        slug: z.string().describe('The status page slug to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ slug }) => {
      await authenticateClient();

      try {
        const response = await client.deleteStatusPage(slug);
        return {
          content: [{ type: 'text', text: response.msg || `Status page ${slug} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete status page: ${errorMessage}`);
      }
    }
  );
}
