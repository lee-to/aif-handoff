# /aif-improve — Plan Improvement

Second planning iteration: re-analyzes the codebase, finds gaps, and improves the existing plan.

## Usage

```
/aif-improve
```

Run after `/aif-plan` if the plan seems incomplete.

## What it does

1. Loads the existing `PLAN.md`
2. Re-analyzes the codebase with higher thoroughness
3. Checks for gaps, incorrect task dependencies
4. Verifies all edge cases are covered
5. Updates the plan with improvements

## When to use

- After `/aif-plan` before starting implementation
- If unplanned tasks were discovered during implementation
- If the plan seems too shallow

## Typical workflow

```
/aif-plan new feature
/aif-improve          # ← optional improvement step
/aif-implement
```
