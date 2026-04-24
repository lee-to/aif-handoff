import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getEnv, redactProviderText } from "@aif/shared";

interface QueryAuditRecord {
  timestamp: string;
  taskId: string;
  agentName: string;
  projectRoot: string;
  prompt: string;
  options: Record<string, unknown>;
}

const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_AUDIT_ROTATIONS = 5;
const MAX_AUDIT_DEPTH = 4;
const MAX_AUDIT_ARRAY_ITEMS = 24;
const MAX_AUDIT_OBJECT_KEYS = 48;

function getAuditFilePath(agentName: string): string {
  const safeName = agentName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = resolve(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${safeName}.log`);
}

function rotateAuditFileIfNeeded(filePath: string): void {
  if (!existsSync(filePath)) return;

  const size = statSync(filePath).size;
  if (size < MAX_AUDIT_FILE_BYTES) return;

  const oldest = `${filePath}.${MAX_AUDIT_ROTATIONS}`;
  if (existsSync(oldest)) {
    // Drop the oldest archive to keep a bounded number of log files.
    unlinkSync(oldest);
  }

  for (let i = MAX_AUDIT_ROTATIONS - 1; i >= 1; i -= 1) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    if (existsSync(from)) {
      renameSync(from, to);
    }
  }

  renameSync(filePath, `${filePath}.1`);
}

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_AUDIT_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }
  if (typeof value === "string") {
    return redactProviderText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_AUDIT_ARRAY_ITEMS)
      .map((item) => sanitizeAuditValue(item, depth + 1));
    if (value.length > MAX_AUDIT_ARRAY_ITEMS) {
      sanitized.push("[TRUNCATED_ARRAY]");
    }
    return sanitized;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of entries.slice(0, MAX_AUDIT_OBJECT_KEYS)) {
      sanitized[key] = sanitizeAuditValue(nested, depth + 1);
    }
    if (entries.length > MAX_AUDIT_OBJECT_KEYS) {
      sanitized._truncated = true;
    }
    return sanitized;
  }
  return String(value);
}

export function writeQueryAudit(record: QueryAuditRecord): void {
  try {
    if (!getEnv().AGENT_QUERY_AUDIT_ENABLED) return;
    const filePath = getAuditFilePath(record.agentName);
    rotateAuditFileIfNeeded(filePath);
    appendFileSync(filePath, `${JSON.stringify(sanitizeAuditValue(record))}\n`, "utf8");
  } catch {
    // Best-effort logging only; never break agent execution due to audit write errors.
  }
}
