import { io, Socket } from 'socket.io-client';
import { fileURLToPath } from 'url';
import { loadTestConfig, TestConfig } from './helpers.js';

/**
 * Makes sure the test Uptime Kuma instance has an admin account that the credentials in
 * .env.test can log in to, so the integration suite can run without anyone at the keyboard.
 *
 * - A fresh instance (no account yet) gets its admin account created from .env.test, using
 *   the same `setup` socket event the web UI's first-run page sends.
 * - An instance that already has an account is left alone; the credentials are only checked.
 *
 * Usage: npx tsx test/integration/ensure-admin.ts
 * Exits 0 when the credentials work, 1 with a reason when they do not.
 */

const TIMEOUT_MS = 15_000;

type Ack = { ok: boolean; msg?: string };

export type EnsureAdminResult = 'created' | 'verified';

function connect(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { reconnection: false, timeout: TIMEOUT_MS });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(new Error(`Could not connect to Uptime Kuma at ${url}: ${error.message}`));
    });
  });
}

function emit<T>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(TIMEOUT_MS).emit(event, ...args, (error: Error | null, response: T) => {
      if (error) reject(new Error(`Uptime Kuma did not answer "${event}" within ${TIMEOUT_MS / 1000}s`));
      else resolve(response);
    });
  });
}

export async function ensureAdmin(config: TestConfig): Promise<EnsureAdminResult> {
  const socket = await connect(config.url);
  try {
    let result: EnsureAdminResult = 'verified';

    if (await emit<boolean>(socket, 'needSetup')) {
      if (!config.username || !config.password) {
        throw new Error(
          'This Uptime Kuma instance has no admin account yet. Set UPTIME_KUMA_USERNAME and ' +
          'UPTIME_KUMA_PASSWORD in .env.test so one can be created.',
        );
      }
      const setup = await emit<Ack>(socket, 'setup', config.username, config.password);
      if (!setup.ok) {
        const hint = setup.msg === 'passwordTooWeak'
          ? ' Uptime Kuma rejected UPTIME_KUMA_PASSWORD as too weak: use at least 6 characters with both letters and numbers.'
          : '';
        throw new Error(`Could not create the admin account: ${setup.msg}.${hint}`);
      }
      result = 'created';
    }

    // Token auth is checked only when it is what the tests will use (no username configured),
    // matching the order createTestClient hands credentials to the server.
    const login = config.username
      ? await emit<Ack>(socket, 'login', { username: config.username, password: config.password, token: '' })
      : config.jwtToken
        ? await emit<Ack>(socket, 'loginByToken', config.jwtToken)
        : { ok: false, msg: 'neither UPTIME_KUMA_USERNAME nor UPTIME_KUMA_JWT_TOKEN is set in .env.test' };

    if (!login.ok) {
      throw new Error(
        `The credentials in .env.test were rejected by ${config.url}: ${login.msg}. ` +
        'The instance already has an admin account, so .env.test has to match it.',
      );
    }
    return result;
  } finally {
    socket.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadTestConfig();
  ensureAdmin(config).then(
    (result) => {
      console.log(result === 'created'
        ? `✅ Created admin account "${config.username}" on the fresh Uptime Kuma instance`
        : '✅ Credentials in .env.test work');
      process.exit(0);
    },
    (error: Error) => {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    },
  );
}
