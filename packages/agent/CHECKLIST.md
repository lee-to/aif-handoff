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
- [ ] If you touched the poll scheduler, verify periodic ticks and event-driven wakes share a single-flight coordinator loop; triggers received during an active cycle may request only one coalesced follow-up cycle.
- [ ] If a task waits for a coordinator permit before claim, revalidate eligibility with an atomic CAS after the wait and keep permit/claim cleanup exception-safe until ownership transfers to the task promise.
- [ ] If candidate setup can fail after earlier tasks were spawned, drain all started task promises in `finally` before the project lane exits or propagates the setup error.
- [ ] If you touched first-activity watchdog logic, verify streamed runtime events (not only tool/subagent hooks) count as activity for tool-less workflows.
- [ ] `npm run lint`
- [ ] `npm test`
