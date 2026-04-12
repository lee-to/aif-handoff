# /aif-loop — Recurring Schedule

Runs another skill or command repeatedly on an interval.

## Usage

```
/aif-loop 5m /aif-review        # run review every 5 minutes
/aif-loop 1h /aif-security-checklist   # every hour
/aif-loop 30s check deploy status      # every 30 seconds
```

## Interval format

| Suffix | Meaning               |
| ------ | --------------------- |
| `s`    | seconds               |
| `m`    | minutes (default 10m) |
| `h`    | hours                 |

## When to use

- Monitoring deploy status
- Periodic health check
- Re-running tests until they pass
- Polling an external API

## Stopping

Press Ctrl+C or close the Claude Code session.
