# Implementation Plan: Codex OAuth Login via Web UI

Branch: feature/codex-login-ui
Created: 2026-04-17

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: Skipped by user — focused auth feature, not tied to a milestone.

## Context and Problem

`codex login` inside the `agent` container starts an HTTP listener on `127.0.0.1:1455` and waits for the OAuth callback. The host browser cannot reach the container's loopback. The CLI **does not** expose any flag/env var to bind the listener to `0.0.0.0` (verified: codex 0.118 has no `--host`, `--port`, or `CODEX_LOGIN_HOST` — see recon).

**Solution:** Run a small HTTP broker inside the `agent` container that:

1. On request, spawns `codex login`, parses the auth URL from stdout, returns it to the client.
2. Accepts a callback URL from the client and performs a GET against `127.0.0.1:1455/...` over its own loopback (reachable inside the namespace), completing the OAuth flow.
3. Can cancel an in-flight session (kill the child process).

The `api` service proxies requests from the web form to the broker over the docker network (`agent:3010`). The endpoint is feature-flagged (enabled only in dev compose) and the callback URL is strictly validated (allowlist for scheme/host/port and required query params).

## Alternatives (mention in docs)

- **`OPENAI_API_KEY` in `.env`** — recommended path for production. Skips OAuth entirely.
- **CLI fallback** `aif-codex-callback "<url>"` — shell helper baked into the image; user runs `docker compose exec agent aif-codex-callback "<url>"` from a second terminal. Minimal no-UI path, kept as backup.

## Architecture

```
[Browser]
   │  (1) GET auth URL → ChatGPT OAuth
   │  (2) Redirect: http://localhost:1455/?code=…&state=…  (fails on host)
   │  (3) User copies URL → pastes into form
[Web UI: <CodexLoginCard>]
   │  POST /auth/codex/login/start    ─┐
   │  POST /auth/codex/login/callback ─┤
   │  POST /auth/codex/login/cancel   ─┤
[API: routes/codexAuth.ts] (feature-flag, zod validation, SSRF guard)
   │  proxy → http://agent:3010/codex/login/*
[Agent: codexLoginBroker.ts] (Hono, bind 0.0.0.0:3010, docker-network only)
   │  start    → spawn `codex login`, parse stdout, hold child process
   │  callback → fetch http://127.0.0.1:1455/?code=…&state=… (own loopback)
   │  cancel   → SIGTERM child
[codex CLI listener: 127.0.0.1:1455]
   │  → writes ~/.codex/auth.json → process exits
```

## Security

- **Feature flag `AIF_ENABLE_CODEX_LOGIN_PROXY`** — broker and api endpoints do not start unless `true`. Disabled by default in production compose.
- **SSRF guard on api**: zod schema + explicit URL parser. Allowed only `scheme=http`, `host ∈ {127.0.0.1, localhost}`, `port=1455` (or env override), required `code` and `state`. Any deviation → 400 without proxying.
- **Broker listens on docker bridge only** — port 3010 is not mapped to host in `docker-compose.yml` (reachable only by services on the same compose network).
- **Logs are redacted**: `code` and `state` masked before write (`code=***redacted***`).
- **One-shot race**: broker tracks that only one login session can be active. Repeat `start` without `cancel`/success → 409.
- **Production compose**: documented to prefer `OPENAI_API_KEY` over the broker. If the user enables the flag anyway — broker is not externally reachable (no port mapping), but the api endpoint is exposed. Document the risk.

## Commit Plan

- **Commit 1** (tasks 1–3): `feat(agent): add codex login broker for in-container OAuth callback`
- **Commit 2** (tasks 4–6): `feat(api): proxy codex login flow with SSRF-guarded validation`
- **Commit 3** (tasks 7–9): `feat(web): add Codex login wizard to runtime settings`
- **Commit 4** (tasks 10–12): `chore(docker): wire codex login broker into compose, add fallback CLI helper`
- **Commit 5** (tasks 13–15): `test: cover codex login broker, api proxy, and UI wizard`
- **Commit 6** (tasks 16–18): `docs: document Codex Docker auth flow in README and providers`

## Tasks

### Phase 1: Codex Login Broker (agent)

- [x] Task 1: Create `packages/agent/src/codex/loginBroker.ts` — Hono mini-app bound to `0.0.0.0:${AIF_CODEX_LOGIN_BROKER_PORT:-3010}`. Endpoints: `POST /codex/login/start`, `POST /codex/login/callback`, `POST /codex/login/cancel`, `GET /codex/login/status`. Runtime-side only; do not wire into the coordinator yet.
- [x] Task 2: In `loginBroker.ts`, implement the `codex login` lifecycle: spawn via `node:child_process.spawn` with unbuffered stdio, regex-parse the auth URL from stdout (format `https://chatgpt.com/auth/authorize?...` or similar), 5-minute timeout for user action. Hold `currentSession: { childPid, authUrl, state, startedAt } | null`.
- [x] Task 3: Implement the broker callback proxy: zod-validate body `{ url: string }`, parse the URL, check `host=127.0.0.1`, `port=1455`, presence of `code` and `state` (state must match the one stored in the session), `fetch` GET against the URL, await child process exit with a 30s timeout, return status. On any error — keep child alive for retry.

### Phase 2: API Layer

- [x] Task 4: Create `packages/api/src/routes/codexAuth.ts` with `POST /auth/codex/login/start|callback|cancel`, `GET /auth/codex/login/status`. Each is a thin proxy to `${AGENT_INTERNAL_URL:-http://agent:3010}` via `fetch`. Register in `packages/api/src/index.ts`.
- [x] Task 5: Add zod schemas in `packages/api/src/schemas.ts` (`codexCallbackSchema`) with double protection: api-level validation (allowlist host/port/scheme/required code+state) before proxying. Errors → 400 with structured body `{ error: "invalid_callback_url", reason }`. Wire in via `zodValidator` middleware.
- [x] Task 6: Feature flag in `packages/api/src/index.ts`: `/auth/codex/*` routes register only when `process.env.AIF_ENABLE_CODEX_LOGIN_PROXY === "true"`. Declare default in `packages/shared/src/env.ts` (`false`).

