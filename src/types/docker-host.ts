import { z } from 'zod';

/**
 * Docker host (docker daemon connection) configuration schema
 * Used by monitors of type "docker" to specify which daemon to query.
 */
export const DockerHostSchema = z.object({
  id: z.number().optional().describe('Docker host ID (assigned by server)'),
  userID: z.number().optional().describe('Owner user ID (set by server)'),
  name: z.string().optional().describe('Human-readable name for this docker host'),
  dockerType: z.enum(['socket', 'tcp']).optional().describe('Connection type: "socket" for a unix socket path, "tcp" for an HTTP/HTTPS URL'),
  dockerDaemon: z.string().optional().describe('Unix socket path (e.g. /var/run/docker.sock) when dockerType=socket, or TCP URL (e.g. http://docker-proxy:2375) when dockerType=tcp'),
}).passthrough();

export type DockerHost = z.infer<typeof DockerHostSchema>;
