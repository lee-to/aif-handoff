# API load suite (k6)

Backend-level perf tests. Fire N concurrent virtual users against key API
routes so we catch stampede / cache-thrash / DB regressions that a single
browser in the Playwright suite cannot reveal.

## Prerequisites

- **k6 ≥ 1.0** on PATH. macOS: `brew install k6`. Linux/Windows: see
  <https://k6.io/docs/get-started/installation/>.
- API dev stack reachable at `AIF_API_URL` (default `http://localhost:3009`).
  The orchestrator probes `/health` and will boot `npm run dev` at the repo
  root if nothing is listening. Set `AIF_SKIP_DEV_SERVER=1` to opt out.

## Run

```bash
# one-shot via the root alias used by ai:validate
npm run ai:load

# or invoke a single script manually against a running API
k6 run --env AIF_API_URL=http://localhost:3009 packages/api/perf/k6/runtime-profiles.js
```

Summaries land in `packages/api/perf/reports/<script>.summary.json`;
`run.json` records which scripts were executed.

## Scripts

- `runtime-profiles.js` — 20 VU ramp + sustain on
  `/runtime-profiles?includeGlobal=true`. Thresholds: failure rate < 1%,
  p95 < 8s, p99 < 12s. Aimed at the server-side Codex session scan.
- `chat-sessions.js` — 10 VU constant load on
  `/chat/sessions?projectId=<first>`. Thresholds: p95 < 3s, p99 < 6s.
- `tasks.js` — 20 VU constant load on `/tasks`. Thresholds: p95 < 500ms,
  p99 < 1s — this endpoint must not touch the filesystem.

## Adding a script

1. Drop a new `*.js` into `k6/` exporting `options` (with thresholds) and a
   default function.
2. Import helpers from `./common.js` for consistent tagging and the shared
   `resolveFirstProjectId()` setup.
3. The orchestrator picks up every `*.js` except `common.js` automatically.
