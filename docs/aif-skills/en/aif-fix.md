# /aif-fix — Bug Fix

Fixes a specific bug. Two modes: immediate fix or create a plan first (`FIX_PLAN.md`).

## Usage

```
/aif-fix                              # execute existing FIX_PLAN.md
/aif-fix submit button not working    # fix a specific bug immediately
/aif-fix plan memory leak in WebSocket  # create a plan first, then fix
```

## Modes

| Mode                 | Description                     |
| -------------------- | ------------------------------- |
| No arguments         | Executes existing `FIX_PLAN.md` |
| With bug description | Fixes immediately               |
| `plan` + description | Creates FIX_PLAN.md, then fixes |

## What it does

1. Reads skill-context for project rules
2. Explores the codebase around the problem
3. Fixes the bug with added logging
4. Suggests tests for coverage
5. Creates a patch file for `/aif-evolve` (self-learning)

## Patch file

After each fix, a `.ai-factory/patches/YYYY-MM-DD.md` is created with the problem description and prevention points. `/aif-evolve` uses these patches to improve skills and avoid repeating mistakes.

## After fixing

```
/aif-evolve aif-fix   # update the skill based on the new patch
/aif-commit           # create a commit
```
