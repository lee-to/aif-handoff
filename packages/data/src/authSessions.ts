import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import {
  logger,
  participantSessions,
  participants,
  type ParticipantSummary,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = logger("data:auth-sessions");
const PASSWORD_HASH_SCHEME = "aif-scrypt";
const PASSWORD_HASH_VERSION = 1;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_SALT_LENGTH = 16;
const SCRYPT_PARAMETERS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const CSRF_DERIVATION_CONTEXT = "aif-participant-csrf-v1";

interface ParsedPasswordHash {
  version: number;
  salt: Buffer;
  digest: Buffer;
  N: number;
  r: number;
  p: number;
}

export interface CreatedParticipantSession {
  id: string;
  participant: ParticipantSummary;
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export interface ResolvedParticipantSession {
  id: string;
  participant: ParticipantSummary;
  csrfToken: string;
  expiresAt: string;
}

export type AuthenticateParticipantResult =
  | { ok: true; session: CreatedParticipantSession }
  | { ok: false; code: "invalid_credentials" };

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function createDummyPasswordHash(): string {
  const salt = encodeBase64Url(Buffer.alloc(PASSWORD_SALT_LENGTH, 0xa5));
  const digest = encodeBase64Url(Buffer.alloc(PASSWORD_KEY_LENGTH, 0x5a));
  return `${PASSWORD_HASH_SCHEME}$v=${PASSWORD_HASH_VERSION}$N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}$${salt}$${digest}`;
}

const DUMMY_PASSWORD_HASH = createDummyPasswordHash();

function derivePasswordKey(
  password: string,
  salt: Buffer,
  parameters: Pick<ParsedPasswordHash, "N" | "r" | "p">,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      {
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT_PARAMETERS.maxmem,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== PASSWORD_HASH_SCHEME) return null;
  const version = Number(parts[1]?.replace(/^v=/, ""));
  const parameterEntries = parts[2]?.split(",").map((entry) => entry.split("=")) ?? [];
  const parameterMap = new Map(parameterEntries.map(([key, value]) => [key, Number(value)]));
  const N = parameterMap.get("N");
  const r = parameterMap.get("r");
  const p = parameterMap.get("p");
  const salt = decodeBase64Url(parts[3] ?? "");
  const digest = decodeBase64Url(parts[4] ?? "");
  const parametersAreValid =
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    (N ?? 0) > 1 &&
    (r ?? 0) > 0 &&
    (p ?? 0) > 0;

  if (
    version !== PASSWORD_HASH_VERSION ||
    !parametersAreValid ||
    !salt ||
    salt.length < PASSWORD_SALT_LENGTH ||
    !digest ||
    digest.length !== PASSWORD_KEY_LENGTH
  ) {
    return null;
  }

  return {
    version,
    salt,
    digest,
    N: N as number,
    r: r as number,
    p: p as number,
  };
}

function digestOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function deriveCsrfToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken)
    .update(CSRF_DERIVATION_CONTEXT, "utf8")
    .digest("base64url");
}

function participantSummary(
  participant: typeof participants.$inferSelect,
): ParticipantSummary {
  return {
    id: participant.id,
    displayName: participant.displayName,
    role: participant.role,
    active: participant.active,
  };
}

