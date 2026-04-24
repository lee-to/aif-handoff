---
name: pr-review
description: >-
  Review a GitHub pull request and post a verdict comment. Stateful — if a previous review
  comment exists, review only the new commits since the last review and track whether prior
  findings were addressed. Focus on code cleanliness, duplication, and docs sync. Use when
  user says "review this PR", "check the PR", "leave a review on <PR URL>", or passes a PR
  URL / number.
argument-hint: "<PR URL | PR number>"
allowed-tools: Bash(gh *) Bash(git *) Bash(jq *) Read Glob Grep AskUserQuestion
disable-model-invocation: false
metadata:
  author: AI Factory
  version: "1.0"
  category: quality
---

# PR Review — Stateful Reviewer with Verdict Comment

Review a GitHub pull request end-to-end and post a single verdict comment. Respects the
aif convention: loads project context (RULES.md, CHECKLIST.md, config.yaml), applies context
gates, stays read-only on `.ai-factory/*`, and writes only one artifact — the PR comment.

**Core focus:**

1. Code cleanliness — no debug markers, no TODO/FIXME leaks, no dead code, no unreachable branches.
2. Duplication — DRY violations, N+1 patterns, repeated blocks that should be extracted or hoisted.
3. Docs sync — when code changes, the matching docs (README, `docs/**`, sync rules from CLAUDE.md) change too.

**Not a lint replacement.** Assume CI covers formatting, type errors, and compile failures. Focus on
judgment-level findings that humans otherwise miss on review.

---

## Step 0: Load Context

### 0.1 Load config.yaml

**FIRST:** Read `.ai-factory/config.yaml` if it exists to resolve:

- **Paths:** `paths.description`, `paths.architecture`, `paths.rules_file`, `paths.roadmap`, and `paths.rules`
- **Language:** `language.ui` — use for the final comment's language (default: English)
- **Git:** `git.base_branch` — used when the PR targets a non-standard base

If config.yaml is absent, use defaults:

- Paths: `.ai-factory/` for all artifacts
- Language: English
- Base branch: `main`

### 0.2 Load Project Context

Read in parallel:

- `.ai-factory/DESCRIPTION.md` — tech-stack summary
- `.ai-factory/ARCHITECTURE.md` (if present) — dependency boundaries
- `.ai-factory/RULES.md` — axioms that the PR MUST respect
- `CHECKLIST.md` (repository root) — top-level checklist items
- `CLAUDE.md` (root) — project instructions; in particular the **Sync Rules** sections
  (Docker Sync Rule, Runtime Adapter Sync Rule, and any other `Sync when ...` rules)

Store the parsed rule/checklist text; cite specific lines in findings rather than paraphrasing.

### 0.3 Load Skill Context Override

**Read `.ai-factory/skill-context/pr-review/SKILL.md`** — MANDATORY if the file exists.

This file contains project-specific review rules accumulated by `/aif-evolve`. They override the
general rules in this SKILL.md where they conflict, and add to them where they don't.

**Enforcement:** after drafting the verdict comment, verify it honors every skill-context rule.
If a rule says "review MUST check X" or "comment MUST include section Y" — augment the output.
A review that silently ignores skill-context rules is a bug.

---

## Step 1: Resolve the PR

### 1.1 Parse the Argument

The argument is the PR URL or number:

- `https://github.com/OWNER/REPO/pull/NNN` → extract `OWNER`, `REPO`, `NNN`
- `#NNN` or `NNN` → current repo (`gh repo view --json nameWithOwner`), PR = `NNN`

If the argument is missing or unparseable:

```
AskUserQuestion: Which PR should I review?

Options:
1. Paste PR URL
2. Use current branch's PR (if any) — via `gh pr status`
3. Cancel
```

Record the parsed triple as `OWNER`, `REPO`, `PR`.

### 1.2 Fetch PR Metadata

```bash
gh pr view $PR --repo $OWNER/$REPO --json \
  title,body,author,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,\
  files,additions,deletions,commits,updatedAt,statusCheckRollup,latestReviews,url
```

If `state` is not `OPEN` → ask whether to continue:

```
AskUserQuestion: PR is <CLOSED|MERGED>. Review anyway?

Options:
1. Yes — review the final state
2. Cancel
```

