#!/usr/bin/env node

import { io, Socket } from 'socket.io-client';
import type { LoginResponse } from './types/index.js';
import { parseExtraHeaders } from './extra-headers.js';

/**
 * Simple utility to login to Uptime Kuma and retrieve a JWT token
 * Usage: mcp-uptime-kuma-get-jwt <url> <username> <password> [2fa-token]
 */

interface LoginData {
  username: string;
  password: string;
  token?: string;
}

function showHelp() {
  console.log(`Usage: mcp-uptime-kuma-get-jwt <url> <username> <password> [2fa-token]

Arguments:
  url          Uptime Kuma server URL (e.g., http://localhost:3001)
  username     Username for authentication
  password     Password for authentication
  2fa-token    Optional 2FA token if required

Examples:
  mcp-uptime-kuma-get-jwt http://localhost:3001 admin mypassword
  mcp-uptime-kuma-get-jwt http://localhost:3001 admin mypassword 123456

Environment variables:
  UPTIME_KUMA_HEADERS  JSON object of extra HTTP headers to send, for reaching Uptime Kuma
                       through an authenticating proxy, e.g.
                       '{"CF-Access-Client-Id":"<id>","CF-Access-Client-Secret":"<secret>"}'

The JWT token will be printed to stdout on success.
`);
}

async function getJwtToken(
  url: string,
  username: string,
  password: string,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = io(url, {
      reconnection: false,
      extraHeaders,
    });

    socket.on('connect', () => {
      const loginData: LoginData = {
        username,
        password,
      };

      if (token) {
        loginData.token = token;
      }

      socket.emit('login', loginData, (response: LoginResponse) => {
        if (response.ok && response.token) {
          socket.disconnect();
          resolve(response.token);
        } else if (response.ok && response.tokenRequired) {
          socket.disconnect();
          reject(new Error('2FA token is required but was not provided'));
        } else {
          socket.disconnect();
          reject(new Error(response.msg || 'Login failed'));
        }
      });
    });

    socket.on('connect_error', (error: Error) => {
      socket.disconnect();
      reject(new Error(`Connection failed: ${error.message}`));
    });

    socket.on('error', (error: Error) => {
      socket.disconnect();
      reject(new Error(`Socket error: ${error.message}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  // Validate arguments
  if (args.length < 3) {
    console.error('Error: Missing required arguments\n');
    showHelp();
    process.exit(1);
  }

  const [url, username, password, token] = args;

  try {
    const extraHeaders = parseExtraHeaders(process.env.UPTIME_KUMA_HEADERS);
    const jwtToken = await getJwtToken(url, username, password, token, extraHeaders);
    console.log(jwtToken);
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
