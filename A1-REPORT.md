# A1 Report — upstream research issue + mid-cycle admission fix

Task `6be4ad3b-254e-4424-b887-e8c33675fc5f` · branch `feature/aif-admission-latency-a1-upstream-resear-6be4ad`
Base `main` = `d82e466` · fix commit `bd30d46` ("fix(agent): admit eligible parallel-project work mid-cycle") · this file and `ISSUE-ADMISSION-LATENCY.md` committed as a follow-up `docs:` commit on the same branch (the §6 harvest bundles the branch, and a git bundle carries commits only — untracked root files would be lost).
Dispatch note: the plan file `.ai-factory/plans/aif-admission-latency-a1-upstream-research-issue-mid-cycle-a.md` is **not materialized in this worktree** (`.ai-factory/plans/` contains other plans); the kickoff text embedded verbatim in the dispatch Description was used as the binding scope contract.
Post-handoff: this session resumed after the fix commit existed; it independently re-audited the work (§9) and completed §8.

## 1. §1 entry re-verification (rows 1–7, command + output)

### Row 1 — base commit

```
$ git log --oneline -3            # worktree
d82e466 Merge remote-tracking branch 'upstream/main'
966f5a4 fix(web): collapse project budget settings
f8b0862 Merge pull request #175 from lee-to/feature/github-project-clone

$ git -C /home/www/aif-handoff log --oneline -1   # factory base (read-only)
d82e466 Merge remote-tracking branch 'upstream/main'
```

✅ matches — worktree branched at the fork tip `d82e466`.

### Row 2 — clean tree, bundle origin

```
$ git status --porcelain
(empty)
$ git remote -v
origin  /tmp/aifh.bundle (fetch)
origin  /tmp/aifh.bundle (push)
```

✅ clean; `origin` is a local bundle — fetch impossible, recorded (not chased).

### Row 3 — source/binary identity check

```
$ grep -c 'FIX:149' packages/agent/src/coordinator.ts
6
```

✅ 6 markers — same source family as the running factory build the investigation measured.

### Row 4 — toolchain + egress

```
$ node -v
v22.23.2
$ npm -v
10.9.8
$ npm ping
npm notice PING https://registry.npmjs.org/
PONG 805ms
$ curl -m 6 -sS -o /dev/null -w '%{http_code}' https://github.com
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443
000   (exit 35)
```

✅ npm registry reachable, github.com closed by design — no fetch/PR attempts made (§4 floor).
Environment quirk (recorded): this container exports `NODE_ENV=production`, so npm config `omit=dev` — a bare `npm ci` installs production-only and the build fails on missing `vitest`. Baseline install used `npm ci --include=dev`.

### Row 5 — baseline before any edit

```
$ npm ci --include=dev
added 335 packages in 1m            # first (prod-only) run; --include=dev re-run completed cleanly

$ npm run build
Tasks: 7 successful, 7 total       # BUILD_EXIT=0

$ npm test --workspace @aif/agent
Test Files  1 failed | 26 passed (27)
Tests       1 failed | 385 passed (386)
```