### 1.3 Detect Head Repo

Forks need a different API host for `contents` calls:

```bash
gh pr view $PR --repo $OWNER/$REPO --json headRepository,headRepositoryOwner
```

Store the head `OWNER/REPO` and `headRefOid` — use them when fetching file contents via
`gh api repos/<head-owner>/<head-repo>/contents/<path>?ref=<headRefOid>`. The upstream repo
ref may not resolve if the contributor hasn't pushed to upstream.

---

## Step 2: Determine Review Mode

### 2.1 Look for Prior Reviewer Comments

```bash
gh api repos/$OWNER/$REPO/issues/$PR/comments \
  --jq '.[] | {user: .user.login, created_at, body}'
gh api repos/$OWNER/$REPO/pulls/$PR/reviews \
  --jq '.[] | {user: .user.login, state, submitted_at, body}'
```

The **current viewer** is:

```bash
gh api user --jq .login
```

Mode selection:

- **Fresh mode** — no comments or reviews from the viewer exist → review the full PR.
- **Follow-up mode** — at least one prior comment/review from the viewer exists → review only
  the delta since the last one, and reconcile against the prior findings.

### 2.2 Follow-Up Mode: Compute Delta

Find the viewer's most recent comment timestamp `LAST_REVIEW_AT`. The delta is:

- **New commits** authored after `LAST_REVIEW_AT`:

  ```bash
  gh pr view $PR --repo $OWNER/$REPO --json commits \
    --jq '.commits[] | select(.committedDate > "<LAST_REVIEW_AT>") | .oid'
  ```

- **Files changed** in those commits:

  ```bash
  for SHA in $NEW_SHAS; do
    gh api repos/$HEAD_OWNER/$HEAD_REPO/commits/$SHA --jq '.files[].filename'
  done
  ```

Re-read the viewer's most recent review comment text and extract the concrete findings
(every numbered item or bullet). For each finding, classify it in the new delta:

- `ADDRESSED` — the change resolves it (cite commit + file:line).
- `UNRESOLVED` — the concern still applies.
- `SUPERSEDED` — the surrounding code was rewritten in a way that makes the finding moot.

If the delta is empty and nothing new was pushed:

```
AskUserQuestion: No new commits since the last review. What now?

Options:
1. Re-check CI state and post a short status comment
2. Cancel
```

---

## Step 3: Gather the Diff

### 3.1 Scope

- **Fresh mode:** full PR diff.

  ```bash
  gh pr diff $PR --repo $OWNER/$REPO
  ```

  If the diff is larger than ~200 KB, save it with `--patch > /tmp/pr-$PR.diff` and use
  `Read` with `offset`/`limit` to page through it. Do not try to hold the whole thing in memory.

- **Follow-up mode:** per-commit diffs for the new commits only.

  ```bash
  for SHA in $NEW_SHAS; do
    gh api repos/$HEAD_OWNER/$HEAD_REPO/commits/$SHA --jq '.files[] | {filename, patch}'
  done
  ```

### 3.2 File Classification

Partition changed files by area — each area has different sync obligations:

| Pattern                             | Area                   | Sync Obligation                                                          |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `packages/runtime/src/adapters/**`  | Runtime adapter        | `docs/providers.md`, `TEMPLATE.ts`, `bootstrap.ts`, Dockerfile if native |
| `packages/*/src/**` (non-adapter)   | Package source         | Package `CHECKLIST.md`, tests, relevant `docs/**`                        |
| `packages/web/src/components/ui/**` | UI primitive           | Pencil `.pen` sync rule from CLAUDE.md                                   |
| `packages/web/src/components/**`    | UI composition         | Reuse-existing-primitive rule                                            |
| `packages/api/src/routes/**`        | REST surface           | `docs/api.md`                                                            |
| `packages/shared/src/schema.ts`     | DB schema / migrations | Migration hygiene + related read paths                                   |
| `packages/shared/src/db.ts`         | DB runtime             | Migration ordering, backfill                                             |
| `.docker/**`, `docker-compose*.yml` | Container config       | Docker Sync Rule                                                         |
| `docs/**`, `README.md`              | Documentation          | Internal consistency                                                     |
| `.ai-factory/**`                    | AI context             | **Read-only for this skill.** Flag drift, don't edit.                    |

