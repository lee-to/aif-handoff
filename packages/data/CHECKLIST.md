# @aif/data — Checklist

Run through this list whenever you touch anything under `packages/data/`.

- [ ] `@aif/data` is the only legal DB boundary for `api`, `agent`, and `runtime`. Do not re-export raw drizzle helpers or leak SQL construction.
- [ ] If you added a new repository function, keep it cohesive with the existing repository-style API (one function = one intent).
- [ ] If `@aif/shared/schema.ts` changed, update the affected repository functions here in the same PR.
- [ ] Add unit tests covering new query paths and edge cases (empty result, conflict, update of missing row).
- [ ] `npm run lint`
- [ ] `npm test`
