import { describe, expect, it } from "vitest";
import type { RuntimeLimitSnapshot, RuntimeLimitWindow } from "../types.js";
import {
  buildRuntimeLimitSignature,
  mapSafeRuntimeErrorReason,
  normalizeRuntimeLimitSnapshot,
  redactProviderText,
  redactProviderTextForLogs,
  resolveRuntimeLimitFutureHint,
  sanitizeProviderMeta,
  sanitizeRuntimeLimitSnapshotForExposure,
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

  it("prefers the explicit preferred window by default when resolving future hints", () => {
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

    const preferredWindowFirst = resolveRuntimeLimitFutureHint(snapshot, {
      nowMs,
      preferredWindow: window,
    });
    const snapshotFirst = resolveRuntimeLimitFutureHint(snapshot, { nowMs });

    expect(preferredWindowFirst.source).toBe("window_reset_at");
    expect(preferredWindowFirst.resetAt).toBe("2026-04-19T10:00:00.000Z");
    expect(preferredWindowFirst.windowScope).toBe("tokens");
    expect(preferredWindowFirst.isFuture).toBe(true);

    expect(snapshotFirst.source).toBe("snapshot_reset_at");
    expect(snapshotFirst.resetAt).toBe("2026-04-19T09:30:00.000Z");
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

  it("prefers a future snapshot retry-after over an expired preferred window reset", () => {
    const nowMs = Date.parse("2026-04-19T09:00:00.000Z");
    const snapshot = makeSnapshot({
      resetAt: null,
      retryAfterSeconds: 600,
      windows: [
        makeWindow({
          scope: "requests",
          resetAt: "2026-04-19T08:30:00.000Z",
          retryAfterSeconds: null,
        }),
      ],
    });

    const hint = resolveRuntimeLimitFutureHint(snapshot, {
      nowMs,
      preferredWindow: snapshot.windows[0],
      windowFirst: true,
    });

    expect(hint.source).toBe("snapshot_retry_after");
    expect(hint.retryAfterSeconds).toBe(600);
    expect(hint.isFuture).toBe(true);
  });

  it("ignores invalid preferred window resetAt values when a valid snapshot retry-after exists", () => {
    const nowMs = Date.parse("2026-04-19T09:00:00.000Z");
    const snapshot = makeSnapshot({
      resetAt: null,
      retryAfterSeconds: 60,
      windows: [
        makeWindow({
          scope: "requests",
          resetAt: "not-a-date",
          retryAfterSeconds: null,
        }),
      ],
    });

    const hint = resolveRuntimeLimitFutureHint(snapshot, {
      nowMs,
      preferredWindow: snapshot.windows[0],
      windowFirst: true,
    });

    expect(hint.source).toBe("snapshot_retry_after");
    expect(hint.retryAfterSeconds).toBe(60);
    expect(hint.isFuture).toBe(true);
  });

  it("sanitizes provider meta via allowlist, key filtering, and token redaction", () => {
    const meta = sanitizeProviderMeta("anthropic", {
      providerLabel: "Anthropic",
      quotaSource: "zai_monitor",
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
      quotaSource: "zai_monitor",
      AccountFingerprint: "acct_123",
      status: "ok",
      modelUsageSummary: 'token=[REDACTED] [REDACTED] "more"',
    });
  });

  it("keeps only known nested summary fields inside structured provider metadata", () => {
    const meta = sanitizeProviderMeta("anthropic", {
      modelUsageSummary: {
        granularity: "hour",
        sampledAt: "2026-04-19T09:00:00.000Z",
        totalModelCallCount: 12,
        totalTokensUsage: 3456,
        topModels: [
          {
            modelName: "glm-4.5",
            totalTokens: 3200,
            sortOrder: 1,
            raw: "drop-me",
          },
        ],
        debug: "drop-me",
      },
      toolUsageSummary: {
        granularity: "hour",
        sampledAt: "2026-04-19T09:00:00.000Z",
        totalNetworkSearchCount: 3,
        tools: [
          {
            toolName: "web_search",
            totalCount: 3,
            response: "drop-me",
          },
        ],
        diagnostics: "drop-me",
      },
    });

    expect(meta).toEqual({
      modelUsageSummary: {
        granularity: "hour",
        sampledAt: "2026-04-19T09:00:00.000Z",
        totalModelCallCount: 12,
        totalTokensUsage: 3456,
        topModels: [{ modelName: "glm-4.5", totalTokens: 3200 }],
      },
      toolUsageSummary: {
        granularity: "hour",
        sampledAt: "2026-04-19T09:00:00.000Z",
        totalNetworkSearchCount: 3,
        tools: [{ toolName: "web_search", totalCount: 3 }],
      },
    });
  });

  it("preserves limitId while stripping non-allowlisted provider metadata", () => {
    const meta = sanitizeProviderMeta("codex", {
      limitId: "codex_bengalfox",
      accountLabel: "Anton Ageev Pro",
      usageDetails: [{ raw: "drop-me" }],
      accountEmail: "private@example.com",
    });

    expect(meta).toEqual({
      limitId: "codex_bengalfox",
      accountLabel: "Anton Ageev Pro",
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
      reason: "token=[REDACTED]",
    });
  });

  it("strips account identifiers from task/chat-facing runtime snapshots", () => {
    const sanitized = sanitizeRuntimeLimitSnapshotForExposure(
      makeSnapshot({
        providerId: "anthropic",
        providerMeta: {
          providerLabel: "Anthropic",
          quotaSource: "sdk_event",
          accountId: "acct-1",
          accountName: "Shared Account",
          accountLabel: "Team Plan",
          accountFingerprint: "fingerprint-1",
          planType: "pro",
        },
      }),
      "task",
    );

    expect(sanitized.providerMeta).toEqual({
      providerLabel: "Anthropic",
      quotaSource: "sdk_event",
      planType: "pro",
    });
  });

  it("redacts provider text for logs without dropping the whole message", () => {
    expect(
      redactProviderText(
        '429 {"error":"secret_token=abc sk-SECRET bearer abc.def ghi@example.com https://internal.local jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature ghp_123456789012345678901234567890123456 AIzaSyA123456789012345678901234567890 ya29.a0AfH6SMBEXAMPLE AKIAABCDEFGHIJKLMNOP xoxb-123456789012-123456789012-abcdefghijk access_token=oauth-token"}',
      ),
    ).toBe(
      '429 {"error":"secret_token=[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] jwt=[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] access_token=[REDACTED]"}',
    );
  });

  it("preserves emails and urls in log-oriented redaction while still scrubbing secrets", () => {
    expect(
      redactProviderTextForLogs(
        '429 {"error":"secret_token=abc sk-SECRET bearer abc.def ghi@example.com https://internal.local access_token=oauth-token"}',
      ),
    ).toBe(
      '429 {"error":"secret_token=[REDACTED] [REDACTED] [REDACTED] ghi@example.com https://internal.local access_token=[REDACTED]"}',
    );
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
