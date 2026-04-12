# /aif-evolve — Skill Self-Learning

Analyzes accumulated fix patches and improves skills by adding project-specific rules. This is AI Factory's "memory" mechanism.

## Usage

```
/aif-evolve              # update all skills
/aif-evolve aif-fix      # update a specific skill
/aif-evolve aif-commit aif-implement   # multiple skills
```

## How it works

```
patches/*.md (past fixes)
    ↓
/aif-evolve analyzes error patterns
    ↓
identifies prevention points
    ↓
writes rules to .ai-factory/skill-context/<skill>/SKILL.md
    ↓
skills read skill-context on every run
    ↓
mistakes no longer repeat
```

## Patch files

Patches are created automatically via `/aif-fix`. Stored in `.ai-factory/patches/YYYY-MM-DD.md`. Each patch contains:

- Problem description
- Root cause
- Prevention points (specific actions to prevent recurrence)

## Skill-context

The output of `/aif-evolve` is files in `.ai-factory/skill-context/<skill-name>/SKILL.md`.

These files:

- **Are not overwritten** when skills update
- **Take priority** over base SKILL.md in case of conflict
- **Are read mandatorily** by each skill before execution

## Incrementality

Uses a cursor-based approach — each run only processes new patches. Cursor is stored in `.ai-factory/evolutions/patch-cursor.json`.

## When to run

- After several fixes via `/aif-fix`
- Periodically (once a week during active development)
- When you notice the same mistakes repeating

## Important

- Never edits base files in `.claude/skills/aif-*/`
- All changes only in `.ai-factory/skill-context/`
- Evolution logs are saved in `.ai-factory/evolutions/`
