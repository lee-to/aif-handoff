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
SWARM_RUNTIME_URL=http://localhost:4010
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
means the API container: use `http://host.docker.internal:4010` for a host Runtime
or `http://swarm:4010` for a service on the same network. Compose already forwards
`.env`; no new service or package is required. The Runtime must recognize the
configured project ID and the stored project root path (shared mounts in Docker).

Credentials remain on the server and are never sent to the browser. The URL
cannot be supplied in a request. Redirects are rejected. Production access uses
Handoff's existing Participants Mode, session cookies, allowed origins and CSRF.
With Participants Mode disabled, the existing local trusted-user model applies:
the local user is owner. Do not expose that mode to untrusted users.

| Handoff identity                     | Swarm role | Permissions                                                        |
| ------------------------------------ | ---------- | ------------------------------------------------------------------ |
| Administrator                        | owner      | Read, create, pause/resume/cancel, instruct Lead, decide approvals |
| Member named in `SWARM_OPERATOR_IDS` | operator   | Read, pause/resume/cancel, instruct Lead                           |
| Other authenticated member           | viewer     | Read only                                                          |

These roles apply only to the configured project. Other projects show a disconnected
panel. Run snapshots are checked against the configured project before reads or
mutations. Runtime must independently enforce actor permissions and restricted-action
policy; hiding controls is not the security boundary.

## Use

**New Swarm run** collects a goal, global acceptance criteria, worker limit, optional
USD budget and approval policy. Budget and limits are set at creation in this MVP.
Unknown cost (including subscription CLI runs) stays **Unknown**, never zero.
Overview shows Runtime's final status, progress, elapsed time, sandbox, blockers,
tokens and cost per integrated task. No active workers does not mean completed.

Tasks show results, checks, duration and git refs. Task graph separates dependency
arrows from a collapsible parent-child tree. Search and status filters narrow the
view; at most 200 matching tasks/nodes are rendered. A cycle is reported explicitly.
Agents expose task history, heartbeats and redacted logs. Integration & review
shows refs, diffs, CI, checks, conflicts, review and approval decisions.

Pause, resume, cancel, approval decisions and Lead instructions require confirmation.
Approval decisions also require a reason. The server persists audit intent before
dispatch and records accepted/unconfirmed outcomes after dispatch. Acceptance means
Runtime acknowledged the command; snapshots/events determine its actual result.
An uncertain response can be retried with the same command ID in the open dialog.
Runtime must persist idempotency keys across restarts and reject a key reused with
different input. Do not assume an unconfirmed command failed.

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

## Runtime v1 integration contract

The neighbouring `ai-factory-swarm` is implemented independently. This is the Handoff
consumer contract, **not a claim that a live Runtime already implements it**. Before
deployment, check its API against the published [snapshot fixture](swarm-v1.snapshot.json)
and [executable schemas](../packages/shared/src/swarm.ts). Contract tests cover this
fixture and malformed/foreign responses. No Runtime dependency is added to Handoff.

Requests use `Authorization: Bearer <SWARM_RUNTIME_TOKEN>`. Every JSON envelope and
every event has `schema_version: 1`; unsupported versions fail closed. IDs used in
paths contain only ASCII letters, digits, `_` and `-` (up to 200 characters).
Timestamps are ISO 8601 with timezone. Metrics are nonnegative; costs/budgets may
be explicitly null. Unknown fields are stripped before browser exposure.

