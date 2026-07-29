# Runtime Model Effort Discovery Design

## Goal

Populate the Effort control from the currently selected model for Claude, Codex, OpenCode, and OpenRouter. Use the existing runtime-specific list only when discovery cannot provide model-level values.

## Contract

`RuntimeModel.metadata` remains the transport-neutral discovery boundary:

- `supportedEffortLevels: string[]` is the authoritative ordered list for a model.
- `defaultEffort: string` is the provider-advertised default when available.
- `supportsEffort: false` means the model explicitly does not expose an effort control.
- Missing effort metadata means discovery cannot determine the levels and the web fallback applies.

Effort values are provider data. Runtime code normalizes non-empty strings and removes duplicates, but does not filter them through a model-era allowlist.

## Adapter Mapping

- Claude maps `supportedModels()` fields already returned by the Agent SDK.
- Codex maps every non-empty `supportedReasoningEfforts[].reasoningEffort` value returned by app-server `model/list`.
- OpenCode maps `variants[*].reasoningEffort` from provider model records and supports both array and object-shaped model collections.
- OpenRouter maps `reasoning.supported_efforts` and `reasoning.default_effort` from `GET /models`.

Values selected from discovery must reach each transport without a second stale allowlist. Provider-side validation remains authoritative.

## Web Behavior

The form resolves effort levels in this order:

1. The selected discovered model's `metadata.supportedEffortLevels`.
2. No control when `metadata.supportsEffort` is explicitly `false`.
3. The runtime-specific default list when metadata is absent or incomplete.

Changing the model recomputes the choices immediately. An already stored effort that is not valid for the new model is omitted on save instead of being sent silently.

## Failure Handling

Model discovery retains the existing adapter fallback behavior. A discovery error or a provider payload without effort metadata does not block profile editing; the UI uses the default list.

## Verification

Regression tests cover arbitrary new Codex levels, OpenCode variant extraction, OpenRouter reasoning metadata, selected-model UI updates, fallback behavior, and forwarding a newly discovered value to runtime requests.
