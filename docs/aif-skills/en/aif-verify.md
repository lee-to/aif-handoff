# /aif-verify — Implementation Verification

Checks that the implementation fully matches the plan: all tasks completed, code compiles, tests pass.

## Usage

```
/aif-verify
```

Run after `/aif-implement` before committing.

## What it checks

1. All plan tasks are marked `[x]`
2. No files from the plan are missing
3. Code compiles / no TypeScript errors
4. Tests pass
5. Compliance with ARCHITECTURE.md and RULES.md
6. Logging was added where needed

## Output

```
✅ Task 1: implemented
✅ Task 2: implemented
⚠️ Task 3: test missing
❌ Task 4: file not found
```

## After verify

- If all ok → `/aif-commit`
- If there are issues → `/aif-implement task N` for a specific task
