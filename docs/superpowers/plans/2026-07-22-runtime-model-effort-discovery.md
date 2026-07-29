# Runtime Model Effort Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Effort selector follow provider-advertised levels for the selected model across all four runtime adapters.

**Architecture:** Keep `RuntimeModel.metadata` as the shared discovery DTO. Normalize provider strings without a fixed allowlist, map each provider's native model metadata into that DTO, and keep the existing per-runtime lists only as the web fallback.

**Tech Stack:** TypeScript, React 19, Hono, Vitest, npm workspaces

## Global Constraints

- Cover Claude, Codex, OpenCode, and OpenRouter.
- Preserve runtime-specific option keys: `effort`, `modelReasoningEffort`, and `reasoningEffort`.
- Do not infer effort support from model names.
- Run `npm run ai:validate` after implementation.
- Keep every touched package at or above 70% test coverage.

---

### Task 1: Provider-neutral effort normalization and Codex discovery

**Files:**

- Create: `packages/runtime/src/modelEffort.ts`
- Modify: `packages/runtime/src/adapters/codex/modelDiscovery/modelCatalog.ts`
- Modify: `packages/runtime/src/adapters/codex/cli.ts`
- Modify: `packages/runtime/src/adapters/codex/sdk.ts`
- Modify: `packages/runtime/src/adapters/codex/appServer/run.ts`
- Test: `packages/runtime/src/__tests__/codexModelDiscoveryModelCatalog.test.ts`
- Test: `packages/runtime/src/__tests__/codexCli.test.ts`
- Test: `packages/runtime/src/__tests__/codexSdk.test.ts`
- Test: `packages/runtime/src/adapters/codex/appServer/__tests__/run.test.ts`

**Interfaces:**

- Produces: `normalizeModelEffort(value: unknown): string | null`
- Produces: `normalizeModelEffortLevels(value: unknown): string[] | undefined`
- Consumes: Codex app-server `supportedReasoningEfforts` and `defaultReasoningEffort`

- [x] **Step 1: Write failing Codex tests**

Add expectations that `max` and `ultra` survive `parseCodexRuntimeModel()` and are forwarded by CLI, SDK, and app-server transports.

```ts
expect(
  parseCodexRuntimeModel({
    model: "gpt-current",
    supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
  })?.metadata?.supportedEffortLevels,
).toEqual(["max", "ultra"]);
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace=@aif/runtime -- codexModelDiscoveryModelCatalog codexCli codexSdk appServer/run`

Expected: failures show the old allowlists dropping `max` or `ultra`.

- [x] **Step 3: Add generic normalization and remove Codex allowlists**

```ts
export function normalizeModelEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeModelEffortLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeModelEffort(entry);
    if (normalized) levels.add(normalized);
  }
  return levels.size > 0 ? [...levels] : undefined;
}
```

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test --workspace=@aif/runtime -- codexModelDiscoveryModelCatalog codexCli codexSdk appServer/run`

Expected: all focused Codex tests pass.

### Task 2: OpenCode and OpenRouter model metadata

**Files:**

- Modify: `packages/runtime/src/adapters/opencode/api.ts`
- Modify: `packages/runtime/src/adapters/openrouter/api.ts`
- Verify: `packages/runtime/src/adapters/claude/index.ts`
- Test: `packages/runtime/src/__tests__/opencodeApi.test.ts`
- Test: `packages/runtime/src/__tests__/openrouterApi.test.ts`
- Test: `packages/runtime/src/__tests__/claudeAdapter.test.ts`

**Interfaces:**

- Consumes: `normalizeModelEffort` and `normalizeModelEffortLevels`
- Produces: `RuntimeModel.metadata.supportedEffortLevels`, `defaultEffort`, and `supportsEffort`

- [x] **Step 1: Write failing provider mapping tests**

```ts
expect(models[0]?.metadata?.supportedEffortLevels).toEqual(["low", "high", "max"]);
expect(models[0]?.metadata?.defaultEffort).toBe("high");
```

Use OpenCode `variants` for the first assertion and OpenRouter `reasoning.supported_efforts` for both assertions.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace=@aif/runtime -- opencodeApi openrouterApi claudeAdapter`

Expected: OpenCode and OpenRouter models have no effort metadata.

- [x] **Step 3: Map native payloads and forward dynamic values**

OpenCode accepts array or record model collections and reads non-disabled variant `reasoningEffort` values. OpenRouter reads `reasoning.supported_efforts`, `reasoning.default_effort`, and passes any normalized selected effort into `body.reasoning.effort`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test --workspace=@aif/runtime -- opencodeApi openrouterApi claudeAdapter`

Expected: all focused provider tests pass.

### Task 3: Selected-model UI and fallback

**Files:**

- Modify: `packages/web/src/components/settings/RuntimeProfileForm.tsx`
- Test: `packages/web/src/__tests__/RuntimeProfileForm.test.tsx`

**Interfaces:**

- Consumes: selected `RuntimeModelOption.metadata`
- Produces: Effort options derived from the selected model or the runtime fallback

- [x] **Step 1: Write failing UI tests**

```ts
expect(screen.getByRole("button", { name: "ULTRA" })).toBeInTheDocument();
expect(screen.queryByRole("button", { name: "XHIGH" })).toBeNull();
```

Add a second case proving an unknown model payload still shows the runtime default list.

- [x] **Step 2: Run the focused web test and verify RED**

Run: `npm test --workspace=@aif/web -- RuntimeProfileForm`

Expected: the current selected model does not expose the new level in every required state.

- [x] **Step 3: Make model metadata authoritative**

Resolve model levels before fallback, hide the control only for explicit `supportsEffort: false`, and retain fallback lists for missing metadata.

- [x] **Step 4: Run the focused web test and verify GREEN**

Run: `npm test --workspace=@aif/web -- RuntimeProfileForm`

Expected: all form tests pass.

### Task 4: Documentation and validation

**Files:**

- Modify: `docs/providers.md`
- Verify: `packages/runtime/CHECKLIST.md`
- Verify: `packages/web/CHECKLIST.md`

**Interfaces:**

- Produces: documented provider-neutral model effort discovery behavior

- [x] **Step 1: Document discovery and fallback semantics**

State that effort levels come from selected-model metadata when available and fall back to runtime defaults otherwise.

- [x] **Step 2: Run package checks**

Run: `npm test -- --filter @aif/runtime --filter @aif/web`

Run: `npm run lint`

Expected: all commands pass.

- [x] **Step 3: Run required project validation**

Run: `npm run ai:validate`

Expected: formatting, lint, tests, coverage, build, performance, load, protocol, and checklist checks pass.

- [x] **Step 4: Review the final diff**

Confirm no adapter remains dependent on the old Codex-era effort allowlist and no unrelated files changed.
