# /aif-security-checklist — Security Audit

Conducts a security audit based on OWASP Top 10 and best practices. Produces a detailed report with findings.

## Usage

```
/aif-security-checklist
/aif-security-checklist auth     # focus on a specific area
```

## What it checks

| Area            | What it looks for                                        |
| --------------- | -------------------------------------------------------- |
| Authentication  | Weak passwords, missing rate limiting, insecure sessions |
| Injection       | SQL injection, command injection, XSS                    |
| Secrets         | Hardcoded keys, credentials in code/logs                 |
| API Security    | Missing validation, exposed endpoints                    |
| Dependencies    | Vulnerable packages (npm audit)                          |
| CSRF            | Missing tokens for state-changing requests               |
| Race Conditions | Concurrent requests, TOCTOU vulnerabilities              |

## Output

Report with findings by severity:

- `CRITICAL` — fix immediately
- `HIGH` — fix before next release
- `MEDIUM` — fix in the next sprint
- `LOW` — recommendation

## When to run

- Before a production release
- After adding auth/payment functionality
- Periodically (once a month)
