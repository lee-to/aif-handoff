# Swarm control plane

Handoff can observe and control one separately managed Swarm Runtime for one
configured Handoff project. Select the project, then **Swarm** next to **Tasks**.
Runtime owns planning, workers, scheduling, integration, policy checks and durable
events. Handoff never reads Runtime tables, checks out its branches, or starts or
stops the Runtime process. Closing the UI does not cancel a run.

## Connect

Configure the **API server**, then restart it:

```dotenv
AIF_SWARM_CONTROL_PLANE_ENABLED=true
SWARM_RUNTIME_URL=http://localhost:4317
SWARM_RUNTIME_TOKEN=your-runtime-service-credential
SWARM_PROJECT_ID=an-existing-handoff-project-id
SWARM_OPERATOR_IDS=participant-id-1,participant-id-2
```

The rollout flag defaults to `false`, independently of connection settings. Set it
to `true` to opt in; setting it back to `false` disables reads and commands without
contacting Runtime. The validated environment is cached until API restart.
URL, token and project ID are still required when the flag is on. The URL
is an origin with no path, credentials, query or fragment. Remote connections
require HTTPS. Local HTTP accepts `localhost`, `127.0.0.1`, `[::1]`,
`host.docker.internal` or the Docker service name `swarm`. In Docker, localhost
means the API container: use `http://host.docker.internal:4317` for a host Runtime
or `http://swarm:4317` for a service on the same network. Compose already forwards
`.env`; no new service or package is required. The Runtime must recognize the
configured connection. `SWARM_RUNTIME_TOKEN` must equal its `AIF_SWARM_OWNER_TOKEN`
(at least 32 characters). Start it in the intended Git project with
`ai-factory swarm serve --port 4317`. Its canonical project path must exactly equal
the Handoff project root path; Docker deployments need identical mount paths.

Credentials remain on the server and are never sent to the browser. The URL
cannot be supplied in a request. Redirects are rejected. Production access uses
Handoff's existing Participants Mode, session cookies, allowed origins and CSRF.
With Participants Mode disabled, the existing local trusted-user model applies:
the local user is owner. Do not expose that mode to untrusted users.

| Handoff identity                     | Swarm role | Permissions                                         |
| ------------------------------------ | ---------- | --------------------------------------------------- |
| Administrator                        | owner      | Read, create, pause/resume/cancel, decide approvals |
| Member named in `SWARM_OPERATOR_IDS` | operator   | Read, pause/resume/cancel                           |
| Other authenticated member           | viewer     | Read only                                           |

These roles apply only to the configured project. Other projects show a disconnected
panel. Run snapshots are checked against the configured project before reads or
mutations. Runtime authenticates the backend with its owner token; individual participant
permissions are enforced by Handoff. Runtime still enforces its execution policies.
The URL/token deployment binds one Runtime to one project. A nonempty list and all
run responses are fenced by `run.project`; foreign paths fail closed. The current
Runtime API exposes no project identity when the list is empty, so it cannot verify
a misconfigured binding before the first create. Configure this pair carefully.

## Use

**New Swarm run** collects a goal, acceptance criteria, explicit verification checks
as JSON argv arrays (for example `[["npm","test"]]`), Codex/Claude provider, optional
model, an aggregate agent limit (1–5), token budget and approval policy. The selected
provider/model applies to Lead and workers. The agent limit includes all roles.
The backend caps the per-attempt reservation at the smaller of 100,000 tokens and
the run budget. Runtime owns the remaining native defaults; no USD cap is implied.
Unknown cost (including subscription CLI runs) stays **Unknown**, never zero.
Overview shows Runtime's final status, progress, elapsed time, sandbox, blockers,
tokens and cost per integrated task. No active workers does not mean completed.

Tasks show reported results and git refs; unavailable durations/check output stay
unknown. Task graph separates dependency
arrows from a collapsible parent-child tree. Search and status filters narrow the
view; at most 200 matching tasks/nodes are rendered. A cycle is reported explicitly.
Agents expose provider/model, heartbeats and current task associations. The native
API does not expose full logs or assignment history. Integration & review shows refs,
metadata checks/reports and approve/reject decisions. Unavailable diffs and CI stay
unknown. Run update time and last-event summary are also unknown in list snapshots.

Pause, resume, cancel and approval decisions require confirmation. Lead instructions
and request-changes are not supported by this Runtime and are not offered.
Approval decisions also require a reason, retained in Handoff audit. The server persists audit intent before
dispatch and records accepted/unconfirmed outcomes after dispatch. Acceptance means
Runtime acknowledged the command; snapshots/events determine its actual result.
An uncertain response can be retried with the same command ID in the open dialog.
Runtime persists create/control idempotency keys across restarts. Approval retries
reconcile the target status first, including on terminal runs, because Runtime does
not deduplicate approval command IDs. Conflicting decisions fail with 409. Do not
assume an unconfirmed command failed.