export function normalizeParticipantUsername(username: string): string {
  return username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export async function hashParticipantPassword(password: string): Promise<string> {
  log.debug(
    { version: PASSWORD_HASH_VERSION, scheme: PASSWORD_HASH_SCHEME },
    "Hashing participant password",
  );
  const salt = randomBytes(PASSWORD_SALT_LENGTH);

  try {
    const digest = await derivePasswordKey(password, salt, SCRYPT_PARAMETERS);
    log.debug(
      { version: PASSWORD_HASH_VERSION, scheme: PASSWORD_HASH_SCHEME },
      "Participant password hashed",
    );
    return `${PASSWORD_HASH_SCHEME}$v=${PASSWORD_HASH_VERSION}$N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}$${encodeBase64Url(salt)}$${encodeBase64Url(digest)}`;
  } catch (error) {
    log.error(
      { error, version: PASSWORD_HASH_VERSION, scheme: PASSWORD_HASH_SCHEME },
      "Participant password hashing failed",
    );
    throw error;
  }
}

export async function verifyParticipantPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    log.warn(
      { scheme: PASSWORD_HASH_SCHEME },
      "Rejected unsupported participant password hash",
    );
    return false;
  }

  try {
    const candidate = await derivePasswordKey(password, parsed.salt, parsed);
    return candidate.length === parsed.digest.length && timingSafeEqual(candidate, parsed.digest);
  } catch (error) {
    log.error(
      { error, version: parsed.version, scheme: PASSWORD_HASH_SCHEME },
      "Participant password verification failed",
    );
    throw error;
  }
}

export async function verifyParticipantPasswordOrDummy(
  password: string,
  encodedHash: string | null,
): Promise<boolean> {
  const isDummy = encodedHash === null;
  const verified = await verifyParticipantPassword(password, encodedHash ?? DUMMY_PASSWORD_HASH);
  return !isDummy && verified;
}

export function createParticipantSession(
  participantId: string,
  options: { ttlMs: number; now?: Date },
): CreatedParticipantSession | null {
  const db = getDb();
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + options.ttlMs);
  log.debug({ participantId, ttlMs: options.ttlMs }, "Creating participant session");

  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    log.warn({ participantId, ttlMs: options.ttlMs }, "Rejected invalid participant session TTL");
    return null;
  }

  const participant = db.select().from(participants).where(eq(participants.id, participantId)).get();
  if (!participant?.active) {
    log.warn({ participantId }, "Rejected participant session for missing or inactive account");
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  const csrfToken = deriveCsrfToken(token);
  const id = crypto.randomUUID();

  try {
    db.insert(participantSessions)
      .values({
        id,
        participantId,
        tokenDigest: digestOpaqueToken(token),
        csrfTokenDigest: digestOpaqueToken(csrfToken),
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
      })
      .run();
    log.info({ sessionId: id, participantId }, "Participant session created");
    return {
      id,
      participant: participantSummary(participant),
      token,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    log.error({ error, participantId, sessionId: id }, "Failed to create participant session");
    throw error;
  }
}

export function resolveParticipantSession(
  token: string,
  now = new Date(),
): ResolvedParticipantSession | null {
  const db = getDb();
  const tokenDigest = digestOpaqueToken(token);
  log.debug({ checkedAt: now.toISOString() }, "Resolving participant session");

  try {
    const result = db
      .select({ session: participantSessions, participant: participants })
      .from(participantSessions)
      .innerJoin(participants, eq(participantSessions.participantId, participants.id))
      .where(
        and(
          eq(participantSessions.tokenDigest, tokenDigest),
          isNull(participantSessions.revokedAt),
          gt(participantSessions.expiresAt, now.toISOString()),
          eq(participants.active, true),
        ),
      )
      .get();

    if (!result) {
      log.debug("Participant session was not active");
      return null;
    }

    db.update(participantSessions)
      .set({ lastSeenAt: now.toISOString() })
      .where(eq(participantSessions.id, result.session.id))
      .run();
    log.debug(
      { sessionId: result.session.id, participantId: result.participant.id },
      "Participant session resolved",
    );
    return {
      id: result.session.id,
      participant: participantSummary(result.participant),
      csrfToken: deriveCsrfToken(token),
      expiresAt: result.session.expiresAt,
    };
  } catch (error) {
    log.error({ error }, "Participant session resolution failed");
    throw error;
  }
}

export function isParticipantSessionActive(
  sessionId: string,
  now = new Date(),
): boolean {
  try {
    const session = getDb()
      .select({ id: participantSessions.id })
      .from(participantSessions)
      .innerJoin(participants, eq(participantSessions.participantId, participants.id))
      .where(
        and(
          eq(participantSessions.id, sessionId),
          isNull(participantSessions.revokedAt),
          gt(participantSessions.expiresAt, now.toISOString()),
          eq(participants.active, true),
        ),
      )
      .get();
    return Boolean(session);
  } catch (error) {
    log.error({ error, sessionId }, "Participant session activity check failed");
    throw error;
  }
}

export function verifyParticipantSessionCsrf(
  sessionToken: string,
  csrfToken: string,
  now = new Date(),
): boolean {
  const tokenDigest = digestOpaqueToken(sessionToken);
  const session = getDb()
    .select({
      csrfTokenDigest: participantSessions.csrfTokenDigest,
      expiresAt: participantSessions.expiresAt,
    })
    .from(participantSessions)
    .where(
      and(
        eq(participantSessions.tokenDigest, tokenDigest),
        isNull(participantSessions.revokedAt),
        gt(participantSessions.expiresAt, now.toISOString()),
      ),
    )
    .get();
  if (!session) return false;

  const expectedDigest = Buffer.from(session.csrfTokenDigest, "hex");
  const candidateDigest = Buffer.from(digestOpaqueToken(csrfToken), "hex");
  return (
    expectedDigest.length === candidateDigest.length &&
    timingSafeEqual(expectedDigest, candidateDigest)
  );
}

export function revokeParticipantSession(token: string, now = new Date()): boolean {
  const revoked = getDb()
    .update(participantSessions)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        eq(participantSessions.tokenDigest, digestOpaqueToken(token)),
        isNull(participantSessions.revokedAt),
      ),
    )
    .returning({ id: participantSessions.id, participantId: participantSessions.participantId })
    .get();

  if (!revoked) {
    log.debug("Participant session revoke found no active session");
    return false;
  }
  log.info(
    { sessionId: revoked.id, participantId: revoked.participantId },
    "Participant session revoked",
  );
  return true;
}

