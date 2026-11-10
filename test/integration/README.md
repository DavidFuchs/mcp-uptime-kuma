# Integration tests

Integration tests for the MCP Uptime Kuma server. They run the server against a real Uptime
Kuma instance started in Docker.

```bash
npm run test:integration         # short suites
npm run test:integration:long    # short suites, then long suites
```

See [../TESTING.md](../TESTING.md) for how the runner sets up the test instance, the list of suites, running against
an instance that is already up, and troubleshooting.

## Files

| File | Purpose |
|---|---|
| `run-tests.sh` | Starts Uptime Kuma in Docker, sets up the admin account, runs the tests, stops it again |
| `ensure-admin.ts` | Creates the admin account on a fresh instance and checks that the credentials in `.env.test` can log in |
| `run-all.ts` | The test runner: picks the suites and reports results |
| `helpers.ts` | Test client, configuration loading and result helpers |
| `*.test.ts` | Short suites, one file per area |
| `*.long.test.ts` | Long suites, which wait for Uptime Kuma to run real checks |
| `docker-compose.test.yml` | The test Uptime Kuma instance |
| `.env.test.example` | Template for `.env.test`, which holds the test credentials |
| `verify-credentials.sh` | Runs `ensure-admin.ts` on its own, without running any tests |
