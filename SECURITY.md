# Security Policy

## Supported Versions

This is a personal, side project maintained on a best-effort basis. Only the
latest released version receives security attention. Older versions are not
maintained — please upgrade to the latest release before reporting an issue.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities privately — do **not** open a public
issue for security problems.

Use GitHub's **Private vulnerability reporting** for this repository:

1. Go to the [Security tab](https://github.com/DavidFuchs/mcp-uptime-kuma/security).
2. Click **Report a vulnerability**.
3. Provide as much detail as you can, including steps to reproduce, affected
   versions, and any potential impact.

If you are unable to use GitHub's private reporting, you may email
**david@davidfuchs.ca** instead.

### What to Expect

Because this is a personal project maintained in spare time:

- I will do my best to acknowledge your report within a few weeks.
- I cannot commit to a timeline for investigating or releasing a fix.
- **Pull requests are very welcome.** If you are able to propose a fix along
  with your report, that is the fastest path to getting it resolved. Please
  still report privately first rather than opening a public PR that reveals the
  vulnerability.

## Scope and Hardening Notes

This project is a Model Context Protocol (MCP) server that connects to an
Uptime Kuma instance using credentials you supply. To operate it securely:

- **Protect your credentials.** Uptime Kuma usernames, passwords, and JWT
  tokens are typically provided via environment variables or configuration.
  Keep these out of source control, logs, and shared environments.
- **Secure the HTTP transport.** When running with the streamable HTTP
  transport, do not expose it directly to untrusted networks. Place it behind
  appropriate network controls (firewall, reverse proxy, authentication).
- **Trust your Uptime Kuma instance.** The server relays data from the Uptime
  Kuma server you configure. Only connect to instances you control or trust.
- **Keep dependencies up to date.** Run the latest release to pick up
  dependency and security updates.

Thank you for helping keep this project and its users safe.
