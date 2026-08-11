import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { participantSessions } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  authenticateParticipant,
  createParticipant,
  createParticipantSession,
  expireParticipantSessions,
  hashParticipantPassword,
  resolveParticipantSession,
  revokeAllParticipantSessions,
  revokeParticipantSession,
  verifyParticipantPassword,
  verifyParticipantPasswordOrDummy,
  verifyParticipantSessionCsrf,
} = await import("../index.js");

beforeEach(() => {
  testDb.current = createTestDb();
});

describe("participant password hashing", () => {
  it("uses versioned salted scrypt hashes and constant-time verification", async () => {
    const first = await hashParticipantPassword("correct horse battery staple");
    const second = await hashParticipantPassword("correct horse battery staple");

    expect(first).toMatch(/^aif-scrypt\$v=1\$N=16384,r=8,p=1\$/);
    expect(second).not.toBe(first);
    await expect(
      verifyParticipantPassword("correct horse battery staple", first),
    ).resolves.toBe(true);
    await expect(verifyParticipantPassword("wrong password", first)).resolves.toBe(false);
    await expect(verifyParticipantPassword("password", "unsupported")).resolves.toBe(false);
  });

  it("runs the dummy verification path for missing accounts without authenticating", async () => {
    await expect(verifyParticipantPasswordOrDummy("synthetic password", null)).resolves.toBe(false);
  });
});

describe("participant sessions", () => {
  it("stores only token digests and resolves active sessions with derived CSRF", async () => {
    const created = await createParticipant({
      username: "alice",
      displayName: "Alice",
      password: "safe password",
      role: "admin",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const now = new Date("2026-07-24T10:00:00.000Z");
    const session = createParticipantSession(created.participant.id, {
      ttlMs: 60_000,
      now,
    });
    expect(session).not.toBeNull();
    if (!session) return;

    const stored = testDb.current
      .select()
      .from(participantSessions)
      .where(eq(participantSessions.id, session.id))
      .get();
    expect(stored).toBeDefined();
    expect(stored?.tokenDigest).not.toContain(session.token);
    expect(stored?.csrfTokenDigest).not.toContain(session.csrfToken);
    expect(JSON.stringify(stored)).not.toContain(session.token);
    expect(JSON.stringify(stored)).not.toContain(session.csrfToken);

    const resolved = resolveParticipantSession(
      session.token,
      new Date("2026-07-24T10:00:30.000Z"),
    );
    expect(resolved).toMatchObject({
      id: session.id,
      participant: { id: created.participant.id, displayName: "Alice", active: true },
      csrfToken: session.csrfToken,
      expiresAt: "2026-07-24T10:01:00.000Z",
    });
    expect(
      verifyParticipantSessionCsrf(
        session.token,
        session.csrfToken,
        new Date("2026-07-24T10:00:30.000Z"),
      ),
    ).toBe(true);
    expect(
      verifyParticipantSessionCsrf(
        session.token,
        "invalid",
        new Date("2026-07-24T10:00:30.000Z"),
      ),
    ).toBe(false);
  });

  it("expires and revokes sessions without exposing token material", async () => {
    const created = await createParticipant({
      username: "member",
      displayName: "Member",
      password: "safe password",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = createParticipantSession(created.participant.id, {
      ttlMs: 1_000,
      now: new Date("2026-07-24T10:00:00.000Z"),
    });
    const second = createParticipantSession(created.participant.id, {
      ttlMs: 60_000,
      now: new Date("2026-07-24T10:00:00.000Z"),
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) return;

    expect(expireParticipantSessions(new Date("2026-07-24T10:00:02.000Z"))).toBe(1);
    expect(resolveParticipantSession(first.token, new Date("2026-07-24T10:00:02.000Z"))).toBeNull();
    expect(revokeParticipantSession(second.token, new Date("2026-07-24T10:00:03.000Z"))).toBe(
      true,
    );
    expect(revokeParticipantSession(second.token, new Date("2026-07-24T10:00:04.000Z"))).toBe(
      false,
    );

    const third = createParticipantSession(created.participant.id, {
      ttlMs: 60_000,
      now: new Date("2026-07-24T10:00:05.000Z"),
    });
    expect(third).not.toBeNull();
    expect(
      revokeAllParticipantSessions(
        created.participant.id,
        new Date("2026-07-24T10:00:06.000Z"),
      ),
    ).toBe(1);
  });

  it("authenticates active accounts and returns one generic failure for wrong, missing, or inactive users", async () => {
    const created = await createParticipant({
      username: "case-user",
      displayName: "Case User",
      password: "valid password",
    });
    expect(created.ok).toBe(true);

    const success = await authenticateParticipant(" CASE-USER ", "valid password", {
      sessionTtlMs: 60_000,
    });
    expect(success.ok).toBe(true);
    await expect(
      authenticateParticipant("case-user", "wrong password", { sessionTtlMs: 60_000 }),
    ).resolves.toEqual({ ok: false, code: "invalid_credentials" });
    await expect(
      authenticateParticipant("missing-user", "wrong password", { sessionTtlMs: 60_000 }),
    ).resolves.toEqual({ ok: false, code: "invalid_credentials" });
  });
});
