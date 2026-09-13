# Backlog admission latency is bounded by the longest in-flight lane, not by the task's own project capacity

## Symptom

A task dispatched to the backlog of a **parallel-enabled project with all slots free** can wait
hours before processing starts. The wait is not caused by the task's own project — it is caused
by _another_ project's lane still being mid-pass inside the same coordinator poll cycle. Queue
admission (backlog → `planning`, and pipeline pickup) happens only at poll-cycle boundaries, and a
cycle stays open until **every** selected project lane has drained. Measured on a live instance:
a task waited **90.6 minutes** after creation while its own project sat completely idle, because
an unrelated project's review stage held the cycle open; historical p90 reaches **16.3 hours**.

## Mechanism

All anchors verified against `main` @ `d82e466` (`packages/agent/src/coordinator.ts` unless noted):

1. **Admission runs once per cycle, at cycle start.**
   `runPollCycle()` (`coordinator.ts:1048` — `async function runPollCycle(): Promise<void> {`)
   calls `processAutoQueueAdvance()` (`:1062` — `processAutoQueueAdvance();`) as part of its
   opening prelude. `processAutoQueueAdvance()` (`:907` —
   `export function processAutoQueueAdvance(): number {`) lifts backlog tasks into `planning`
   with a fill loop (`:977` — `while (active < limit) {`) guarded by the atomic
   `claimBacklogTaskForAdvance` CAS claim (`:995` —
   `if (!claimBacklogTaskForAdvance(next.id, autoQueueCommit)) {`;
   `packages/data/src/index.ts:2305`). The next backlog candidate is picked by
   `nextBacklogTaskByPosition` (`packages/data/src/index.ts:2625`). Nothing re-runs this lift
   until the _next_ cycle starts.

2. **A cycle stays open until every lane drains.**
   `runPollCycle` selects up to `COORDINATOR_MAX_CONCURRENT_PROJECTS` project lanes and awaits
   them all (`Promise.allSettled(projectIds.map(processProjectLane))`). Each lane
   (`coordinator.ts:1115` — `async function processProjectLane(projectId: string): Promise<void> {`)
   walks the pipeline stages sequentially and, per stage, `await`s its started tasks
   (`await Promise.allSettled(spawned)`). So one long implementer/review stage anywhere keeps
   the whole cycle — and therefore the next admission — open for its full remaining runtime.

3. **Triggers during an active cycle only queue a follow-up.**
   The single-flight guard in `pollAndProcess()` (`coordinator.ts:1295–1298`):
   `if (activePollPromise) { followUpPollRequested = true; … return activePollPromise; }`.
   The scheduler tick _and_ the wake channel (`task:created` / `task:moved` / `agent:wake`
   events → `triggerWake` → `pollAndProcess`) both hit this guard while a cycle is active —
   the event-driven wake path exists but cannot admit anything mid-cycle.

Consequence: a task created (or made eligible) at time _T_ is admitted only when the cycle that
was active at _T_ fully drains — i.e. its admission latency equals the **remaining runtime of the
longest in-flight lane**, independent of its own project's free capacity. A manual `start_ai` on
the waiting task changes its status to `planning` but starts nothing, because candidate pickup
also happens only inside a cycle's lanes.

## Empirical impact

**Incident timeline (UTC, 2026-09-11):**

- 12:22:48.753 — a task reaches done; the advance pass lifts 3 tasks across 3 projects. For a
  now-emptied project the pass logs `active:0, limit:5, "no more backlog ready"` — it had nothing
  queued.
- 12:27:40–47 — four tasks are created on that emptied project.
- 12:24–12:45 — every coordinator tick logs `Poll cycle already active; queued one follow-up
cycle` (16×). The four tasks wait.
- 12:45 — manual `start_ai` on the four tasks flips status to `planning` but starts nothing.
- 13:58:14.033 — the last foreign task passes review (`Auto review gate accepted review, moving
to done` → `Poll cycle complete` → `Starting poll cycle`). Same second, the advance lifts 2
  more backlog tasks, and at 13:58:14.829 the four waiting tasks are claimed via the
  `[FIX:149] Revalidating task candidate after coordinator permit` lane path; worktrees are
  created 13:58:16–19.
- **Admission latency 90.6–90.7 min = exactly the foreign cycle's remaining runtime.**

**Historical distribution** (200 tasks, 2026-07-26 → 2026-09-11; latency = first activity-log
timestamp − `created_at`):

| Day    | Median | Max                     |
| ------ | ------ | ----------------------- |
| Aug 01 | 27.7m  | —                       |
| Aug 12 | —      | 136.1m                  |
| Aug 17 | 58.9m  | —                       |
| Aug 18 | —      | p90 **978.2m (16.3 h)** |
| Aug 19 | 45.8m  | —                       |
| Sep 03 | 57.3m  | 151.2m                  |
| Sep 06 | 66.6m  | 174.4m                  |
| Sep 08 | 65.4m  | **225.6m**              |