Store `TOUCHED_PACKAGES = <unique set of packages/*/ roots from the diff>`.

---

## Step 4: Review Checks

Run each check against the scoped diff. Collect findings as structured entries:

```
{severity: must-fix | should-fix | nit, category, file, line, message, suggestion?}
```

### 4.1 Code Cleanliness

For every changed hunk, scan for:

- Developer markers: `[FIX]`, `[TODO]`, `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`
  in source, logs, and error messages — unless explicitly approved in the PR description.
- Debug leftovers: `console.log`, `console.debug`, `print("debug")`, `debugger`, `pdb.set_trace`,
  and similar.
- Dead code: unused imports, unreachable branches (look for `= false` constants gating
  a JSX/block, `if (false)`, `return; <unreachable>`), stale re-exports.
- Commented-out code blocks (single-line comments describing current tech or a ticket
  number are fine; multi-line commented-out code is not).
- Mojibake in strings / test assertions — stray `вЂ`, `вЂ" `, `вЂ"`, `Ñ`-prefixed runs,
  Windows-1252 → UTF-8 corruption. These often slip in when Windows editors roundtrip
  em-dashes. Check test files too — a test that asserts absence of a garbled string is a
  silent false-positive.

For each finding: cite file + line number + the line content.

### 4.2 Duplication (DRY)

- Identical or near-identical code blocks repeated in 2+ places (rough threshold: 5+ lines
  or 3+ call sites).
- N+1 patterns: per-item DB round-trips inside a `.map` / loop where the same value could
  be resolved once outside. Common hot spots: `list` endpoints, React-Query hooks.
- Redundant calls: the same lookup re-done when the result is already in scope.
- Cross-package duplication of the same helper that should live in `@aif/shared` or a
  similar shared package.

Prefer concrete recommendations: "hoist X out of the map" / "extract Y to `@aif/shared`
because it's used in Z and W".

### 4.3 Docs Sync

Walk the file classification table from Step 3.2. For each touched area, check whether the
corresponding doc was updated **in this PR**:

```bash
gh pr view $PR --repo $OWNER/$REPO --json files --jq '.files[].path'
```

Concrete obligations from `CLAUDE.md`:

- **Runtime Adapter Sync Rule** — new adapter or capability change ⇒ `docs/providers.md`
  (Supported Runtimes table + Usage Reporting column), `TEMPLATE.ts` conventions,
  `bootstrap.ts` registration, Dockerfile if native deps. Every adapter declares
  `capabilities.usageReporting` and returns `RuntimeRunResult.usage` as a concrete value.
- **Docker Sync Rule** — new package / new inter-package dep ⇒ `.docker/Dockerfile`,
  `docker-compose.yml`, `docker-compose.production.yml`.
- **DB schema change** — `packages/shared/src/schema.ts` changed ⇒ migration added in
  `packages/shared/src/db.ts`, `user_version` bumped, backfill covered in tests.
- **API route change** — new or modified route in `packages/api/src/routes/**` ⇒
  `docs/api.md` updated (query params, body schema, response shape).
- **New env var** — referenced in code but not in `.env.example` / `docs/configuration.md`.

### 4.4 CHECKLIST.md Compliance

For each package in `TOUCHED_PACKAGES`:

```
Read packages/<pkg>/CHECKLIST.md
```

Walk every checklist item. For each, evaluate:

- Does the PR's change honor it?
- If not applicable to this change, note it explicitly (don't silently skip).

The root `CHECKLIST.md` rules also apply globally (e.g., "No string-based error classification").

### 4.5 RULES.md Compliance

Walk `.ai-factory/RULES.md` rules explicitly. For each rule, flag any clear violation in
the diff. Examples from this repo: 70 % coverage, SOLID/DRY, reuse UI primitives, sync
Docker, no expensive CSS, sync adapter docs.

### 4.6 Context Gates (Read-Only)

Produce a gate verdict for each:

- **Architecture gate** — PR respects documented boundaries (e.g., `api`/`agent`/`runtime`
  only access DB via `@aif/data`).
- **Rules gate** — explicit `RULES.md` violations.
- **Roadmap gate** — if `.ai-factory/ROADMAP.md` exists, `feat`/`fix`/`perf` PRs should
  reference the milestone. Missing linkage is a WARN, clear contradiction is an ERROR.

Use:

- `WARN [gate-name] ...` — non-blocking.
- `ERROR [gate-name] ...` — blocking for `REQUEST_CHANGES`.

---

## Step 5: Verdict and Comment

### 5.1 Severity Rollup

- **`must-fix`** — blocking. Any bug with user-visible impact, security issue, explicit
  rule violation, broken docs contract, or finding that caused red CI.
- **`should-fix`** — not blocking for the PR but the review expects it before the next
  release or as a follow-up.
- **`nit`** — opinion / polish. Author may decline with no justification.

### 5.2 Choose Verdict

| Condition                                                  | Verdict           |
| ---------------------------------------------------------- | ----------------- |
| No `must-fix` and CI green                                 | `APPROVE`         |
| Any `must-fix`, or red CI caused by PR changes             | `REQUEST_CHANGES` |
| Only `should-fix` / `nit`, or flaky CI unrelated to the PR | `COMMENT`         |

In follow-up mode, if all previously-raised `must-fix` are `ADDRESSED` and no new `must-fix`
appeared, prefer `APPROVE`.

### 5.3 Draft the Comment

Use this skeleton (in the resolved UI language; English by default):

```markdown
## Code review

<one-paragraph overall take — what's the PR doing, what's the risk profile>

### Must fix

1. **<short title>** — <file>:<line> — <what + why + suggested fix>

### Should fix

<similar, shorter entries>

### Nits

<bullets>

### Context gates

- Architecture: <pass/warn/error> — <note>
- Rules: <pass/warn/error> — <note>
- Roadmap: <pass/warn/error> — <note>
- CHECKLIST compliance (touched packages: <list>): <pass/warn/error>
- Docs sync: <pass/warn/error>

<optional "Positive notes" section when something is genuinely well done>
```

**Follow-up mode additions:**

- Open with a "response pass" section: `Addressed: ✔`, `New: ⚠`, `Still unresolved: ✖`
  mapped to the prior findings.
- Reference the prior comment URL so the history chain stays easy to follow.
- Close with one line stating the new verdict (`LGTM now` / `still blocked by X`).

### 5.4 Post the Comment

Double-check before posting:

- No mojibake in the draft (re-read it yourself).
- All file paths are real (spot-check 2–3 via `Read` / `Glob`).
- Line numbers match the PR head SHA, not an outdated local ref.
- Each `must-fix` has an actionable recommendation — not just "this is wrong".

Post as a single comment (not a review) so follow-up mode can detect it next time:

```bash
gh pr comment $PR --repo $OWNER/$REPO --body "$(cat <<'EOF'
<comment body>
EOF
)"
```

Capture the returned URL and report it to the user.

### 5.5 Do Not

- Do not post inline line comments unless the user explicitly asks — a single top-level
  comment composes better with follow-up mode.
- Do not run destructive git or `gh` commands (no `gh pr close`, no `gh pr merge`, no
  `git push`). The skill is review-only.
- Do not edit `.ai-factory/**`. If you detect drift there, flag it and suggest the owning
  skill (`/aif-rules`, `/aif-roadmap`, etc.).

---

## Examples

**User:** `/pr-review https://github.com/lee-to/aif-handoff/pull/82`
Fresh review on PR #82. Loads rules + checklists, checks the full diff, posts a verdict.

**User:** `/pr-review #82`
Same but resolves the repo from the current working tree via `gh repo view --json nameWithOwner`.

**User:** `/pr-review 82` — after the author pushed 2 follow-up commits
Follow-up mode. Reads the previous review comment, diffs only the new commits, maps every
prior finding to ✔ / ⚠ / ✖, posts a delta comment and a fresh verdict.

---

## Tips

- Context is heavy after a review. Suggest `/clear` or `/compact` when handing back.
- If CI is red for reasons unrelated to the PR (flaky external tests, infra), call that out
  explicitly rather than letting it drive the verdict.
- Be constructive — lead with the strongest concern, make every recommendation actionable,
  acknowledge the genuinely good parts. A review that reads as a checklist rant gets
  ignored; one that reads as a collaborator stays useful.