export function revokeAllParticipantSessions(
  participantId: string,
  now = new Date(),
): number {
  const result = getDb()
    .update(participantSessions)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        eq(participantSessions.participantId, participantId),
        isNull(participantSessions.revokedAt),
      ),
    )
    .run();
  log.info({ participantId, revokedCount: result.changes }, "Participant sessions revoked");
  return result.changes;
}

export function expireParticipantSessions(now = new Date()): number {
  const result = getDb()
    .update(participantSessions)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        isNull(participantSessions.revokedAt),
        lte(participantSessions.expiresAt, now.toISOString()),
      ),
    )
    .run();
  log.info({ expiredCount: result.changes }, "Expired participant sessions");
  return result.changes;
}

export async function authenticateParticipant(
  username: string,
  password: string,
  options: { sessionTtlMs: number; now?: Date },
): Promise<AuthenticateParticipantResult> {
  const normalizedUsername = normalizeParticipantUsername(username);
  const participant = getDb()
    .select()
    .from(participants)
    .where(eq(participants.normalizedUsername, normalizedUsername))
    .get();
  const verified = await verifyParticipantPasswordOrDummy(
    password,
    participant?.passwordHash ?? null,
  );
  const isEligible = Boolean(participant?.active && verified);

  if (!participant || !isEligible) {
    log.warn(
      { participantId: participant?.id ?? null, accountFound: Boolean(participant) },
      "Participant authentication rejected",
    );
    return { ok: false, code: "invalid_credentials" };
  }

  const session = createParticipantSession(participant.id, {
    ttlMs: options.sessionTtlMs,
    now: options.now,
  });
  if (!session) {
    log.warn({ participantId: participant.id }, "Participant authentication session rejected");
    return { ok: false, code: "invalid_credentials" };
  }

  log.info({ participantId: participant.id, sessionId: session.id }, "Participant authenticated");
  return { ok: true, session };
}
