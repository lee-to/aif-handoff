import { describe, expect, it } from "vitest";
import type { RuntimeLimitSnapshot, RuntimeLimitWindow } from "../types.js";
import {
  buildRuntimeLimitSignature,
  mapSafeRuntimeErrorReason,
  normalizeRuntimeLimitSnapshot,
  resolveRuntimeLimitFutureHint,
  sanitizeProviderMeta,
  selectViolatedWindowForExactThreshold,
} from "../runtimeLimitUtils.js";

function makeWindow(overrides: Partial<RuntimeLimitWindow> = {}): RuntimeLimitWindow {
  return {
    scope: "requests",
    percentRemaining: 50,
    warningThreshold: 10,
    resetAt: "2026-04-19T10:00:00.000Z",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<RuntimeLimitSnapshot> = {}): RuntimeLimitSnapshot {
  return {
    source: "api_headers",
    status: "warning",
    precision: "exact",
    checkedAt: "2026-04-19T09:00:00.000Z",
    providerId: "openai",
    runtimeId: "openai",
    profileId: "profile-1",
    primaryScope: "requests",
    resetAt: "2026-04-19T09:30:00.000Z",
    retryAfterSeconds: null,
    warningThreshold: 10,
    windows: [makeWindow()],
    providerMeta: null,
    ...overrides,
  };
}

describe("runtimeLimitUtils", () => {
  it("selects the strictest violated window for exact threshold gating", () => {
    const snapshot = makeSnapshot({
      windows: [
        makeWindow({
          scope: "requests",
          percentRemaining: 4,
          warningThreshold: 10,
          resetAt: "2026-04-19T09:05:00.000Z",
        }),
        makeWindow({
          scope: "tokens",
          percentRemaining: 3,
          warningThreshold: 10,
          resetAt: "2026-04-19T10:05:00.000Z",
        }),
      ],
    });

    const violated = selectViolatedWindowForExactThreshold(snapshot);

    expect(violated?.scope).toBe("tokens");
    expect(violated?.resetAt).toBe("2026-04-19T10:05:00.000Z");
  });

  it("breaks exact-threshold ties by lower percent remaining", () => {
    const snapshot = makeSnapshot({
      windows: [
        makeWindow({
          scope: "requests",
          percentRemaining: 7,
          warningThreshold: 10,
          resetAt: "2026-04-19T09:05:00.000Z",
        }),
        makeWindow({
          scope: "tokens",
          percentRemaining: 5,
          warningThreshold: 10,
          resetAt: "2026-04-19T09:05:00.000Z",
        }),
      ],
    });

    const violated = selectViolatedWindowForExactThreshold(snapshot);
    expect(violated?.scope).toBe("tokens");
    expect(violated?.percentRemaining).toBe(5);
  });

  it("resolves future hints with snapshot-first or window-first priority", () => {
    const snapshot = makeSnapshot({
      resetAt: "2026-04-19T09:30:00.000Z",
      retryAfterSeconds: null,
      windows: [
        makeWindow({
          scope: "tokens",
          resetAt: "2026-04-19T10:00:00.000Z",
        }),
      ],
    });
    const window = snapshot.windows[0]!;
    const nowMs = Date.parse("2026-04-19T09:00:00.000Z");

    const snapshotFirst = resolveRuntimeLimitFutureHint(snapshot, {
      nowMs,
      preferredWindow: window,
      windowFirst: false,
    });
    const windowFirst = resolveRuntimeLimitFutureHint(snapshot, {
      nowMs,
      preferredWindow: window,
      windowFirst: true,
    });

    expect(snapshotFirst.source).toBe("snapshot_reset_at");
    expect(snapshotFirst.resetAt).toBe("2026-04-19T09:30:00.000Z");
    expect(snapshotFirst.isFuture).toBe(true);

    expect(windowFirst.source).toBe("window_reset_at");
    expect(windowFirst.resetAt).toBe("2026-04-19T10:00:00.000Z");
    expect(windowFirst.windowScope).toBe("tokens");
  });

  it("falls back to retry-after when no reset timestamps are present", () => {
    const nowMs = Date.parse("2026-04-19T09:00:00.000Z");
    const snapshot = makeSnapshot({
      resetAt: null,
      retryAfterSeconds: 120,
      windows: [makeWindow({ resetAt: null, retryAfterSeconds: null })],
    });

    const hint = resolveRuntimeLimitFutureHint(snapshot, { nowMs });

    expect(hint.source).toBe("snapshot_retry_after");
    expect(hint.retryAfterSeconds).toBe(120);
    expect(hint.resetAt).toBe("2026-04-19T09:02:00.000Z");
    expect(hint.isFuture).toBe(true);
  });

  it("sanitizes provider meta via allowlist, key filtering, and token redaction", () => {
    const meta = sanitizeProviderMeta("anthropic", {
      providerLabel: "Anthropic",
      AccountFingerprint: "acct_123",
      status: "ok",
      body: "raw-provider-body",
      secret_token: "abc",
      randomField: "drop-me",
      modelUsageSummary: 'token=abc sk-SECRET "more"',
      diagnostics: "drop",
    });

    expect(meta).toEqual({
      providerLabel: "Anthropic",
      AccountFingerprint: "acct_123",
      status: "ok",
      modelUsageSummary: '[REDACTED] [REDACTED] "more"',
    });
  });

  it("truncates oversized provider meta payloads safely", () => {
    const oversizedReason = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`k${index}`, "x".repeat(256)]),
    );
    const meta = sanitizeProviderMeta("openai", {
      status: "ok",
      reason: oversizedReason,
    });

    expect(meta).toEqual({
      _truncated: true,
      status: "ok",
    });
  });

  it("normalizes runtime snapshots by sanitizing provider metadata", () => {
    const normalized = normalizeRuntimeLimitSnapshot(
      makeSnapshot({
        providerId: "openai",
        providerMeta: {
          status: "warning",
          token: "sk-SECRET",
          reason: "token=abc",
        },
      }),
    );

    expect(normalized.providerMeta).toEqual({
      status: "warning",
      reason: "[REDACTED]",
    });
  });

  it("builds deterministic signatures without checkedAt and window-order noise", () => {
    const snapshotA = makeSnapshot({
      checkedAt: "2026-04-19T09:00:00.000Z",
      windows: [
        makeWindow({
          scope: "tokens",
          name: "tokens",
          percentRemaining: 25,
          resetAt: "2026-04-19T09:20:00.000Z",
        }),
        makeWindow({
          scope: "requests",
          name: "requests",
          percentRemaining: 12,
          resetAt: "2026-04-19T09:10:00.000Z",
        }),
      ],
      providerMeta: {
        status: "warning",
        secret_token: "abc",
      },
    });
    const snapshotB = makeSnapshot({
      checkedAt: "2026-04-19T09:59:00.000Z",
      windows: [...snapshotA.windows].reverse(),
      providerMeta: {
        status: "warning",
      },
    });

    const signatureA = buildRuntimeLimitSignature(snapshotA);
    const signatureB = buildRuntimeLimitSignature(snapshotB);

    expect(signatureA).toBe(signatureB);
    expect(signatureA).not.toContain("secret_token");
  });

  it("maps runtime categories to safe reasons and falls back to unknown", () => {
    const expectations: Array<[string, string, string]> = [
      ["rate_limit", "Runtime usage limit reached.", "RUNTIME_RATE_LIMIT"],
      ["auth", "Runtime authentication failed.", "RUNTIME_AUTH_FAILED"],
      ["timeout", "Runtime request timed out.", "RUNTIME_TIMEOUT"],
      ["permission", "Runtime permissions blocked this task.", "RUNTIME_PERMISSION_BLOCKED"],
      ["stream", "Runtime stream failed.", "RUNTIME_STREAM_FAILED"],
      ["transport", "Provider temporarily unavailable.", "RUNTIME_PROVIDER_UNAVAILABLE"],
      [
        "model_not_found",
        "Configured model was not found for the selected runtime.",
        "RUNTIME_MODEL_NOT_FOUND",
      ],
      [
        "context_length",
        "Request exceeded the model context limit.",
        "RUNTIME_CONTEXT_LENGTH_EXCEEDED",
      ],
      ["content_filter", "Request blocked by provider content policy.", "RUNTIME_CONTENT_FILTERED"],
    ];

    for (const [category, reason, code] of expectations) {
      const mapped = mapSafeRuntimeErrorReason({ category });
      expect(mapped).toEqual({
        category,
        reason,
        code,
        isRuntimeError: true,
      });
    }

    expect(mapSafeRuntimeErrorReason(new Error("raw message"))).toEqual({
      category: "unknown",
      reason: "Runtime request failed.",
      code: "RUNTIME_UNKNOWN_ERROR",
      isRuntimeError: false,
    });
  });
});