### Phase 3: Web UI

- [x] Task 7: Create `packages/web/src/components/settings/CodexLoginCard.tsx` — 4-step wizard: (a) "Start" → POST start, show auth URL with copy button and note "open in browser, wait for the redirect to localhost:1455, then copy the URL from the address bar"; (b) textarea "Paste callback URL"; (c) submit → POST callback → loading; (d) success/error + reminder `docker compose restart agent`. Reuse existing UI primitives only (`Card`/`Button`/`Input`/`Dialog`). Do NOT add new primitives without a Pencil sync.
- [x] Task 8: Add React Query mutations in `packages/web/src/hooks/useCodexLogin.ts`: `useStartCodexLogin`, `useSubmitCodexCallback`, `useCancelCodexLogin`, `useCodexLoginStatus` (1s polling while a session is active). Add matching methods to `packages/web/src/lib/api.ts`.
- [x] Task 9: Embed `<CodexLoginCard>` in `packages/web/src/components/settings/RuntimeProfileForm.tsx` (or a dedicated settings section) — show only when the selected runtime is codex-* AND the feature flag is active. Expose the flag via `GET /api/runtime/capabilities` (new) or extend an existing health endpoint. Hide the card for non-Docker / API-key scenarios.

### Phase 4: Docker / CLI fallback

- [x] Task 10: Update `docker-compose.yml` (dev) — agent service: add `expose: ["3010"]` (internal docker-network port, no host mapping). Add `AIF_ENABLE_CODEX_LOGIN_PROXY=true` to the dev section. In `docker-compose.production.yml` — explicitly set the flag to `false`.
- [x] Task 11: Create `.docker/aif-codex-callback.sh` — fallback CLI helper: takes URL as argument, validates (host/port/scheme/code/state), `curl`s `127.0.0.1:1455`. Copy into the image via `.docker/Dockerfile`, symlink to `/usr/local/bin/aif-codex-callback`. Use case: `docker compose exec agent aif-codex-callback "<url>"` when the broker is unavailable.
- [x] Task 12: Update `packages/agent/src/index.ts` — in coordinator startup, conditionally start `loginBroker` if `AIF_ENABLE_CODEX_LOGIN_PROXY=true`. Log `[CodexLoginBroker] listening on 0.0.0.0:3010` (DEBUG). On coordinator SIGTERM — graceful broker shutdown + kill the active login session.

### Phase 5: Tests

- [x] Task 13: Vitest unit tests for the URL validator (broker and api): `packages/agent/src/codex/__tests__/loginBroker.url.test.ts`, `packages/api/src/__tests__/codexAuth.validation.test.ts`. Cases: `https` scheme (reject), `evil.com:1455` (reject), `127.0.0.1:80` (reject), `localhost:1455` without code (reject), valid URL (accept), state mismatch (reject).
- [x] Task 14: Integration test for the broker callback proxy: `packages/agent/src/codex/__tests__/loginBroker.integration.test.ts`. Stand up a mock HTTP server on `127.0.0.1:{free port via env override}`, invoke broker callback, assert the mock got a GET with the right query, broker returned 200. Mock spawn `codex login` via `vi.mock('node:child_process')`.
- [x] Task 15: Component test for `CodexLoginCard`: `packages/web/src/components/settings/__tests__/CodexLoginCard.test.tsx` (Vitest + @testing-library/react). Drive the wizard state machine: start → display URL → paste callback → success. Verify the copy button copies the URL, error state shows message.

### Phase 6: Documentation

- [x] Task 16: Update `README.md` "Authentication" section — add a "Codex (Docker)" subsection: link to the UI flow in Settings, screenshot/diagram of the wizard, fallback CLI command, mention `OPENAI_API_KEY` as the production-preferred option. Keep `AGENTS.md` in sync.
- [x] Task 17: Update `docs/providers.md` (Codex section) — describe the broker architecture, env vars (`AIF_ENABLE_CODEX_LOGIN_PROXY`, `AIF_CODEX_LOGIN_BROKER_PORT`, `AGENT_INTERNAL_URL`), security caveats (dev-only, SSRF guard, redacted logs), production guidance: "use `OPENAI_API_KEY`".
- [x] Task 18: Update `docs/configuration.md` — env vars table: `AIF_ENABLE_CODEX_LOGIN_PROXY` (default `false`), `AIF_CODEX_LOGIN_BROKER_PORT` (default `3010`), `AGENT_INTERNAL_URL` (default `http://agent:3010`).

## Logging Requirements (cross-cutting)

Every task must add logging in the format `[Component.method] message {data}`, with levels `DEBUG`/`INFO`/`WARN`/`ERROR`, via `pino` from `@aif/shared/logger`. Sensitive fields (`code`, `state`, auth headers) must be masked (`***redacted***`). DEBUG: enter/exit of all broker endpoints and api routes, spawn result, child process status, GET proxying. INFO: login success, cancel success. WARN: invalid URL, expired session. ERROR: spawn fail, fetch fail, parse fail.

## Validation (after implementation)

- `npm run ai:validate` (lint + types + tests + coverage ≥70%).
- Manual smoke test in dev compose: `docker compose up`, open UI Settings → run wizard → complete OAuth → verify `~/.codex/auth.json` is written into the `codex-auth` volume.
- Mandatory docs checkpoint via `/aif-docs` (since `Docs: yes`).
