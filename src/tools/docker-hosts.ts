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
      description:
        'Returns the Docker daemon connections configured in Uptime Kuma. A docker monitor refers to one by ID in its docker_host field. Credentials embedded in a dockerDaemon URL read "***" unless includeSecrets is set.',
      inputSchema: {
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        dockerHosts: z
          .array(DockerHostSchema)
          .describe(
            'Array of docker host configurations. Any credentials embedded in a dockerDaemon URL read "***" unless includeSecrets is set.'
          ),
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
    'createDockerHost',
    {
      title: 'Create Docker Host',
      description:
        'Creates a Docker daemon connection; docker monitors take the returned ID in their docker_host field. Pass dockerType "socket" with a socket path, or "tcp" with a URL such as http://host:2375 (for example a docker-socket-proxy). The connection is saved without being checked, so call testDockerHost first. To change one use updateDockerHost.',
      inputSchema: {
        name: z.string().describe('Human-readable name for this docker host'),
        dockerType: z.enum(['socket', 'tcp']).describe('"socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
        dockerDaemon: z
          .string()
          .describe(
            'Unix socket path (e.g. /var/run/docker.sock) when dockerType=socket, or TCP URL (e.g. http://docker-proxy:2375) when dockerType=tcp'
          ),
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
      description:
        'Updates an existing Docker daemon connection. Only the fields you pass change. Credentials in a dockerDaemon URL sent back as "***" keep their stored value. Check a new address with testDockerHost first. Find the ID with listDockerHosts.',
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
        const existing = client.getDockerHostList().find((h) => h.id === dockerHostID);
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
          text +=
            '\n\nKept the existing credentials embedded in dockerDaemon — "***" was sent, ' +
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
      description:
        'Permanently deletes a Docker daemon connection. Monitors that referenced it are kept, but their docker_host is cleared, so they stop working until given another. Find the ID with listDockerHosts.',
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
      description:
        'Tests whether Uptime Kuma can reach a Docker daemon, without saving anything. On success the message gives the number of containers. Use it before createDockerHost or updateDockerHost.',
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
          content: [
            { type: 'text', text: response.msg || (response.ok ? 'Docker host reachable' : 'Docker host unreachable') },
          ],
          structuredContent: { ok: response.ok, msg: response.msg },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new McpError(ErrorCode.InternalError, `Failed to test docker host: ${errorMessage}`);
      }
    }
  );
}
