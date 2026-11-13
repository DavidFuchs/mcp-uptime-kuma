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
      description: 'Returns all tags defined in Uptime Kuma (name, color, and ID).',
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
    'addTag',
    {
      title: 'Add Tag',
      description: 'Creates a new tag that can be assigned to monitors.',
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
    'deleteTag',
    {
      title: 'Delete Tag',
      description:
        'Permanently deletes a tag. It will be removed from all monitors that use it. Use listTags to find the tag ID.',
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
