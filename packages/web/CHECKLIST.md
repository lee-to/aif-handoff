# @aif/web — Checklist

Run through this list whenever you touch anything under `packages/web/`.

- [ ] Before creating a new UI component, check `packages/web/src/components/ui/` for an existing primitive and compose it instead.
- [ ] If a new UI component is genuinely needed, sync it with the Pencil design system (`.pen` files) via the `pencil` MCP tools. No visual component lands without a Pencil representation.
- [ ] UI primitives go in `components/ui/`. Domain-specific compositions go in their feature folder (`components/task/`, `components/kanban/`, etc.).
- [ ] No expensive CSS: no `box-shadow`, `backdrop-filter`, `filter: blur()`, `text-shadow`, or other GPU/paint-heavy properties. Use `border`, `outline`, `opacity`, solid `background-color` instead.
- [ ] API calls go through `lib/api.ts`. Do not scatter `fetch()` calls across components.
- [ ] If a REST endpoint or WS event you consume changed, re-check `docs/api.md` for the current contract.
- [ ] `npm run lint`
- [ ] `npm test`
