# /aif-commit — Conventional Commit

Analyzes staged changes and creates a commit following the [Conventional Commits](https://www.conventionalcommits.org/) specification.

## Usage

```
/aif-commit          # auto-detect type and scope
/aif-commit auth     # specify scope manually
```

## Commit types

| Type       | When                                |
| ---------- | ----------------------------------- |
| `feat`     | New functionality                   |
| `fix`      | Bug fix                             |
| `docs`     | Documentation only                  |
| `refactor` | Refactoring without behavior change |
| `test`     | Tests                               |
| `chore`    | Maintenance, dependencies           |
| `build`    | Build system                        |
| `ci`       | CI/CD configuration                 |
| `perf`     | Performance improvement             |
| `style`    | Code formatting                     |

## Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Example:

```
fix(api): handle null response from payment gateway

The payment API can return null when the gateway times out.
Added null check and retry logic.

Fixes #123
```

## Workflow (interactive)

1. Checks staged files (`git status`)
2. Analyzes the diff (`git diff --cached`)
3. Verifies compliance with architecture and RULES
4. Proposes a commit message
5. **Asks for confirmation** — commit as is / edit / cancel
6. Executes `git commit`
7. Suggests push

> **Note:** The skill is interactive — it requires a terminal. In Handoff UI when clicking "Approve + Create commit", an automatic non-interactive version is used.

## Rules

- Never commits secrets and credentials
- Does not add `Co-Authored-By: AI` lines
- If changes are unrelated — suggests splitting into multiple commits
