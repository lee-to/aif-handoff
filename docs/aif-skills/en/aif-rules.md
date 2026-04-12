# /aif-rules — Project Rules

Creates and updates `RULES.md` — a document with project conventions and rules.

## Usage

```
/aif-rules
/aif-rules update   # update based on current code
```

## What it creates

File `.ai-factory/RULES.md` with conventions:

- File, variable, function naming
- Module structure
- Commit rules
- Error handling
- Logging
- Testing

## Why RULES.md

All skills read RULES.md as context. The more precise the rules — the better the quality of generated code and commits.

## Example content

```markdown
## Naming

- Files: kebab-case (user-service.ts)
- Classes: PascalCase
- Constants: SCREAMING_SNAKE_CASE

## Commits

- Scope is mandatory
- JIRA ticket in footer if available

## Error Handling

- Always log with context object
- Never swallow errors in catch
```
