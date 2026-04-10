# /aif-docs — Documentation Generation

Creates and maintains project documentation. Generates a README as a landing page and detailed docs by topic.

## Usage

```
/aif-docs              # generate all documentation
/aif-docs api          # update only API docs
/aif-docs readme       # update only README
```

## What it generates

- `README.md` — brief landing page with description, installation, quick start
- `docs/getting-started.md` — detailed installation instructions
- `docs/api.md` — API endpoint documentation
- `docs/architecture.md` — architecture overview
- `docs/configuration.md` — environment variables and settings

## Principles

- README — concise, links to docs for details
- Docs — detailed, one topic per file
- Syncs with real code (reads routes, schema, env vars)
