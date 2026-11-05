# Verify gate remediation

Issue: https://github.com/lee-to/aif-handoff/issues/187

Docs: yes — update existing configuration and architecture documentation.

## Tasks

- [x] Parse the final Verify gate and run a bounded, fresh-session fix/verify loop, preserving reports and manually blocking unsafe failures.
- [x] Add validated remediation-limit configuration and document execution and safety behavior.
- [x] Cover passing, remediation, unsupported commands, non-convergence, fixer failure, session isolation, and final-gate parsing with regression tests.
- [x] Run package checklists and `npm run ai:validate`, record validation limitations, and inspect the diff before publishing the PR.
