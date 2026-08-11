# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AIF Handoff, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email security concerns to the maintainers or use [GitHub's private vulnerability reporting](https://github.com/lee-to/aif-handoff/security/advisories/new).

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix release:** as soon as possible, depending on severity

## Supported Versions

| Version       | Supported |
| ------------- | --------- |
| Latest `main` | Yes       |

## Security Considerations

- The Agent SDK uses local `~/.claude/` credentials or an API key via `ANTHROPIC_API_KEY`
- The SQLite database is stored locally in `data/` — ensure appropriate file permissions
- Participants Mode authenticates REST and WebSocket connections with the same opaque session;
  unsafe REST requests additionally require an exact allowed `Origin` and session-bound CSRF token
- Participants Mode is a shared workspace: authenticated participants can read all projects/tasks,
  comment or attach files on any task, and receive workspace task/project events. Assignment gates
  mutations, not visibility or comment access
- HTTP MCP always requires its separate `MCP_AUTH_TOKEN`; browser cookies cannot authenticate it
- With Participants Mode disabled, REST and WebSocket access retain the anonymous compatibility mode
- Never commit `.env` files or API keys to the repository

## Dependency Audit Policy

- CI security gate for shipped/runtime risk uses `npm audit --omit=dev`.
- Full `npm audit` may include dev-tooling findings (for example migration/lint/build chains) that do not ship in runtime artifacts.
- Dev-only findings are triaged separately and may be tracked as accepted risk with periodic re-evaluation.