| Runtime endpoint                                         | Required response                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/swarm/runs?project_id=<id>`                     | `{schema_version:1,runs:[SwarmRun]}`                                               |
| `GET /v1/swarm/runs/{id}`                                | Atomic `{schema_version:1,sequence,run,tasks,agents,artifacts,approvals}` snapshot |
| `POST /v1/swarm/runs`                                    | Command acknowledgement                                                            |
| `POST /v1/swarm/runs/{id}/pause`                         | Command acknowledgement                                                            |
| `POST /v1/swarm/runs/{id}/resume`                        | Command acknowledgement                                                            |
| `POST /v1/swarm/runs/{id}/cancel`                        | Command acknowledgement                                                            |
| `POST /v1/swarm/runs/{id}/instructions`                  | Command acknowledgement; instruction becomes a durable event                       |
| `POST /v1/swarm/approvals/{id}/decision`                 | Command acknowledgement                                                            |
| `GET /v1/swarm/runs/{id}/events?after=<sequence>`        | `{schema_version:1,events:[SwarmEvent]}` in sequence order                         |
| `GET /v1/swarm/runs/{id}/events/stream?after=<sequence>` | `text/event-stream`; durable replay then live delivery                             |

The snapshot watermark and its collections must be consistent. Sequence is **per
run**, contiguous, starts at 1 and never decreases or resets on restart. Event IDs
are stable and unique. `after` is exclusive; repeated delivery is allowed. SSE data
contains one complete JSON event (multiline SSE supported); heartbeat comments are
allowed. A stream must replay every retained event after the supplied cursor before
switching to live delivery. Retention gaps return HTTP 410, never silently skip.
An SSE frame is limited to 1 MB; a JSON response to 10 MB. Initial replay requests
start at most 200 sequences before the snapshot watermark.

```json
{
  "schema_version": 1,
  "event_id": "event-3",
  "sequence": 3,
  "run_id": "run-1",
  "type": "task.submitted",
  "timestamp": "2026-11-10T09:02:00Z",
  "actor": { "id": "worker-1", "role": "worker" },
  "task_id": "task-1",
  "agent_id": "worker-1",
  "payload": { "result": "Checks passed" }
}
```

Run statuses: `draft`, `queued`, `running`, `verifying`, `paused`, `needs_attention`,
`completed`, `failed`, `cancelled`. `completed_tasks` counts integrated tasks;
`last_event` is the latest `{type,timestamp,sequence}` or null. Task status, agent
status and artifact status are Runtime-owned strings; `pending` marks integration
queue entries. Approval status is `pending`, `approved`, `rejected` or
`changes_requested`.

All commands include `schema_version`, UUID `command_id`, `project_id` and trusted
`actor:{id,role}`; the same UUID is forwarded as `Idempotency-Key`. Creation adds
`goal`, `acceptance_criteria`, `worker_limit`, nullable `budget_usd`, `policy` and the
server-resolved `project_path`. Controls include `confirmed:true`. Instructions add
`instruction`; approval decisions add `run_id`, `approval_id`, `decision`
(`approve|reject|request_changes`) and `reason`. Runtime binds an approval to its run
and checks its current state atomically.

Acknowledgement: `{schema_version:1,command_id,run_id,accepted:true}` (2xx JSON).
Handoff responds 202 and verifies command/run IDs. Runtime HTTP 401/403, 404, 409 and
410 are mapped to structured safe errors; other failures yield 503. No upstream
error body or credential is reflected to the UI/logs. Commands must not take longer
than the API's 10-second response timeout; execution continues independently.

Notification event types: `run.completed`, `run.failed`, `run.cancelled`,
`run.needs_attention`, `budget.exhausted`, `task.blocked_long`,
`agent.repeated_failure`, `approval.requested`, `integration.failed`.

Runtime must redact secrets **before durable persistence**, enforce retention, audit
decisions and sandbox restricted operations. Handoff additionally redacts known
credentials, sensitive keys, common provider tokens, assignments and PEM private
keys from snapshots and events before transmission. It stores no full Runtime logs.

## Checks

Run `npm test --workspace=@aif/shared -- src/__tests__/swarm.test.ts`,
`npm test --workspace=@aif/api -- src/__tests__/swarm.test.ts` and the web Swarm tests,
then `npm run ai:validate`. For a real Runtime, create a disposable run, disconnect
and reconnect the event transport, and verify replay, command audit, policy denial
and viewer restrictions. A live Runtime test is still required after its API lands.
