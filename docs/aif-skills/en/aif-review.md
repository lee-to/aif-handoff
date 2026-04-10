# /aif-review — Code Review

Performs a detailed code review: looks for bugs, security issues, architecture violations, and best practice violations.

## Usage

```
/aif-review              # review staged changes
/aif-review PR#42        # review a specific PR
/aif-review main..feat   # review a commit range
```

## What it checks

- **Correctness** — logical errors, edge cases, null/undefined
- **Security** — injections, XSS, exposed data
- **Performance** — N+1 queries, unnecessary computations
- **Architecture** — compliance with ARCHITECTURE.md, layer boundaries
- **Rules** — compliance with RULES.md and project conventions
- **Tests** — coverage of changes with tests

## Output

Structured report with findings by severity:

- `ERROR` — must fix before merge
- `WARN` — should fix
- `INFO` — recommendation / improvement

## After review

```
/aif-fix      # fix found bugs
/aif-commit   # if no issues found
```
