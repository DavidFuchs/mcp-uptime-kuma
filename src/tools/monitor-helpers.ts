import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import fuzzysort from 'fuzzysort';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { numeric, requiredId } from './schema.js';
import { pushURLFor } from '../monitors/rules.js';
import { SECRET_MARKER } from '../redact.js';
import type { GameDigGame } from '../types/index.js';

/** The languages Uptime Kuma 2.5.11 ships push examples for (extra/push-examples). */
export const PUSH_EXAMPLE_LANGUAGES = [
  'bash-curl',
  'csharp',
  'docker',
  'go',
  'java',
  'javascript-fetch',
  'php',
  'powershell',
  'python',
  'typescript-fetch',
] as const;

/** The placeholders in every push example, which Uptime Kuma's web UI replaces in the browser. */
const EXAMPLE_PUSH_URL = 'https://example.com/api/push/key?status=up&msg=OK&ping=';
const EXAMPLE_INTERVAL = '60';

/**
 * A push example made specific to one monitor, the way Uptime Kuma's monitor page does it. The
 * interval goes first, as there: the push URL put in afterwards may itself contain "60".
 */
export function fillPushExample(code: string, pushURL: string, interval: number): string {
  return code.replace(EXAMPLE_INTERVAL, () => String(interval)).replace(EXAMPLE_PUSH_URL, () => pushURL);
}

/**
 * The English of the refusals checkDomain answers with (Uptime Kuma's src/lang/en.json), which
 * arrive as translation keys with their placeholders' values in meta.
 */
const DOMAIN_REFUSALS: Record<string, string> = {
  domain_expiry_unsupported_monitor_type: 'Domain expiry monitoring is not supported for this monitor type',
  domain_expiry_unsupported_missing_target: 'No valid domain or hostname is configured for this monitor',
  domain_expiry_unsupported_is_icann:
    'The domain "{domain}" is not a candidate for domain expiry monitoring, because its public suffix ".{publicSuffix}" is not managed by ICANN',
  domain_expiry_unsupported_unsupported_tld_no_rdap_endpoint:
    'Domain expiry monitoring is not available for ".{publicSuffix}" because no RDAP service is listed by IANA',
};

export function describeDomainRefusal(key: string, meta: Record<string, unknown> = {}): string {
  const template = DOMAIN_REFUSALS[key];
  if (!template) return key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in meta ? String(meta[name]) : whole));
}

/** A game as the tool returns it: the ID the monitor's game field takes, and what goes with it. */
const toGame = (g: GameDigGame) => ({
  id: g.keys[0],
  name: g.pretty,
  ...(g.options?.port !== undefined && { defaultPort: g.options.port }),
  ...(g.options?.port_query !== undefined && { queryPort: g.options.port_query }),
  ...(g.extra?.doc_notes && { notes: g.extra.doc_notes }),
});

const MAX_GAMES = 100;

/**
 * The lookups Uptime Kuma's monitor form makes while a monitor is filled in: the games a
 * gamedig monitor can query, the PM2 processes, whether Chrome starts, push monitor sample code,
 * and whether a domain's registration expiry can be watched.
 */
