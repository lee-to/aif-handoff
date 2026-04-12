# /aif-plan — Feature Planning

Creates a detailed implementation plan broken into tasks. Two modes: fast and full.

## Usage

```
/aif-plan add CSV export
/aif-plan fast new dashboard
/aif-plan full refactor auth module
```

## Modes

| Mode   | When to use                                       |
| ------ | ------------------------------------------------- |
| `fast` | Small features, hotfixes, well-understood tasks   |
| `full` | Large features, refactors, need a branch/worktree |

Default is `fast`.

## What it does

1. Reads project context (DESCRIPTION, ARCHITECTURE, RULES, skill-context)
2. Explores the codebase using parallel agents
3. Creates a plan with tasks, dependencies, and phases
4. Optionally creates a git branch and worktree (in `full` mode)

## Output

File `.ai-factory/PLAN.md` with tasks in the format:

```markdown
- [ ] Task 1: Task title
  - File: path/to/file.ts
  - Depends on: —
```

## After planning

```
/aif-improve   # if you want to refine the plan
/aif-implement # when the plan is ready — start implementation
```
