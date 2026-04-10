# @aif/mcp — Checklist

Run through this list whenever you touch anything under `packages/mcp/`.

- [ ] New or changed MCP tools must stay consistent with the equivalent `@aif/api` routes — do not let the two drift apart.
- [ ] All DB access goes through `@aif/data`. No direct drizzle/SQL imports here.
- [ ] Validate every tool input with Zod and return structured errors — MCP clients parse them.
- [ ] Add unit tests for each new tool (happy path + one failure path).
- [ ] `npm run lint`
- [ ] `npm test`
