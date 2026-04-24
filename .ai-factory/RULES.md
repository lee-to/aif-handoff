# Project Rules

> Short, actionable rules and conventions for this project. Loaded automatically by /aif-implement.

## Rules

- Every package must maintain at least 70% test coverage (measured by @vitest/coverage-v8)
- Write code following SOLID and DRY principles
- Always run after implementation: `npm run ai:validate`
- Always check test coverage after implementation and ensure it meets the 70% threshold
- **Reuse existing UI components** from `packages/web/src/components/ui/` before creating new ones. Compose primitives (Dialog + Button, etc.) instead of writing new wrappers.
- **Sync new UI components with Pencil.** Any new visual component must have a corresponding design in the Pencil design system (`.pen` files). Use `pencil` MCP tools (`batch_design`, `get_guidelines`) to create or update the design representation.
- **No expensive CSS properties.** Never use `box-shadow`, `backdrop-filter`, `filter: blur()`, `text-shadow`, or other GPU/paint-heavy CSS in components. These trigger costly compositing and repaint cycles, especially on low-end devices and during scroll/animation. Use `border`, `outline`, `opacity`, or solid `background-color` as lightweight alternatives.
- **Sync Docker config when packages change.** When adding a new package under `packages/` or introducing new inter-package dependencies, update `.docker/Dockerfile`, `docker-compose.yml`, and `docker-compose.production.yml` to reflect the changes. Always verify the Docker build succeeds: `docker compose build`.
- **Sync docs when runtime adapters change.** When adding a new adapter to `packages/runtime/src/adapters/` or changing adapter capabilities, update `docs/providers.md` (Supported Runtimes table), verify `TEMPLATE.ts` conventions, register in `bootstrap.ts`, and update Dockerfile if needed.
- **Migration version numbers are append-only — never renumber an existing entry.** In `packages/shared/src/db.ts`, never change the `version` or `sql` of a previously merged migration. If a feature branch has collided on a version with `main`, resolve by appending a NEW migration at the next free version rather than renumbering. Reason: user DBs track `PRAGMA user_version`; silently swapping the SQL for an already-applied version causes those DBs to skip the new SQL forever (see the v13 runtime_limit incident). When resolving merge conflicts in the `MIGRATIONS` array, always bump the losing branch to a new trailing version — never edit a slot already on `main`.
- **Never use `as T` to strip a nullable return.** Helpers like `asRecord(x)` return `T | null`. Do not write `const r = asRecord(x) as T` — the cast silently removes `| null` and subsequent property access crashes at runtime on real-world nullable inputs. Always declare the union explicitly (`as T | null`) and guard with `if (!r) return null` before property access. Applies to any `unknown → T` narrowing helper, not just `asRecord`.
