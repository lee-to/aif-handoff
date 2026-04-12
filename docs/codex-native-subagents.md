# Codex Native Subagents

This rollout enables native Codex subagents as the preferred default `useSubagents` strategy in AIF Handoff when the selected runtime is `codex` over the SDK transport and the required AI Factory-managed `.codex` assets are present on disk.

## Dependency

Minimum AI Factory version:

- the first release that includes `ai-factory` PR `#70` ("materialize managed agent assets")
- expected package version: `2.9.3` or later

If your project was bootstrapped with an older AI Factory release, re-run:

```bash
ai-factory init --agents claude,codex
```

This must materialize:

- `.codex/agents/*.toml`
- `.codex/config.toml`

## Runtime Behavior

Default behavior after this change:

- `codex` + `sdk` + `useSubagents=true` + native assets present → native Codex subagents
- `codex` + `sdk` + `useSubagents=true` + native assets missing → automatic fallback to isolated skill-session mode until the project is reinitialized with AI Factory `2.9.3+`
- `codexSubagentStrategy: "isolated"` → explicit escape hatch to legacy isolated skill-session flow
- Claude remains unchanged and continues using `.claude/agents/*`

`projectInit()` still bootstraps only fresh projects. Existing projects with `.ai-factory/` already present are not reinitialized automatically; the rollout safety comes from the runtime readiness guard and fallback path above.

## Handoff-Aware Contract

The Codex agents materialized by AI Factory are no longer generic role prompts only. They now encode the Handoff contract directly:

- top-level coordinators understand explicit `HANDOFF_MODE`, `HANDOFF_TASK_ID`, and `HANDOFF_SKIP_REVIEW` context from the parent runtime
- autonomous Handoff runs stay non-interactive and do not attempt Handoff MCP sync from inside the Codex agent
- manual Codex sessions may preserve Handoff task linkage when a plan annotation already exists
- worker and sidecar agents explicitly keep Handoff sync coordinator-owned

What still comes from `aif-handoff` at runtime:

- exact task title/description/attachments
- exact plan path for the current run
- final runtime capability negotiation (`native` vs `isolated`)

## Verification Checklist

1. Install or upgrade AI Factory to the release containing PR `#70`.
2. In the target project, run `ai-factory init --agents claude,codex`.
3. Confirm the project contains `.codex/agents/` and `.codex/config.toml`.
4. Start AIF Handoff with a Codex SDK runtime profile.
5. Move a task with `useSubagents=true` into planning or implementing.
6. Confirm logs show `usedNativeSubagentWorkflow: true` when assets are present.
7. For an older bootstrap without `.codex/agents/*.toml` or `.codex/config.toml`, confirm the prompt path downgrades safely to `$aif-*` / isolated mode instead of attempting a broken native run.

## Rollback

If native Codex agents need to be bypassed for a project or profile, set:

```json
{
  "codexSubagentStrategy": "isolated"
}
```

This preserves the previous fresh-session skill-command behavior without changing Claude or non-Codex runtimes.
