# @aif/agent — Checklist

Run through this list whenever you touch anything under `packages/agent/`.

- [ ] All AI-backed execution goes through `subagentQuery.ts` → `RuntimeAdapter.run()`. Never call a provider SDK directly from agent code.
- [ ] Subagents in `subagents/` must use `.claude/agents/` definitions via `execution.agentDefinitionName`. Exception: single-pass validators without a corresponding agent definition.
  - `planner.ts` → `plan-coordinator`
  - `implementer.ts` → `implement-coordinator`
  - `reviewer.ts` → `review-sidecar` + `security-sidecar`
- [ ] All DB access goes through `@aif/data`. No direct drizzle/SQL imports here.
- [ ] If you added a new subagent, add tests that verify it resolves the correct agent definition and handles the runtime capability fallback.
- [ ] If you touched the coordinator polling logic, verify the state machine transitions in `@aif/shared/stateMachine.ts` still line up.
- [ ] Polling intervals are configured in milliseconds. Do not convert values above 59 seconds into a cron step expression.
- [ ] If you touched the poll scheduler, verify a trigger received during an active cycle starts an overlapping cycle only while global stage slots are free, that an overlapping cycle skips every project already holding a stage (project-local stage order), and that a saturated ceiling still falls back to one coalesced follow-up cycle. No cycle may wait on a running stage before picking up work in an idle project.
- [ ] The interval tick must not await the poll cycle promise (`awaitCallback: false`). That promise settles only after every stage the cycle started has finished, so awaiting it holds the scheduler's re-entrancy guard for hours and drops every tick in between — the coordinator silently degrades to a wake-only system.
- [ ] If a task waits for a coordinator permit before claim, revalidate eligibility with an atomic CAS after the wait and keep permit/claim cleanup exception-safe until ownership transfers to the task promise.
- [ ] If candidate setup can fail after earlier tasks were spawned, drain all started task promises in `finally` before the project lane exits or propagates the setup error.
- [ ] When `AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED=true`, auto-queue terminal transitions await a verified commit and auto-queue projects sharing one Git worktree remain serial; when disabled, preserve legacy concurrency.
- [ ] If you touched first-activity watchdog logic, verify streamed runtime events (not only tool/subagent hooks) count as activity for tool-less workflows.
- [ ] `npm run lint`
- [ ] `npm test`
