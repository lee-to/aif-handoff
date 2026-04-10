# Skill-Context — Self-Learning System

Skill-context is a mechanism for accumulating project-specific rules for skills. It allows customizing skill behavior for your project without modifying the originals.

## The problem it solves

Base skills (`/aif-commit`, `/aif-implement`, etc.) are written for the general case. But every project has its own conventions, tech stack, and architecture decisions. Skill-context lets you capture that knowledge.

## Location

```
.ai-factory/
└── skill-context/
    ├── aif-commit/
    │   └── SKILL.md    # rules for /aif-commit in this project
    ├── aif-implement/
    │   └── SKILL.md    # rules for /aif-implement
    └── aif-fix/
        └── SKILL.md    # rules for /aif-fix
```

## Rule priority

```
skill-context/aif-commit/SKILL.md   ← HIGHER priority (project rules)
.claude/skills/aif-commit/SKILL.md  ← LOWER priority (base skill)
```

On conflict — **skill-context always wins**. Same principle as nested CLAUDE.md files.

## How rules are created

**Automatically** — via `/aif-evolve`:

```
/aif-fix auth bug   → creates patch
/aif-evolve aif-fix → analyzes patch → adds rule to skill-context
```

**Manually** — edit `.ai-factory/skill-context/<skill>/SKILL.md` directly:

```markdown
# Project Rules for /aif-commit

## Rules

### Always include ticket number

**Source**: team convention
**Rule**: If branch name contains JIRA ticket (e.g. PROJ-123), always include it in commit footer as `Refs: PROJ-123`
```

## aif updates don't wipe skill-context

When a new version of AI Factory comes out and you update skills — files in `.ai-factory/skill-context/` **are not touched**. The base skills in `.claude/skills/` will update, your rules will stay.

## Real-world example

Suppose `/aif-commit` repeatedly generated commits without a scope, but your project requires it. After `/aif-fix` a patch is created, after `/aif-evolve aif-commit` the skill-context gets:

```markdown
### Scope is mandatory in this project

**Source**: patches/2026-04-01.md
**Rule**: Always include scope in commit message. The project follows strict conventional commits — commits without scope will be rejected in CI.
```

Now `/aif-commit` will always include a scope.

## Viewing current rules

```bash
cat .ai-factory/skill-context/aif-commit/SKILL.md
ls .ai-factory/skill-context/
```