Honest caveat: **instant admission (<2 min) accounts for ≈ half of all tasks** — dispatches that
landed in an idle window were admitted immediately. The design is not broken for idle factories;
the cost lands specifically on factories that are busy when the task arrives, and it grows with
the runtime of whatever is in flight. Batch signatures are visible (five tasks created together
all waiting exactly 65.0–65.4m — one admission window lifted them together), consistent with the
cycle-boundary mechanism rather than per-task noise.

## Candidate designs

### A. Mid-cycle admission pass on busy-cycle triggers (small, reuses all machinery)

When `pollAndProcess()` hits the active-cycle guard, additionally fire a single-flight
**admission pass**: run the same CAS-protected `processAutoQueueAdvance()` lift, then start
project lanes for **parallel-capable projects only**, reusing the exact cycle lane function.

- Pros: minimal diff; lanes already enforce correctness under concurrency — the shared
  `StageSemaphore` (per-project-stage key max + global ceiling), the `[FIX:149]`
  post-permit revalidation, and the atomic `claimCoordinatorTaskIfEligible` CAS make concurrent
  cycle/pass lanes safe by construction. Sequential projects can be excluded from the pass
  entirely, preserving their cycle-boundary semantics with zero new windows.
- Cons: per-tick query cost while a cycle is busy (a few indexed queries per project — the same
  work a cycle start does); another moving part in the coordinator's lifecycle; the pass must be
  detached (must not extend the returned cycle promise) or admission serializes again behind the
  very drain it is meant to bypass.

### B. Per-project long-lived lanes (architectural)

Replace per-cycle lane batches with one long-lived lane per project that reacts to capacity
changes (task exits) and arrivals.

- Pros: conceptually cleanest; admission latency collapses to event-handling time; no cycle
  concept to reason about.
- Cons: a rewrite of the lane lifecycle — lifecycle ownership, backpressure when
  `COORDINATOR_MAX_CONCURRENT_PROJECTS` projects are active, interaction with
  `failedInCycle`-style cycle scoping, watchdog/recovery placement all need redesign. High
  regression risk relative to the size of the bug.

### Risks either design must address

- **Double-processing** — solved today by task-row CAS claims (`claimCoordinatorTaskIfEligible`)
  plus lock TTLs; any concurrent-lane design must route through them unchanged.
- **Cap bypass** — per-project and global caps are enforced by the shared semaphore, not by the
  cycle boundary; a design that admits outside a cycle must keep using that semaphore.
- **Sequential-project regression** — non-parallel projects rely on the
  `hasActiveLockedTaskForProject` cross-cycle guard + key-max-1 semaphore; a mid-cycle path must
  not open the brief lock gap between a sequential task's stages.
- **Review-gate reentrancy** — the auto-review gate runs inside `processOneTask` per claimed
  task; CAS claiming keeps it non-reentrant; no change needed, but worth an explicit test.

## Concrete proposal (implemented and linked as a PR)

Design **A**, plus a rollout flag:

1. Extract the lane function out of `runPollCycle`'s closure so cycles and passes share one
   implementation (`runProjectLane(projectId, failedSet, concurrencyCache)`).
2. In `pollAndProcess`'s busy branch, fire a detached, single-flight admission pass:
   `processAutoQueueAdvance()` + `Promise.allSettled` of lanes for
   `listCoordinatorActionableProjectIds(COORDINATOR_MAX_CONCURRENT_PROJECTS)` filtered to
   parallel-capable projects (sequential projects keep exact cycle-boundary semantics).
3. `AGENT_MID_CYCLE_ADMISSION_ENABLED` (default `true`) restores pure cycle-boundary admission
   for rollout protection.
4. The pass deliberately does **not** run cycle-start recovery jobs (stale-claim release,
   watchdog passes, GitHub sync) — those keep their per-cycle frequency contract.

What the patch deliberately does not do: no DB schema changes, no per-project long-lived lanes,
no change to sequential-project scheduling, no change to any concurrency cap semantics, and no
new required configuration (the flag defaults to the new behavior).

Known follow-up (out of scope for the patch): `listCoordinatorActionableProjectIds` orders by
`min(createdAt)` with the `COORDINATOR_MAX_CONCURRENT_PROJECTS` limit, so in a factory with more
than that many busy projects a freshly-created project's tasks can still wait behind older
actionable projects. The patch applies the same bound to the pass to preserve the knob's
contract; making lane-batch ordering arrival-aware is a separate, compatible improvement.