**Pre-existing failure recorded:** `coordinator.test.ts > should serialize branch-isolated parallel projects while task worktrees are disabled` (`expected [plannerCalls] to have a length of 1 but got 2`). Root-caused (see Findings #1): **environmental**, not code — the factory container exports `AIF_TASK_WORKTREES_ENABLED=true`; the test assumes the default `false`. Proof: `AIF_TASK_WORKTREES_ENABLED=false npx vitest run … -t 'serialize branch-isolated'` → `1 passed`. Green claims below are scoped accordingly (container-env diff enumerated + decontaminated runs).

### Row 6 — conventions read before writing code

`CONTRIBUTING.md` (Conventional Commits, `npm test`/`npm run lint`, PR to `main`), `CHANGELOG.md` (Keep-a-Changelog, `## [Unreleased]` → `### Added/Fixed`), `.prettierrc` (width 100, double quotes), existing coordinator test patterns (`coordinator.test.ts`, `autoQueue.test.ts` — mocked subagent runners, `createTestDb`, `vi.stubEnv`/`process.env` before `import "../coordinator.js"`), `packages/agent/CHECKLIST.md` (single-flight poll item — updated, see below).

### Row 7 — optional live-DB re-verification (readonly)

`/data/aif.sqlite` reachable from the worktree toolchain; ran a readonly script (method: first `[ISO]` stamp in `agent_activity_log` − `created_at`; 2026-07-26 → 2026-09-11):

```
tasks-with-log: 206, instant(<2m): 93 (45.1%)
08-01 n=10 median=27.7m max=31.5m
08-12 n=14 median=2.8m  max=136.1m
```

Corroborates GIVEN row 9: instant ≈ half (45.1%), **Aug 01 median 27.7m and Aug 12 max 136.1m reproduce exactly**. (Temp script deleted after the run; DB never written.)

### Rows 8–10 — GIVEN, acknowledged

Incident timeline (row 8) and history table (row 9) carried into D1 verbatim-numbers. Row 10 anchors re-verified at the pre-fix HEAD (`d82e466`) with line contents — full quote sweep in gate row 7 below.

## 2. Design decision

**Chosen — mid-cycle admission pass on busy-cycle triggers (D1 design A):**

1. `processProjectLane` extracted from `runPollCycle`'s closure to module-level `runProjectLane(projectId, failedInCycle, projectConcurrencyCache)` — cycles and passes share one implementation (the `[FIX:149]` claim path, per-stage drain, semaphore usage are byte-for-byte the lane code).
2. `pollAndProcess()`'s busy branch additionally fires `triggerMidCycleAdmission()`: a **detached, single-flight** pass that runs `processAutoQueueAdvance()` (the identical CAS-protected lift) and then lanes for `listCoordinatorActionableProjectIds(COORDINATOR_MAX_CONCURRENT_PROJECTS)` **filtered to parallel-capable projects**.
3. Rollout flag `AGENT_MID_CYCLE_ADMISSION_ENABLED` (boolean, **default true**) — `false` restores pure cycle-boundary admission. Read via `getEnv()` at trigger time (same live-read pattern as `planner.ts`).

**Why sequential projects are excluded from pass lanes:** their one-task-at-a-time invariant is enforced by cycle lanes via `!parallel && hasActiveLockedTaskForProject` checks around the semaphore permit + the key-max-1 semaphore. A mid-cycle lane for a sequential project could otherwise claim a second task inside the brief lock gap between the first task's stages (the human-`start_ai`-while-mid-cycle shape from the incident). Excluding them makes "sequential semantics: exact current semantics" true by construction, not by race analysis.

**Why the pass is detached:** the busy branch returns `activePollPromise`; awaiting the pass inside it would re-serialize admission behind the very lane drain it exists to bypass.

**Rejected alternatives:**

- **B — per-project long-lived lanes:** architecturally cleanest but a rewrite of lane lifecycle (ownership, backpressure, `failedInCycle` scoping, watchdog placement). Scope theft vs. the bug size; documented in D1 as the candidate upstream might eventually want.
- **Full concurrent poll cycle on wake:** duplicates cycle-start side effects (stale-claim release, GitHub sync) per tick and destroys the documented coalescing contract.
- **Pass restricted to projects without an open cycle lane:** incorrect for the "lane already past the stage" case (task human-started into `planning` while its project's lane sits at `implementer` — the incident's exact state at 12:45). Uniform lane execution + CAS claims handles both cases; requires no lane tracking.
- **Project-exclusive CAS in the data layer** (`NOT EXISTS active lock on sibling tasks` inside `claimCoordinatorTaskIfEligible`): would additionally close a **pre-existing cross-replica** race on sequential projects (two coordinator replicas can both pass the `hasActiveLockedTaskForProject` check and claim different tasks). Not needed for in-process safety (single event loop + synchronous better-sqlite3 make check→claim atomic within a turn), so recorded as Findings #2 rather than fixed — avoiding a data-layer change the outcome contract does not require.

**Risk notes / deliberate omissions:** no DB schema change; no new required config; `COORDINATOR_MAX_CONCURRENT_PROJECTS` bound applied to the pass as well (knob contract preserved — the known starvation edge in >cap factories is documented in D1 as follow-up); cycle-start recovery jobs stay per-cycle.

## 3. Gate — ten rows, command + output

### Row 1 — file scope

Final state (after the deliverables `docs:` commit — see header for why the two root files are commits, not untracked files):

```
$ git status --porcelain          # at handoff
(empty)
$ git diff --stat main | tail -1
13 files changed, 1106 insertions(+), 167 deletions(-)   # 11 code/doc paths + the two root deliverables
```

Exactly two new root files (D1 `ISSUE-ADMISSION-LATENCY.md`, D4 `A1-REPORT.md`); the 11 changed code/doc paths are: `packages/agent/src/coordinator.ts` (the fix), `packages/agent/src/__tests__/midCycleAdmission.test.ts` (D3, new), `packages/agent/src/__tests__/coordinator.test.ts` (coalescing-contract test pinned to flag-off, +9 lines), `packages/agent/src/__tests__/hooks.test.ts` (+1: new env key in the typed env fixture), `packages/shared/src/env.ts` + `env.test.ts` (flag declaration + default assertion — the minimal sibling the rollout lever genuinely needs), and convention-mandated docs: `CHANGELOG.md`, `docs/architecture.md` (new "Mid-Cycle Admission" section), `docs/configuration.md` (env table + polling note), `.env.example`, `packages/agent/CHECKLIST.md` (single-flight item updated per its "keep checklists alive" rule). **No path outside these.**

### Row 2 — baseline before edits

Quoted in §1 row 5 above: `npm ci --include=dev` clean, build 7/7, agent tests 385/386 with the single pre-existing environmental failure recorded and root-caused.

### Row 3 — D3 regression test exists, named, green

```
$ cd packages/agent && npx vitest run --configLoader runner src/__tests__/midCycleAdmission.test.ts
Tests  3 passed (3)
```

File: `packages/agent/src/__tests__/midCycleAdmission.test.ts` —
① `starts processing a parallel project's backlog task while another project's lane is mid-pass` (the D3 outcome test), ② `does not start a sequential project's next task mid-cycle`, ③ `keeps cycle-boundary admission when AGENT_MID_CYCLE_ADMISSION_ENABLED=false`.

### Row 4 — the test proves the outcome

Arrange: project A (`busy-proj`, parallel) with task `a1` at `plan_ready` whose **implementer mock hangs on a test-controlled gate** — the poll cycle is provably mid-pass; project B (`idle-proj`, parallel + auto-queue, slot free) **empty at cycle start**; mid-cycle, `b1` (backlog) and `b2` (backlog) are inserted — the incident shape (tasks created 12:27 while the cycle ran since 12:22).

```ts
const cycle = pollAndProcess();
await vi.waitFor(() => expect(runImplementer).toHaveBeenCalledWith("a1", "/tmp/busy-root"));
seedTask("b1", "idle-proj", { position: 100 });
seedTask("b2", "idle-proj", { position: 200 });
void pollAndProcess(); // scheduler tick / wake during active cycle
```

Assert (while A's gate is **still unresolved** — not cycle-end luck):

```ts
await vi.waitFor(() => expect(runPlanner).toHaveBeenCalledWith("b1", "/tmp/idle-root"));
expect(plannerStatusAtCall["b1"]).toBe("planning"); // runner invoked → processing started (T-ADM-B)
expect(gates.get("a1")!.isResolved()).toBe(false); // busy lane still mid-pass          (T-ADM-A)
expect(taskStatus("b1")).toBe("implementing"); // admitted task reached a hung implementer
expect(taskStatus("b2")).toBe("backlog"); // per-project cap (pinned to 1) respected
expect(getStageSemaphore().totalActive()).toBe(2); // shared-capacity accounting
```

Act-then-release: both gates resolve, `await cycle`, both tasks `done` — drain through the normal machinery.

### Row 5 — sequential semantics

```
$ npx vitest run --configLoader runner src/__tests__/coordinator.test.ts -t '1 task at a time for non-parallel'
Tests  1 passed | 69 skipped (70)
$ npx vitest run --configLoader runner src/__tests__/autoQueue.test.ts
Tests  25 passed (25)          # includes the whole "sequential project (parallelEnabled = false)" block
```

Plus new test ② (parallel control project admitted mid-cycle while the sequential project's second task — human-started into `planning` — stays untouched until the follow-up cycle): green in row 3. Existing pre-fix sequential suite unchanged and green.

### Row 6 — full agent-package suite vs baseline

```
baseline (container env):  Tests  1 failed  | 385 passed (386)
now       (container env):  Tests  1 failed  | 388 passed (389)   # same single environmental failure
now  (AIF_TASK_WORKTREES_ENABLED=false):  Tests  389 passed (389)
shared package (touched):   Tests  235 passed (235)
```

Diff vs baseline: +3 tests (the new file), 0 new failures; the 1 failure is the pre-existing `AIF_TASK_WORKTREES_ENABLED` leak (Findings #1), failing identically before and after.

### Row 7 — D1 anchors re-verified at HEAD (pre-fix `d82e466`), line content quoted

```
$ git show d82e466:packages/agent/src/coordinator.ts | sed -n '<n>p'
:907  export function processAutoQueueAdvance(): number {
:977      while (active < limit) {
:995          if (!claimBacklogTaskForAdvance(next.id, autoQueueCommit)) {
:1048 async function runPollCycle(): Promise<void> {
:1062   processAutoQueueAdvance();
:1115   async function processProjectLane(projectId: string): Promise<void> {
:1295 export function pollAndProcess(): Promise<void> {
:1296   if (activePollPromise) {
:1297     followUpPollRequested = true;
:1298     log.debug("Poll cycle already active; queued one follow-up cycle");
$ git show d82e466:packages/data/src/index.ts | sed -n '<n>p'
:2305 export function claimBacklogTaskForAdvance(
:2625 export function nextBacklogTaskByPosition(projectId: string): TaskRow | undefined {
```

All ten row-10 anchors exist at the exact cited lines with the expected content. (Anchors cite the **pre-fix** commit because D1 describes upstream behavior; the fix commit moves these lines, which is the point of the patch.) Log-line strings from GIVEN row 8 (`Poll cycle already active; queued one follow-up cycle`, `[FIX:149] Revalidating task candidate after coordinator permit`) cross-checked against source read at `d82e466`.

### Row 8 — D1 content checklist

- [x] Title + one-paragraph symptom (bounded by longest in-flight lane, not own capacity)
- [x] Mechanism with the re-verified anchors + serialized-cycle explanation (advance once per `runPollCycle`, lanes awaited to drain, follow-up coalescing in `pollAndProcess`)
- [x] Row 8 timeline verbatim (12:22:48.753 → 13:58:14.829, 90.6–90.7 min)
- [x] Row 9 stats table with collection method (first activity-log timestamp − `created_at`, 200 tasks, 2026-07-26 → 2026-09-11) and the honest caveat (instant ≈ half — cost lands on busy factories)
- [x] Two candidate designs with trade-offs + a shared risk list (double-processing, cap bypass, sequential regression, review-gate reentrancy)
- [x] Concrete proposal (what the patch does / deliberately does not) + known follow-up (lane-batch ordering starvation in >cap factories)

### Row 9 — no factory operations

Self-audit: the complete session command log contains **zero** `docker`, `docker compose`, `kill`, `restart`, `service`, or process-management commands, and no writes to `/data/aif.sqlite` (single readonly open, `readonly: true`, closed; temp script deleted). Verified by reviewing every Bash invocation issued this session (git/npm/npx/curl/grep/sed/ls within the worktree, plus read-only `git -C /home/www/aif-handoff log`). Egress floor respected — no github.com access attempts (row 4 shows it fails by design).

### Row 10 — T7 + T19

T7 section below; T19 cold pass below it.

## 4. T7 counter-prompt

**Written prompt:** _"What would make this fix look working when it is not? Check: (a) the test's busy lane A actually stays busy (not an instantly-exiting fake); (b) the task is really PROCESSING (runner invoked), not merely advanced to `planning`; (c) caps are not bypassed under the new path; (d) admission is not cycle-end luck; (e) the flag-off path is exactly baseline."_

**What was run:**

1. **Baseline-revert run (the decisive check):** stashed the coordinator fix (`git checkout -- packages/agent/src/coordinator.ts` after saving `git diff` as a patch), re-ran the new tests:
   ```
   test ① alone on baseline:  FAIL — AssertionError: expected "vi.fn()" to be called with
                               arguments: [ 'b1', '/tmp/idle-root' ]     (1 failed | 2 skipped)
   test ③ alone on baseline:  PASS (1 passed | 2 skipped)   — correct: flag-off IS baseline behavior
   ```
   Then re-applied the patch → 3/3 green. The outcome test fails **at the processing assertion** on unfixed code — the incident reproduces, the test detects the fix's absence.
2. **(a)+(d) busy-lane reality:** `a1`'s implementer hangs on a gate; `gates.get("a1").isResolved() === false` is asserted **in the same breath** as b1's admission — admission provably happened mid-cycle, and the final drain only runs after the gates release.
3. **(b) advance ≠ admission:** asserted `runPlanner` called with `b1` **and** the status captured at runner-call time (`plannerStatusAtCall["b1"] === "planning"`) and `taskStatus("b1") === "implementing"` (reached a hung implementer) — a status flip without processing cannot pass these.
4. **(c) caps:** per-project cap pinned to 1 in the test env → `b2` stays `backlog` while `b1` in flight; semaphore `totalActive() === 2`.
5. **What the check surfaced (both real, both fixed):**
   - **Env-snapshot bug:** my first extraction captured `GLOBAL_MAX_TASKS` at module load; the codebase's tests override env **in place** (`Object.assign(getEnv(), …)`), so the global-cap test caught a genuine cap bypass (`peakActivePlanners 3 > 2`). Fixed by reading `env.COORDINATOR_MAX_CONCURRENT_TASKS` at call time — the pre-existing tests did their job.
   - **Contract-test conflict:** `should drain started lane tasks before propagating a later candidate setup failure` asserts the old "overlapping poll starts no new work" invariant; pinned to the flag-off configuration with a comment (mid-cycle admission has its own file). The agent CHECKLIST item was updated to the new contract.

## 5. T19 cold pass over D1/D4

Re-read both deliverables start-to-finish after completion, checking: every number in D1 against GIVEN rows 8–9 (12:22:48.753 / 12:27:40–47 / 16× / 13:58:14.033 / 13:58:14.829 / 90.6–90.7 min; medians 27.7 / 58.9 / 45.8 / 57.3 / 66.6 / 65.4; maxima 136.1 / 151.2 / 174.4 / 225.6 / p90 978.2; "instant ≈ half") — all verbatim; anchors match the row-7 quote sweep; the collection method and caveat are labeled; ≥2 candidates with trade-offs present; the proposal states what the patch does and does not do. D4 rows 1–10 each carry command+output; the verdict line matches the evidence (agent suite 388/389 container-env / 389/389 decontaminated; regression test named and green). One correction applied from the pass: noted explicitly in D4 §1 that the cited anchors are at pre-fix `d82e466` and why.

## 6. Findings (maintainer-relevant)

1. **Test-hermeticity gap (pre-existing, root cause of the baseline failure):** `coordinator.test.ts` is not hermetic w.r.t. `AIF_TASK_WORKTREES_ENABLED`. The factory container exports `=true`, flipping `projectRequiresSerialExecution` so `should serialize branch-isolated parallel projects…` fails (2 planner calls instead of 1) **at plain `main`** in such environments. One-line candidate fix (not applied — outside admission path): pin `process.env.AIF_TASK_WORKTREES_ENABLED = "false"` at the file top like the neighboring flags, per the `autoQueue.test.ts` precedent. Same class: `api/codexAuth.routes.test.ts` expects `AIF_ENABLE_CODEX_LOGIN_PROXY` default `false` and fails under the container's `=true` (blocks a clean `npm run ai:validate` in this environment; passes with the flag pinned).
2. **Cross-replica sequential-project race (pre-existing):** the `!parallel && hasActiveLockedTaskForProject` guard and the subsequent CAS claim are not one atomic operation; two coordinator **replicas** can interleave check→claim and start two tasks of the same non-parallel project. In-process (single event loop, synchronous SQLite) this cannot interleave — my analysis and the new pass rely on that. Airtight fix would be a project-exclusive condition inside `claimCoordinatorTaskIfEligible` (`NOT EXISTS` an active sibling lock). Almost fixed here; left as an upstream candidate.
3. **Lane-batch ordering starvation (pre-existing, documented in D1):** `listCoordinatorActionableProjectIds` orders by `min(createdAt)` under the `COORDINATOR_MAX_CONCURRENT_PROJECTS` limit, so in factories with more than that many actionable projects, younger projects' tasks can still wait behind older ones. The pass intentionally applies the same bound to preserve the knob's contract.
4. **In-place env override is load-bearing:** tests mutate the cached env object via `Object.assign(getEnv(), …)`; any coordinator code that snapshots env values at module load silently breaks that pattern (this task introduced and caught exactly that bug). Worth a lint rule or a convention note.
5. **`npm ci` in prod containers:** with `NODE_ENV=production`, npm omits devDeps and `npm run build` fails on missing `vitest`; use `npm ci --include=dev` (relevant to the repo's own "air-gapped production deploys" guidance in `packages/agent/src/index.ts`).
6. **`run-perf.mjs` ready-probe is dual-stack fragile (post-handoff, pre-existing):** the probe fetches `http://localhost:5180` while vite defers to 5181 on whatever family it bound — in any environment where 5180 is occupied by an IPv4-only listener (or the probe's node build doesn't fall back across families, as observed here), the stage deadlocks into the 120s timeout even though a perfectly good vite is serving one `fetch` literal away. Candidate upstream fix (not applied — web package, outside this branch's scope): have `run-perf.mjs` pass an explicit `--port` to vite and probe that port by literal (`127.0.0.1` and `[::1]`), instead of probing a fixed URL while letting vite wander.

## 7. Parked questions

One (raised post-handoff, §8):

- **PARK — `ai:perf` (web) cannot run inside the factory container; validate fully post-harvest.** Stated as: _"`npm run ai:validate` passes format/lint/test×6/coverage/build/protocol/checklist decontaminated, but the `ai:perf` web stage is blocked in this container by three image facts (live factory owns `[::1]:5180`; the probe's node-fetch never falls back from refused IPv4 to listening IPv6; Chromium system libs absent). The floors forbid freeing the port. Operator: re-run `npm run ai:validate` in a clean environment after harvest; expect green, or expect to set `AIF_WEB_URL` to an explicit literal if 5180 is occupied there too."_ Park-independent work continued (everything else recorded in this report).

No other operator forks were hit: egress closure and no-factory-operations floors were respected without workarounds; no upstream state changed after `d82e466` requiring adjudication; the plan-file absence (dispatch Description carried the binding copy) is recorded in the header rather than parked, per the "record, don't chase" instruction of row 2's spirit.

## 8. `npm run ai:validate`

**Container env** (two flags leaked from the factory into this shell: `AIF_TASK_WORKTREES_ENABLED=true`, `AIF_ENABLE_CODEX_LOGIN_PROXY=true`) fails at the `test` stage on the two pre-existing environmental tests of Findings #1 — re-verified post-handoff, both directions:

```
$ npx vitest run --configLoader runner src/__tests__/codexAuth.routes.test.ts          # packages/api, leaked flag
× reports login-proxy capabilities from environment defaults        → 1 failed | 4 passed (5)
$ AIF_ENABLE_CODEX_LOGIN_PROXY=false npx vitest run … codexAuth.routes.test.ts
Tests  5 passed (5)
```

**Decontaminated run** (`AIF_TASK_WORKTREES_ENABLED=false AIF_ENABLE_CODEX_LOGIN_PROXY=false npm run ai:validate`, exit code 1 at `ai:perf` only):

| Stage                   | Result                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `format:check` + `lint` | pass                                                                                                            |
| `test` (6 workspaces)   | pass — web 728/728, shared 235/235, runtime 901 passed + 1 skipped, mcp 103/103, **agent 389/389**, api 489/489 |
| `coverage` (≥70% rule)  | pass (build followed, so thresholds held)                                                                       |
| `build`                 | pass (7/7 turbo tasks)                                                                                          |
| `ai:perf` (web)         | **FAIL — environment-blocked, see below**                                                                       |
| `ai:load`               | exit 0 (k6 not on PATH → script skips by design; verified no server contact happens before the skip)            |
| `ai:protocol`           | pass — "Codex app-server protocol artifacts are in sync with CLI 0.145.0"                                       |
| `ai:checklist`          | pass (echo warning)                                                                                             |

**`ai:perf` root cause — peeled to the bottom, every step quoted (post-handoff session):**

1. Default failure: `Timed out waiting 120000ms for http://localhost:5180` after vite logs `Port 5180 is in use, trying another one... ➜ Local: http://localhost:5181/`.
2. This task's container **is the factory container** (explains the leaked env flags and the §4 floors): `/proc/net/tcp6` shows the running factory's web UI already LISTENing on `[::1]:5180` (state `0A`), so the perf run's vite cannot take 5180 and defers to `[::1]:5181`.
3. The ready-probe (`run-perf.mjs` → `fetch(READY_URL, {method:"HEAD"})`, accept <500) can never succeed in this node/undici build here:
   ```
   $ curl -m 4 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:5180/   → 000 (refused; nothing on IPv4)
   $ node -e "fetch('http://localhost:5180/')"                             → ECONNREFUSED (no family fallback)
   $ node -e "fetch('http://[::1]:5181/')"   [with a vite on ::1:5181]     → 200
   $ node -e "dns.lookup('localhost',{all:true})"  → ::1 then 127.0.0.1    (resolution is fine; undici just doesn't fall back)
   ```
4. With `AIF_WEB_URL="http://[::1]:5181"` the ready-wait **passes** (root cause confirmed) and Playwright starts — then fails for lack of installed browsers; `npx playwright install chromium` succeeds (CDN reachable), and the re-run reaches `browserType.launch` → `Target page, context or browser has been closed` / `kill ESRCH`; the binary run directly says `error while loading shared libraries: libglib-2.0.so.0` — the image lacks Chromium's system-lib stack; fixing means apt/root image surgery, out of scope and floors.
5. **Pre-existing and code-independent:** `git diff --name-only main -- packages/web` is empty — the stage runs byte-identical code at `main`; all three blockers (port owned by the live factory, undici no-fallback quirk, missing browser libs) are container-image facts. The floors forbid freeing the port (that would be operating the factory).

**Disposition:** recorded as a parked operator fork (§7): re-run `npm run ai:validate` post-harvest in a clean environment. Does not affect the §3 gate.

## 9. Post-handoff re-audit (2026-09-12, second session)

HANDOFF_MODE resumed the task after `bd30d46` and the two drafted root files existed. Trust nothing, re-run everything material (T2/T3/T12):

- **Fix commit audited against the design claim** — diff read in full: closure lane extracted verbatim to module-level `runProjectLane(projectId, failedInCycle, projectConcurrencyCache)`; `resolveProjectConcurrency` → `resolveProjectConcurrencyCached`; `pollAndProcess` busy branch fires single-flight, detached `triggerMidCycleAdmission()`; flag read at trigger time via `getEnv()` (line 1392; module-level `const env = getEnv()` at line 72 keeps in-place test overrides live — the T7 env-snapshot fix holds). Test file read in full: asserts runner invocation with status captured at call time, busy-lane gate unresolved at the same instant, per-project cap, semaphore accounting.
- **Gate rows re-run fresh, all matching the original claims:**
  ```
  midCycleAdmission.test.ts        Tests  3 passed (3)
  coordinator.test.ts -t '1 task at a time for non-parallel'   1 passed | 69 skipped (70)
  autoQueue.test.ts                Tests  25 passed (25)
  full agent suite (container env) Tests  1 failed | 388 passed (389)   # same single pre-existing env failure
  full agent suite (AIF_TASK_WORKTREES_ENABLED=false)  Tests  389 passed (389)
  shared package                   Tests  235 passed (235)
  ```
- **All ten row-10 anchors re-quoted at `d82e466`** — `coordinator.ts:907/977/995/1048/1062/1115/1295-1298`, `data/index.ts:2305/2625`, each line content matching D1's citations.
- **§8 completed** (the one gap the handoff surfaced): full `ai:validate` driven to its terminal state — every code-quality stage green decontaminated; `ai:perf` proven environment-blocked three layers deep (§8), `ai:load`/`ai:protocol`/`ai:checklist` run individually, green/skip.
- **Findings #1 re-verified both directions** (`codexAuth.routes.test.ts`: 1 failed under leaked flag, 5/5 with it pinned).
- **No factory operations this session either:** the only processes started/stopped were this worktree's own (`npx vite` scratch servers on 5181/5199, found via `/proc/*/fd` socket-inode scan and killed by exact PID; the perf runner's own dev stack). No docker, no signals to factory processes, no `/data/aif.sqlite` access at all this session.

## Verdict

A1: GREEN — fix single-flight mid-cycle admission pass (advance + parallel-project lanes on busy-cycle triggers, flag `AGENT_MID_CYCLE_ADMISSION_ENABLED` default true), regression test midCycleAdmission.test.ts green (3/3, and fails-at-assertion on unfixed code), suite baseline 385/386 → 388/389 container-env / 389/389 decontaminated (single pre-existing environmental failure unchanged), issue text complete.

Scope note (does not affect the ten gate rows): `npm run ai:validate` is green through format/lint/test/coverage/build/protocol/checklist decontaminated; its `ai:perf` (web) stage is blocked by this container's image, not by the branch (§8) — parked for a post-harvest re-run in a clean environment (§7).
