# Testing MCP Uptime Kuma

There are two kinds of tests:

| Kind | Where | Needs | Run with |
|---|---|---|---|
| Unit | `test/unit/` | Nothing | `npm test` |
| Integration | `test/integration/` | Docker | `npm run test:integration` |

Pull requests run the unit tests and the short integration suites in CI.

## Unit tests

```bash
npm test              # run once
npm run test:watch    # re-run on change
```

These use Vitest. Each test builds the MCP server in-process and replaces the Uptime Kuma
client with mocks, so no Uptime Kuma instance is involved.

## Integration tests

These start the MCP server as a child process over stdio, the same way an MCP client does,
and call its tools against a real Uptime Kuma instance.

**The tests create, edit and delete monitors, tags, maintenance windows and more. Only ever
point them at a dedicated test instance.**

### Running them

```bash
npm run test:integration
```

The runner needs no input, so it can be run by a script, an agent or CI. It:

1. Creates `test/integration/.env.test` from `.env.test.example` if there is none.
2. Starts Uptime Kuma in Docker on port 3001.
3. Checks that the credentials in `.env.test` can log in. On a fresh instance it first
   creates the admin account from them.
4. Runs the tests and stops the container.

The admin account lives in a Docker volume that the runner leaves in place, so later runs
reuse it.

To use your own username and password, edit `.env.test` before the first run. Uptime Kuma
wants a password of at least 6 characters with both letters and numbers.

If the instance already has an account that `.env.test` does not match, the runner says so.
In a terminal it waits for you to fix the file and press Enter. Without a terminal it exits
with an error.

### Short and long suites

```bash
npm run test:integration         # short suites
npm run test:integration:long    # short suites, then long suites
```

The long suites hold the tests that wait for Uptime Kuma to run real checks, for example
confirming that heartbeat history survives a monitor type change. The short suites never
wait on a check.

### Suites

| Suite | File | Kind |
|---|---|---|
| `settings` | `settings.test.ts` | short |
| `monitors` | `monitors.test.ts` | short |
| `heartbeats` | `heartbeats.test.ts` | short |
| `tags` | `tags.test.ts` | short |
| `maintenance` | `maintenance.test.ts` | short |
| `notifications` | `notifications.test.ts` | short |
| `docker-hosts` | `docker-hosts.test.ts` | short |
| `status-pages` | `status-pages.test.ts` | short |
| `strict-schema` | `strict-schema.test.ts` | short |
| `redaction` | `redaction.test.ts` | short |
| `startup` | `startup.test.ts` | short |
| `monitor-history` | `monitor-history.long.test.ts` | long |

Run chosen suites by name, short or long:

```bash
npm run test:integration -- --suite monitors
npm run test:integration -- --suite tags --suite monitor-history
```

### Running against an instance that is already up

`npm run test:integration` starts and stops the Docker container around every run. To skip
that, start the instance yourself and run the tests directly:

```bash
docker-compose -f test/integration/docker-compose.test.yml up -d

npm run test:integration:direct                         # short suites
npm run test:integration:direct -- --long               # short suites, then long suites
npm run test:integration:direct -- --suite monitors

docker-compose -f test/integration/docker-compose.test.yml down
```

The tests always read the URL and credentials from `test/integration/.env.test`. Values in
that file override any `UPTIME_KUMA_*` variables in your shell, so the tests cannot be
pointed at your real instance by accident. To test against a different instance, edit the
file.

`test/integration/verify-credentials.sh` checks that the credentials in `.env.test` can log
in, without running any tests. On a fresh instance it creates the admin account from them.

### Adding tests

- Add a case to the matching `*.test.ts` file. Each case is a `{ name, fn }` entry, and `fn`
  throws to fail.
- Clean up what the test creates in a `finally` block, so a failure does not leave monitors
  behind.
- `getMonitor` returns type-specific fields such as `url` only when called with
  `includeTypeSpecificFields: true`.
- A new suite is registered in `run-all.ts`, under `SHORT_SUITES` or `LONG_SUITES`. A test
  that waits for Uptime Kuma to run a check belongs in a long suite.

## Troubleshooting

### "Connection refused"
- Check that Docker is running and the container is up: `docker ps | grep uptime-kuma-test`.
- Uptime Kuma can take 30 seconds or more to start.

### Authentication failures ("authInvalidToken")
- Check that the credentials in `.env.test` match the admin account of the test instance.
  If you no longer know them, start again from a clean instance (below).
- The tests run the server with `MCP_TEST_MODE=1`, which stops it loading the root `.env`
  file.

### Port 3001 is already in use
- Change the port mapping in `test/integration/docker-compose.test.yml` and
  `UPTIME_KUMA_URL` in `.env.test` to match.

### Starting again from a clean instance
- Remove the container and its data volume. The next run creates the admin account again
  from `.env.test`:
  ```bash
  docker-compose -f test/integration/docker-compose.test.yml down -v
  ```
