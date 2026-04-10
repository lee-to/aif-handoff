# /aif-reference — Knowledge Reference

Creates a structured knowledge reference from a URL, document, or file. Agents use these references during planning and implementation.

## Usage

```
/aif-reference https://docs.stripe.com/api
/aif-reference ./openapi.yaml
/aif-reference https://github.com/org/repo/blob/main/README.md
```

## What it does

1. Fetches content from URL or reads a file
2. Structures it into markdown with metadata
3. Saves to `.ai-factory/references/`
4. The reference becomes available to all skills

## Output

```
.ai-factory/references/
└── stripe-api.md        # structured Stripe API documentation
```

## When to use

- Adding an integration with a third-party service
- You need the agent to know the specifics of an external API
- SDK documentation that should be considered during implementation

## Examples

```
/aif-reference https://hono.dev/docs/api/routing
/aif-reference https://orm.drizzle.team/docs/select
```
