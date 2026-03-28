# TODO

- [ ] Add safe parallel task processing for agent pipeline (future work).
  - Implement atomic task claiming with lease fields (`claimedBy`, `claimedAt`, `leaseUntil`) to prevent double-pick.
  - Add configurable concurrency limits (`MAX_CONCURRENT_TASKS` and optional per-stage limits).
  - Replace sequential stage loop with a worker pool while preserving valid state transitions.
  - Add lease expiration and requeue logic for stuck/crashed workers.
  - Add concurrency tests (race conditions, duplicate-claim prevention, retry/requeue behavior).
- [ ] Create an AI chat for codebase questions.