export function registerMonitorHelperTools(ctx: ToolContext): void {
  const { server, client, authenticateClient, wantsSecrets, includeSecretsParam, kumaUrl } = ctx;

  const fail = (what: string, error: unknown): never => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpError(ErrorCode.InternalError, `Failed to ${what}: ${message}`);
  };

  // The list is GameDig's, so it only changes when Uptime Kuma is upgraded. Kept per server.
  let games: GameDigGame[] | undefined;

  server.registerTool(
    'listGames',
    {
      title: 'List Games',
      description:
        'Finds the GameDig ID a gamedig (game server) monitor needs in its game field, by game name or ID, e.g. "minecraft", "counter strike 2", "valheim". Returns each match\'s ID, name, default port and notes. Uptime Kuma does not check the ID when the monitor is saved, so look it up rather than guess.',
      inputSchema: {
        search: z
          .string()
          .trim()
          .optional()
          .describe('Part of the game name or ID; matched loosely. Omit to list games from the start.'),
        limit: numeric(z.number().int().min(1).max(MAX_GAMES))
          .optional()
          .describe(`How many to return (default: 20, up to ${MAX_GAMES})`),
      },
      outputSchema: {
        games: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            defaultPort: z.number().optional(),
            queryPort: z.number().optional(),
            notes: z.string().optional(),
          })
        ),
        count: z.number().describe('How many games matched, of which `games` holds the first `limit`'),
        total: z.number().describe('How many games GameDig supports'),
      },
    },
    async ({ search, limit }) => {
      await authenticateClient();
      try {
        games ??= await client.getGameList();
        const max = limit ?? 20;
        let matched: GameDigGame[] = games;
        if (search) {
          matched = fuzzysort
            .go(search, games, { keys: ['pretty', (g: GameDigGame) => g.keys.join(' ')], threshold: 0.3 })
            .map((r) => r.obj);
        }
        const result = { games: matched.slice(0, max).map(toGame), count: matched.length, total: games.length };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return fail('get the game list', error);
      }
    }
  );

  server.registerTool(
    'listPM2Processes',
    {
      title: 'List PM2 Processes',
      description:
        "Lists the PM2 processes on the Uptime Kuma host with their name, ID and status. A pm2 monitor names one, by name or ID, in typeFields.system_service_name. Fails if PM2 is not installed where Uptime Kuma runs (it isn't in Uptime Kuma's Docker image).",
      inputSchema: {},
      outputSchema: {
        processes: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
        count: z.number(),
      },
    },
    async () => {
      await authenticateClient();
      try {
        const processes = await client.getPM2ProcessList();
        return {
          content: [{ type: 'text', text: JSON.stringify(processes) }],
          structuredContent: { processes, count: processes.length },
        };
      } catch (error) {
        // Uptime Kuma runs `pm2 jlist`; ENOENT is the shell finding no pm2 to run.
        if (error instanceof Error && /\bENOENT\b/.test(error.message)) {
          return fail(
            'list the PM2 processes',
            new Error(
              `PM2 is not installed where Uptime Kuma runs, so pm2 monitors cannot work there (${error.message})`
            )
          );
        }
        return fail('list the PM2 processes', error);
      }
    }
  );

  server.registerTool(
    'testChrome',
    {
      title: 'Test Chrome',
      description:
        "Starts a Chrome or Chromium binary on the Uptime Kuma host and returns its version, to check that real-browser monitors without a remote browser can run. Defaults to the chromeExecutable setting those monitors use. With no path set, Uptime Kuma looks for one, and in its Docker image INSTALLS Chromium with apt when none is there, which can take minutes. Only paths on Uptime Kuma's own list of known Chrome locations are allowed, unless its host sets UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC=1. For a remote browser use testRemoteBrowser.",
      inputSchema: {
        executable: z
          .string()
          .optional()
          .describe(
            'Path of the binary to start, e.g. "/usr/bin/chromium". "" auto-detects; "#playwright_chromium" is the Chromium Playwright downloaded. Default: the chromeExecutable setting.'
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        executable: z.string().describe('What was tested; "" means auto-detected'),
        version: z.string().describe('The browser version Chrome reported'),
      },
    },
    async ({ executable }) => {
      await authenticateClient();
      try {
        let path = executable;
        if (path === undefined) {
          const stored = (await client.getSettings()).data?.chromeExecutable;
          path = typeof stored === 'string' ? stored : '';
        }
        const version = await client.testChrome(path);
        return {
          content: [{ type: 'text', text: `Chrome started: version ${version}${path ? ` (${path})` : ''}.` }],
          structuredContent: { ok: true, executable: path, version },
        };
      } catch (error) {
        return fail('start Chrome', error);
      }
    }
  );

  server.registerTool(
    'getPushExample',
    {
      title: 'Get Push Example',
      description: `Returns ready-to-run code that reports to a push monitor every interval, from Uptime Kuma's own samples, with the monitor's push URL and interval filled in. Use it after creating a push monitor, for the user's cron job or script. The push URL holds the monitor's token, a credential: it reads "***" (and the code will not work) unless includeSecrets is set.`,
      inputSchema: {
        monitorID: requiredId('The push monitor. Find IDs with listMonitors.'),
        language: z
          .string()
          .regex(/^[a-z-]+$/, 'lower-case letters and dashes, e.g. "python"')
          .optional()
          .describe(`One of ${PUSH_EXAMPLE_LANGUAGES.join(', ')} (default: bash-curl)`),
        includeSecrets: includeSecretsParam,
      },
      outputSchema: {
        monitorID: z.number(),
        language: z.string(),
        code: z.string(),
        pushURL: z.string(),
        interval: z.number().describe('Seconds between pushes, from the monitor'),
        note: z.string().describe('Where the host in the URL came from'),
      },
    },
    async ({ monitorID, language, includeSecrets }) => {
      await authenticateClient();
      try {
        const lang = language ?? 'bash-curl';
        const monitor = client.getMonitor(monitorID, true) as Record<string, unknown> | undefined;
        if (!monitor) throw new Error(`Monitor ${monitorID} not found — call listMonitors to see available IDs`);
        if (monitor.type !== 'push') {
          throw new Error(
            `monitor ${monitorID} is a ${String(monitor.type)} monitor; push examples are for push monitors`
          );
        }
        let token = monitor.pushToken;
        if (!token) token = (await client.fetchMonitor(monitorID)).pushToken;
        if (typeof token !== 'string' || !token) throw new Error(`push monitor ${monitorID} has no push token`);

        const shown = wantsSecrets(includeSecrets) ? token : SECRET_MARKER;
        const push = await pushURLFor(client, kumaUrl, shown);
        const interval = Number(monitor.interval) || 60;
        const code = fillPushExample(await client.getPushExample(lang), push.url, interval);

        const redactedNote =
          shown === SECRET_MARKER ? ' The token reads "***": call again with includeSecrets for code that runs.' : '';
        return {
          content: [
            {
              type: 'text',
              text: `${lang} push example for monitor ${monitorID}, every ${interval} s. ${push.note}${redactedNote}\n\n${code}`,
            },
          ],
          structuredContent: { monitorID, language: lang, code, pushURL: push.url, interval, note: push.note },
        };
      } catch (error) {
        return fail('get the push example', error);
      }
    }
  );

  server.registerTool(
    'checkDomainExpirySupport',
    {
      title: 'Check Domain Expiry Support',
      description:
        "Says whether Uptime Kuma can watch a domain's registration expiry (domainExpiryNotification), and which domain and top-level domain it would look up. Many top-level domains have no RDAP service and cannot be watched; check before switching the notification on, since Uptime Kuma accepts it either way. Pass a monitor's ID, or an address (a URL or a host name).",
      inputSchema: {
        monitorID: numeric(z.number().int().positive())
          .optional()
          .describe('A monitor whose address to check. Find IDs with listMonitors.'),
        address: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('A URL ("https://example.com/health") or host name ("db.example.com") to check instead'),
      },
      outputSchema: {
        supported: z.boolean(),
        domain: z.string().optional().describe('The registered domain Uptime Kuma would look up'),
        tld: z.string().optional(),
        reason: z.string().optional().describe('Why it cannot be watched'),
      },
    },
    async ({ monitorID, address }) => {
      await authenticateClient();
      try {
        if ((monitorID === undefined) === (address === undefined)) {
          throw new Error('pass either monitorID or address');
        }
        let partial: Record<string, unknown>;
        if (monitorID !== undefined) {
          const monitor = client.getMonitor(monitorID, true) as Record<string, unknown> | undefined;
          if (!monitor) throw new Error(`Monitor ${monitorID} not found — call listMonitors to see available IDs`);
          const { type, url, hostname, grpcUrl } = monitor;
          partial = { type, url, hostname, grpcUrl };
        } else {
          // Uptime Kuma reads the address from the field the type keeps it in: url for HTTP,
          // hostname for port and the like.
          partial = /^[a-z][a-z\d+.-]*:\/\//i.test(address!)
            ? { type: 'http', url: address }
            : { type: 'port', hostname: address };
        }

        const response = await client.checkDomain(partial);
        let result: { supported: boolean; domain?: string; tld?: string; reason?: string };
        if (response.ok) {
          result = { supported: true, domain: response.domain, tld: response.tld };
        } else if (response.msgi18n && typeof response.msg === 'string') {
          result = { supported: false, reason: describeDomainRefusal(response.msg, response.meta) };
        } else {
          throw new Error(response.msg || 'Uptime Kuma gave no answer');
        }
        const text = result.supported
          ? `Supported: Uptime Kuma would watch ${result.domain} (.${result.tld}).`
          : `Not supported: ${result.reason}.`;
        return { content: [{ type: 'text', text }], structuredContent: result };
      } catch (error) {
        return fail('check domain expiry support', error);
      }
    }
  );
}
