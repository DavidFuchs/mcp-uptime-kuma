import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { requiredId } from './schema.js';

/** The tag tools. */
export function registerTagTools(ctx: ToolContext): void {
  const { server, client, authenticateClient } = ctx;

  server.registerTool(
    'listTags',
    {
      title: 'List Tags',
      description:
        'Returns every tag defined in Uptime Kuma with its ID, name and color. To see which monitors carry a tag, filter listMonitors or getMonitorSummary by tag name.',
      inputSchema: {},
      outputSchema: {
        tags: z
          .array(
            z.object({
              id: z.number(),
              name: z.string(),
              color: z.string(),
            })
          )
          .describe('Array of tags'),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();

      try {
        const tags = await client.getTagList();
        return {
          content: [{ type: 'text', text: JSON.stringify(tags) }],
          structuredContent: { tags, count: tags.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list tags: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'createTag',
    {
      title: 'Create Tag',
      description:
        'Creates a tag with a name and a color. Tags are attached to monitors with the tags argument of createMonitor / updateMonitor, which also creates a tag that does not exist yet, so this is only needed to define a tag ahead of use. Names are not unique: check listTags first to avoid a duplicate. To rename or recolor a tag use updateTag; to remove one, deleteTag.',
      inputSchema: {
        name: z.string().describe('Tag name'),
        color: z.string().describe('Tag color as a hex string (e.g. "#ff0000") or CSS color name'),
      },
      outputSchema: {
        ok: z.boolean(),
        tag: z.object({ id: z.number(), name: z.string(), color: z.string() }).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, color }) => {
      await authenticateClient();

      try {
        const response = await client.addTag(name, color);
        return {
          content: [{ type: 'text', text: `Tag "${name}" created with ID ${response.tag?.id}` }],
          structuredContent: { ok: response.ok, tag: response.tag, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add tag: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateTag',
    {
      title: 'Update Tag',
      description:
        'Renames or recolors an existing tag. Pass name, color or both; whichever you omit keeps its current value. The change shows on every monitor that carries the tag. Find the ID with listTags; to add a tag use createTag.',
      inputSchema: {
        tagID: requiredId('The ID of the tag to update'),
        name: z.string().optional().describe('New tag name. Omit to keep the current one.'),
        color: z
          .string()
          .optional()
          .describe('New tag color as a hex string (e.g. "#ff0000") or CSS color name. Omit to keep the current one.'),
      },
      outputSchema: {
        ok: z.boolean(),
        tag: z.object({ id: z.number(), name: z.string(), color: z.string() }).optional(),
        msg: z.string().optional(),
      },
    },
    async ({ tagID, name, color }) => {
      await authenticateClient();

      try {
        if (name === undefined && color === undefined) {
          throw new Error('nothing to change — pass name, color, or both');
        }

        // Uptime Kuma's editTag writes both columns from what it is sent, so an omitted field
        // has to be filled in from the stored tag rather than left to be blanked.
        const existing = (await client.getTagList()).find((t) => t.id === tagID);
        if (!existing) {
          throw new Error(`Tag ${tagID} not found — call listTags to see available IDs`);
        }

        const response = await client.editTag(tagID, name ?? existing.name, color ?? existing.color);
        const tag = response.tag ?? { id: tagID, name: name ?? existing.name, color: color ?? existing.color };
        return {
          content: [{ type: 'text', text: `Tag ${tagID} updated: "${tag.name}" (${tag.color})` }],
          structuredContent: { ok: response.ok, tag, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update tag: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteTag',
    {
      title: 'Delete Tag',
      description:
        'Permanently deletes a tag and removes it from every monitor that carries it. An ID that does not exist still reports success. To rename or recolor a tag instead, use updateTag. Find the ID with listTags.',
      inputSchema: {
        tagID: requiredId('The ID of the tag to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ tagID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteTag(tagID);
        return {
          content: [{ type: 'text', text: response.msg || `Tag ${tagID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete tag: ${errorMessage}`);
      }
    }
  );
}
