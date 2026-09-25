# Security policy

mcp-expose sits between AI agents and your API, so we take security reports seriously.

## Supported versions

Several major versions are maintained in parallel. See [RELEASING.md](RELEASING.md) for how fixes are
backported and released.

| Major version          | Status                                                      | Receives                        |
| ---------------------- | ----------------------------------------------------------- | ------------------------------- |
| Current (latest major) | Active                                                      | Features, fixes, security fixes |
| Previous major         | Maintenance, for 12 months after the next major is released | Bug fixes and security fixes    |
| Older majors           | Security only, for 6 more months, then end of life          | Critical security fixes         |
| End of life            | Unsupported                                                 | Nothing. Deprecated on npm.     |

Current status:

| Version | Status |
| ------- | ------ |
| 1.x     | Active |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through
[GitHub private vulnerability reporting](https://github.com/NITINKACHHADIYA/Node-MCP/security/advisories/new),
or contact the maintainer, [@NITINKACHHADIYA](https://github.com/NITINKACHHADIYA), directly on GitHub.

Please include:

- affected version(s) and framework adapter
- a description of the issue and its impact
- steps or a minimal app to reproduce

You can expect an acknowledgement within 3 working days and a status update within 10 working days.
Once a fix is released, we will publish a GitHub security advisory and credit you, unless you prefer
not to be named.

## Scope

In scope: anything in this repository. That includes auth/header forwarding, Origin validation, argument
mapping (for example path or query injection), tool exposure (routes exposed without being marked), and
the packaged `dist/` output.

Out of scope: vulnerabilities in your own application's routes or guards, and the behaviour of MCP clients.
See the README's _Security checklist_ for guidance on exposing APIs safely.
