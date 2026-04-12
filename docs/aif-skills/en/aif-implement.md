# /aif-implement — Plan Implementation

Executes tasks from the current plan (`PLAN.md`). Tracks progress, can be interrupted and resumed.

## Usage

```
/aif-implement          # execute all tasks
/aif-implement task 3   # execute a specific task
```

## What it does

1. Loads the plan and skill-context
2. Finds the first uncompleted task (`[ ]`)
3. Implements the task with logging
4. Updates the checkbox in the plan (`[x]`)
5. Moves to the next task
6. On completion — suggests running `/aif-verify`

## Progress

Progress is saved directly in `PLAN.md` via checkboxes. If the session was interrupted — just run again, it will resume where it left off.

## Rules

- Does not create commits (that's the job of `/aif-commit` or the Approve button in Handoff UI)
- Adds logging to each significant change
- Follows rules from ARCHITECTURE.md and RULES.md

## After implementation

```
/aif-verify   # verify everything was implemented per plan
/aif-commit   # create a commit
```
