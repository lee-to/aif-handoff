import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { logger } from "./logger.js";
import { findMonorepoRootFromUrl } from "./monorepoRoot.js";

const log = logger("db");

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

const MONOREPO_ROOT = findMonorepoRootFromUrl(import.meta.url);

/** Resolve DB path relative to the monorepo root. */
function resolveDbPath(raw: string): string {
  if (raw === ":memory:" || raw.startsWith("/")) return raw;
  return resolve(MONOREPO_ROOT, raw);
}

export function getDb(url?: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const dbPath = resolveDbPath(url ?? process.env.DATABASE_URL ?? "./data/aif.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  log.debug({ dbPath }, "Opening database connection");

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  ensureTables(_sqlite);

  _db = drizzle(_sqlite, { schema });
  log.info({ dbPath }, "Database connected");

  return _db;
}

/** Create tables if they don't exist. */
function ensureTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      planner_max_budget_usd REAL,
      plan_checker_max_budget_usd REAL,
      implementer_max_budget_usd REAL,
      review_sidecar_max_budget_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      auto_mode INTEGER NOT NULL DEFAULT 1,
      is_fix INTEGER NOT NULL DEFAULT 0,
      planner_mode TEXT NOT NULL DEFAULT 'full',
      plan_path TEXT NOT NULL DEFAULT '.ai-factory/PLAN.md',
      plan_docs INTEGER NOT NULL DEFAULT 0,
      plan_tests INTEGER NOT NULL DEFAULT 0,
      skip_review INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 1000.0,
      plan TEXT,
      implementation_log TEXT,
      review_comments TEXT,
      agent_activity_log TEXT,
      blocked_reason TEXT,
      blocked_from_status TEXT,
      retry_after TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      token_total INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      roadmap_alias TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      rework_requested INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human',
      message TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  ensureColumn(sqlite, "tasks", "blocked_reason", "blocked_reason TEXT");
  ensureColumn(sqlite, "tasks", "blocked_from_status", "blocked_from_status TEXT");
  ensureColumn(sqlite, "tasks", "retry_after", "retry_after TEXT");
  ensureColumn(sqlite, "tasks", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "token_input", "token_input INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "token_output", "token_output INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "token_total", "token_total INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "cost_usd", "cost_usd REAL NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "rework_requested", "rework_requested INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "last_heartbeat_at", "last_heartbeat_at TEXT");
  ensureColumn(sqlite, "tasks", "auto_mode", "auto_mode INTEGER NOT NULL DEFAULT 1");
  ensureColumn(sqlite, "tasks", "is_fix", "is_fix INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "roadmap_alias", "roadmap_alias TEXT");
  ensureColumn(sqlite, "tasks", "tags", "tags TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, "tasks", "attachments", "attachments TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(sqlite, "tasks", "planner_mode", "planner_mode TEXT NOT NULL DEFAULT 'full'");
  ensureColumn(
    sqlite,
    "tasks",
    "plan_path",
    "plan_path TEXT NOT NULL DEFAULT '.ai-factory/PLAN.md'",
  );
  ensureColumn(sqlite, "tasks", "plan_docs", "plan_docs INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "plan_tests", "plan_tests INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "tasks", "skip_review", "skip_review INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "projects", "planner_max_budget_usd", "planner_max_budget_usd REAL");
  ensureColumn(
    sqlite,
    "projects",
    "plan_checker_max_budget_usd",
    "plan_checker_max_budget_usd REAL",
  );
  ensureColumn(sqlite, "projects", "implementer_max_budget_usd", "implementer_max_budget_usd REAL");
  ensureColumn(
    sqlite,
    "projects",
    "review_sidecar_max_budget_usd",
    "review_sidecar_max_budget_usd REAL",
  );
  ensureColumn(sqlite, "task_comments", "author", "author TEXT NOT NULL DEFAULT 'human'");
  ensureColumn(sqlite, "task_comments", "attachments", "attachments TEXT NOT NULL DEFAULT '[]'");

  ensureIndexes(sqlite);
}

/** Idempotent index bootstrap for high-frequency query patterns. */
function ensureIndexes(sqlite: Database.Database): void {
  const indexDefs = [
    // Coordinator picks tasks by status
    "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
    // Coordinator retry scan: blocked_external tasks with due retry_after
    "CREATE INDEX IF NOT EXISTS idx_tasks_retry_after ON tasks(retry_after)",
    // Task list queries filtered by project
    "CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)",
    // Composite: coordinator filters status + retry_after together
    "CREATE INDEX IF NOT EXISTS idx_tasks_status_retry ON tasks(status, retry_after)",
    // Composite: task list ordering within a project by status and position
    "CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, position)",
    // Task comments lookup by task
    "CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id)",
  ];

  for (const ddl of indexDefs) {
    try {
      sqlite.exec(ddl);
    } catch (err) {
      log.error({ err, ddl }, "Index bootstrap failed");
    }
  }

  log.info({ indexCount: indexDefs.length }, "Index bootstrap complete");
  log.debug(
    { indexes: indexDefs.map((d) => d.match(/idx_\w+/)?.[0] ?? d) },
    "Indexes created/verified",
  );
}

function ensureColumn(
  sqlite: Database.Database,
  table: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
  }
}

/** Create a fresh in-memory DB — useful for testing */
export function createTestDb(): BetterSQLite3Database<typeof schema> {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureTables(sqlite);
  // ensureTables already calls ensureIndexes at the end

  const db = drizzle(sqlite, { schema });
  log.debug("Created in-memory test database");

  return db;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    log.debug("Database connection closed");
  }
}
