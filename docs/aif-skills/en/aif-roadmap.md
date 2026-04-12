# /aif-roadmap — Roadmap Management

Creates and updates `ROADMAP.md` with milestones, features, and timelines.

## Usage

```
/aif-roadmap
/aif-roadmap update   # update existing roadmap
```

## What it creates

File `.ai-factory/ROADMAP.md`:

```markdown
## Milestone 1: MVP (2026-Q1)

- [ ] feat: user authentication
- [ ] feat: basic CRUD

## Milestone 2: Beta (2026-Q2)

- [ ] feat: notifications
- [ ] perf: query optimization
```

## Why a roadmap

Skills `/aif-plan` and `/aif-commit` read the roadmap to:

- Link tasks to milestones
- Add milestone linkage to commits
- Warn if a feature is not linked to any milestone
