# /aif-architecture — Architecture Guidelines

Analyzes the project's tech stack, recommends an architecture pattern, and creates `ARCHITECTURE.md`.

## Usage

```
/aif-architecture
```

## What it creates

File `.ai-factory/ARCHITECTURE.md` with:

- Chosen architecture pattern (layered / hexagonal / microservices / etc.)
- Folder and module structure
- Layer boundaries — what can import what
- Naming conventions
- Error handling patterns

## When to use

- At the start of a project (after `/aif`)
- After significant refactoring
- When the project structure has become unclear

## Important

`ARCHITECTURE.md` is read by all skills as context. Good architecture documentation improves the quality of planning and implementation.
