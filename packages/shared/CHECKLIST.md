# @aif/shared — Checklist

Run through this list whenever you touch anything under `packages/shared/`.

- [ ] If you changed `schema.ts`, generate/apply the drizzle migration and update `@aif/data` repository functions that touch the affected tables.
- [ ] If you changed `types.ts`, check all consumers (`api`, `agent`, `runtime`, `web`) still compile — shared types fan out everywhere.
- [ ] If you changed `stateMachine.ts`, verify every subagent and API route that drives stage transitions still honours the new rules.
- [ ] Keep `browser.ts` free of Node-only imports — the web package depends on it.
- [ ] `npm run lint`
- [ ] `npm test`
