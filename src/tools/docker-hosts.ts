import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { DockerHostSchema } from '../types/index.js';
import { redactSecrets, rehydrateUrlCredentials } from '../redact.js';
import { requiredId } from './schema.js';
import { HOST_CHANGED_MARKER_ERROR } from '../monitors/fields.js';

/** The docker host tools. */
export function registerDockerHostTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam } = ctx;

  server.registerTool(
    'listDockerHosts',
    {
      title: 'List Docker Hosts',
      description: 'Returns all docker daemon connections configured in Uptime Kuma. These are referenced by docker container monitors via docker_host.',
      inputSchema: {
        includeSecrets: includeSecretsParam
      },
      outputSchema: {
        dockerHosts: z.array(DockerHostSchema).describe('Array of docker host configurations. Any credentials embedded in a dockerDaemon URL read "***" unless includeSecrets is set.'),
        count: z.number(),
      },
    },
    async ({ includeSecrets }) => {
      await authenticateClient();

      try {
        const raw = client.getDockerHostList();
        // A TCP dockerDaemon can be http://user:pass@host:2375 — the field name gives no
        // hint of that, so the URL scrub in redactSecrets is what catches it.
        const dockerHosts = wantsSecrets(includeSecrets) ? raw : raw.map((h) => redactSecrets(h));
        return {
          content: [{ type: 'text', text: JSON.stringify(dockerHosts) }],
          structuredContent: { dockerHosts, count: dockerHosts.length },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to list docker hosts: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'addDockerHost',
    {
      title: 'Add Docker Host',
      description: 'Creates a new docker daemon connection. For a unix socket use dockerType="socket" and dockerDaemon="/var/run/docker.sock". For a TCP proxy (e.g. tecnativa/docker-socket-proxy) use dockerType="tcp" and dockerDaemon="http://host:2375". Consider calling testDockerHost first to verify reachability.',
      inputSchema: {
        name: z.string().describe('Human-readable name for this docker host'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z.string().describe('Unix socket path (e.g. /var/run/docker.sock) when dockerType=socket, or TCP URL (e.g. http://docker-proxy:2375) when dockerType=tcp'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        const response = await client.addDockerHost({ name, dockerType, dockerDaemon });
        return {
          content: [{ type: 'text', text: response.msg || `Docker host created with ID ${response.id}` }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to add docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'updateDockerHost',
    {
      title: 'Update Docker Host',
      description: 'Updates an existing docker daemon connection. Use listDockerHosts to find the docker host ID. Only the fields you pass are changed — the others are preserved.',
      inputSchema: {
        dockerHostID: requiredId('The ID of the docker host to update'),
        name: z.string().optional().describe('New human-readable name'),
        dockerType: z.enum(['socket', 'tcp']).optional().describe('New connection type'),
        dockerDaemon: z.string().optional().describe('New socket path or TCP URL'),
      },
      outputSchema: {
        ok: z.boolean(),
        id: z.number().optional(),
        msg: z.string().optional(),
      },
    },
    async ({ dockerHostID, name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        // Merge new values onto the current record so callers can omit unchanged fields.
        // Uptime Kuma's addDockerHost handler overwrites every column it receives, so we
        // need to send the full set to avoid clobbering existing values with undefined.
        const existing = client.getDockerHostList().find(h => h.id === dockerHostID);
        if (!existing) {
          throw new Error(`Docker host ${dockerHostID} not found — call listDockerHosts to see available IDs`);
        }

        const merged: Record<string, unknown> = {
          name: name ?? existing.name,
          dockerType: dockerType ?? existing.dockerType,
          dockerDaemon: dockerDaemon ?? existing.dockerDaemon,
        };

        // Issue #59: listDockerHosts scrubs inline URL credentials to "***:***@host", and a
        // dockerDaemon TCP URL is written back here wholesale. The read-edit-write loop an agent
        // performs would otherwise persist those markers over the real credentials. Restore them
        // from the stored URL. The marker sits inside the URL userinfo, not as a bare "***", so
        // rehydrateSecrets cannot catch it — rehydrateUrlCredentials is its URL-shaped counterpart.
        // Only reached when the caller passed dockerDaemon; omitting it already keeps the stored URL.
        let preservedCreds = false;
        if (dockerDaemon !== undefined) {
          const restored = rehydrateUrlCredentials(dockerDaemon, existing.dockerDaemon);
          if (restored.hostChanged) {
            throw new Error(HOST_CHANGED_MARKER_ERROR('dockerDaemon', 'call listDockerHosts with includeSecrets'));
          }
          if (restored.missing) {
            throw new Error(
              'Cannot write the redaction marker "***" into dockerDaemon — the docker host has no ' +
              'stored credential to restore, so this would save an endpoint that looks authenticated ' +
              'and cannot connect. Pass the real URL, or call listDockerHosts with includeSecrets to ' +
              'read the current one.'
            );
          }
          merged.dockerDaemon = restored.value;
          preservedCreds = restored.preserved;
        }

        const response = await client.addDockerHost(merged, dockerHostID);
        let text = response.msg || `Docker host ${dockerHostID} updated`;
        if (preservedCreds) {
          text += '\n\nKept the existing credentials embedded in dockerDaemon — "***" was sent, ' +
            'which is the redaction marker, not a credential.';
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: response.ok, id: response.id, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to update docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'deleteDockerHost',
    {
      title: 'Delete Docker Host',
      description: 'Permanently deletes a docker daemon connection. Any monitors referencing it will have their docker_host cleared by Uptime Kuma (the monitors themselves are not deleted).',
      inputSchema: {
        dockerHostID: requiredId('The ID of the docker host to delete'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ dockerHostID }) => {
      await authenticateClient();

      try {
        const response = await client.deleteDockerHost(dockerHostID);
        return {
          content: [{ type: 'text', text: response.msg || `Docker host ${dockerHostID} deleted` }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to delete docker host: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    'testDockerHost',
    {
      title: 'Test Docker Host',
      description: 'Tests connectivity to a docker daemon without persisting it. On success the message includes the number of containers. Use this before addDockerHost to avoid saving a broken configuration.',
      inputSchema: {
        name: z.string().describe('Display name (used only in the test request)'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z.string().describe('Unix socket path or TCP URL to probe'),
      },
      outputSchema: {
        ok: z.boolean(),
        msg: z.string().optional(),
      },
    },
    async ({ name, dockerType, dockerDaemon }) => {
      await authenticateClient();

      try {
        const response = await client.testDockerHost({ name, dockerType, dockerDaemon });
        return {
          content: [{ type: 'text', text: response.msg || (response.ok ? 'Docker host reachable' : 'Docker host unreachable') }],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to test docker host: ${errorMessage}`);
      }
    }
  );
}