The selected run streams SSE, restores missed events by sequence, removes duplicate
delivery and refreshes snapshots every 15 seconds. Lists refresh every 10 seconds.
On disconnect or failed snapshot refresh the UI shows **Stale state**, last sync time,
and disables controls. An expired/gapped cursor triggers a new snapshot and a visible
history-gap notice. The UI keeps up to 500 events; initial history loads up to 200.
Runtime retains the durable history. SSE connections rotate periodically and close
when the view closes; session revocation is rechecked at most every 10 seconds.

While a run is open, significant live events produce toasts. Desktop notifications
follow existing notification settings and already-granted browser permission.
Historical replay on first open produces no notifications; missed events after a
disconnect do. Completion/failure, budget exhaustion, long blocks, repeated worker
failures, integration failure and approvals are significant. Ordinary task events
do not notify. This MVP does not deliver background/server notifications after the
page is closed. Multi-host runners, remote provisioning, DAG editing, reassignment,
cloud artifact storage and log-retention administration remain Runtime concerns.

## Runtime v1 wire contract

The API normalizes the independently managed ai-factory Swarm Runtime into the
browser-safe [Handoff snapshot](swarm-v1.snapshot.json). The separate
[native snapshot fixture](swarm-runtime-v1.snapshot.json) represents actual Runtime
field names. Wire validators and normalization live in
`packages/api/src/services/swarmContract.ts`; browser schemas remain in
`packages/shared/src/swarm.ts`. No Runtime package/DB dependency is added.

Requests use `Authorization: Bearer <SWARM_RUNTIME_TOKEN>`. JSON envelopes and
events have `schema_version:1`; unknown versions fail closed. Native run/agent times
are epoch milliseconds; events use ISO timestamps. Unknown fields are stripped and
sensitive values redacted before browser exposure.

| Runtime endpoint                                | Native response                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `GET /v1/swarm/runs`                            | `{schema_version:1,runs:[publicRun]}`                              |
| `GET /v1/swarm/runs/{id}`                       | Atomic top-level `publicRun`, including `sequence` and collections |
| `POST /v1/swarm/runs`                           | Created/existing `publicRun`                                       |
| `POST /v1/swarm/runs/{id}/pause`                | Updated `publicRun`                                                |
| `POST /v1/swarm/runs/{id}/resume`               | Updated `publicRun`                                                |
| `POST /v1/swarm/runs/{id}/cancel`               | Updated `publicRun`                                                |
| `POST /v1/swarm/approvals/{id}/decision`        | `{schema_version:1,ok:true}`                                       |
| `GET /v1/swarm/runs/{id}/events?after=N`        | `{schema_version:1,events:[...]}`                                  |
| `GET /v1/swarm/runs/{id}/events/stream?after=N` | SSE replay and live events                                         |

Create sends only native SwarmSpec fields: `goal`, `acceptanceCriteria`, `checks`,
`lead`, `workers`, `approval`, `limits`. UUID `command_id` goes in `Idempotency-Key`,
never in the native body. Project IDs, actor objects, `confirmed` and
`schema_version` are Handoff fields and are not forwarded. Controls send `{}`;
approvals send only `{decision:"approve"|"reject"}`. Approval reason and participant
identity are audited by Handoff. Native replies are validated and scope-checked
before Handoff returns `{schema_version:1,command_id,run_id,accepted:true}` (202).

Native events have string `actor` and IDs inside `payload`, not at top level:

```json
{
  "schema_version": 1,
  "event_id": "event-3",
  "sequence": 3,
  "run_id": "run-1",
  "type": "task.submitted",
  "timestamp": "2026-11-10T09:02:00Z",
  "actor": "worker-1",
  "payload": { "task_id": "task-1" }
}
```

Handoff maps system actors to roles, agent actors to an ID with role `agent`, and
extracts task/agent references from the payload. Sequence is per run, contiguous,
and `after` is exclusive. Duplicate SSE delivery is ignored; gaps trigger snapshot
reconciliation. JSON responses are bounded to 10 MB and SSE frames to 1 MB.
HTTP 400/409/410 maps to safe `swarm_conflict` (409), 401/403 to forbidden, 404 to
not-found, and other upstream/network failures to unavailable. Upstream error text
is never reflected. Native input validation is enforced separately from UI validation.

## Checks

Run the Swarm shared/API/web tests and `npm run ai:validate`. To verify against an
actual built ai-factory checkout (Node >=22.13):

```bash
node --import tsx scripts/check-swarm-runtime.mjs /path/to/ai-factory
```

The probe starts real Runtime and Handoff HTTP servers on ephemeral loopback ports,
creates a disposable Git project/SQLite stores, checks creation and stable retries,
nonempty reads, pause/resume/cancel, SSE reconnect/replay, completion approval retries
and audit. Approval evidence is seeded by the Runtime test driver. It runs no model
processes, uses no production credentials and cleans up its servers and project.
Actual model execution and browser workflows are separate checks.
