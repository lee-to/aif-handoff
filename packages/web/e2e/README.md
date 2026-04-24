# Browser performance suite

Playwright-driven synthetic perf tests. These exercise the real web stack
(API + web bundle) against a running dev server and enforce latency budgets
so regressions fail the suite instead of shipping.

## Run

```bash
# one-time: install browsers
npm run perf:install --workspace=@aif/web

# then — from the repo root OR from packages/web
npm run perf --workspace=@aif/web
```

The config launches `npm run dev` at the repo root via `webServer` and reuses
an existing server if one is already up (so you can iterate against your local
dev shell). Set `AIF_SKIP_DEV_SERVER=1` to bypass the auto-launch entirely and
`AIF_WEB_URL` to point at a non-default web URL.

## What each spec measures

- `perf/dashboard-load.spec.ts` — cold kanban render. Asserts DOM-ready and
  LCP budgets after the first column paints.
- `perf/runtime-profiles-endpoint.spec.ts` — cold + warm `/runtime-profiles`
  timings from inside the browser (covers fetch, React Query, render).
- `perf/chat-sessions-endpoint.spec.ts` — cold + warm `/chat/sessions`
  timings keyed to the first project present in the dev DB.

## Budgets

Budgets live in `e2e/perf/utils.ts` (`PERF_BUDGETS`). Tune them after a few
runs on your hardware so the suite flags real regressions and not natural
variance. Each spec also prints the raw metrics to stdout so you can spot
drift even when the assertions still pass.

## Report

After a run, an HTML report is written to `playwright-report/`. Open it with:

```bash
npm run perf:report --workspace=@aif/web
```

Traces for failed runs live next to the report; open them in
`npx playwright show-trace <path>` for flame charts and network waterfalls.
