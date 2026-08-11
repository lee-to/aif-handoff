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
- [ ] If you touched the poll scheduler, verify both rollout states. With `AIF_AGENT_OVERLAPPING_POLL_CYCLES_ENABLED=false` (default), periodic ticks and event-driven wakes share a single-flight coordinator loop and triggers received during an active cycle may request only one coalesced follow-up cycle. With the flag on, a trigger starts an overlapping cycle only while global stage slots are free, an overlapping cycle takes only projects holding no stage (project-local stage order), and a saturated ceiling still falls back to one coalesced follow-up cycle.
- [ ] With the flag on, no cycle may wait on a running stage before picking up work in an idle project. Exclude busy projects inside the project query rather than filtering a fixed window afterwards — any window sized off the lane limit alone lets busy projects hide an idle project behind them at supported `COORDINATOR_MAX_CONCURRENT_PROJECTS` / `COORDINATOR_MAX_CONCURRENT_TASKS` combinations.
- [ ] With the flag on, the interval tick must dispatch the poll cycle without awaiting it (`awaitCallback: false`). That promise settles only after every stage the cycle started has finished, so awaiting it holds the scheduler's re-entrancy guard for hours and drops every tick in between — the coordinator silently degrades to a wake-only system. A dispatch-only tick keeps no reference to the promise, so its callback must handle its own errors.
- [ ] If a task waits for a coordinator permit before claim, revalidate eligibility with an atomic CAS after the wait and keep permit/claim cleanup exception-safe until ownership transfers to the task promise.
- [ ] If candidate setup can fail after earlier tasks were spawned, drain all started task promises in `finally` before the project lane exits or propagates the setup error.
- [ ] When `AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED=true`, auto-queue terminal transitions await a verified commit and auto-queue projects sharing one Git worktree remain serial; when disabled, preserve legacy concurrency.
- [ ] If you touched first-activity watchdog logic, verify streamed runtime events (not only tool/subagent hooks) count as activity for tool-less workflows.
- [ ] `npm run lint`
- [ ] `npm test`
