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
      parallel_enabled INTEGER NOT NULL DEFAULT 0,
      default_task_runtime_profile_id TEXT,
      default_plan_runtime_profile_id TEXT,
      default_review_runtime_profile_id TEXT,
      default_chat_runtime_profile_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      planner_mode TEXT NOT NULL DEFAULT 'fast',
      plan_path TEXT NOT NULL DEFAULT '.ai-factory/PLAN.md',
      plan_docs INTEGER NOT NULL DEFAULT 0,
      plan_tests INTEGER NOT NULL DEFAULT 0,
      skip_review INTEGER NOT NULL DEFAULT 0,
      use_subagents INTEGER NOT NULL DEFAULT 1,
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
      review_iteration_count INTEGER NOT NULL DEFAULT 0,
      max_review_iterations INTEGER NOT NULL DEFAULT 3,
      paused INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at TEXT,
      last_synced_at TEXT,
      runtime_profile_id TEXT,
      model_override TEXT,
      runtime_options_json TEXT,
      session_id TEXT,
      locked_by TEXT,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runtime_profiles (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      transport TEXT,
      base_url TEXT,
      api_key_env_var TEXT,
      default_model TEXT,
      headers_json TEXT NOT NULL DEFAULT '{}',
      options_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      agent_session_id TEXT,
      runtime_profile_id TEXT,
      runtime_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  runMigrations(sqlite);
  ensureTriggers(sqlite);
  runRuntimeBackfills(sqlite);
  ensureIndexes(sqlite);
}

/**
 * Versioned migration system using SQLite's PRAGMA user_version.
 * Each migration runs once, in order, inside a transaction.
 * Add new migrations to the end of the array — never reorder or remove existing entries.
 */
interface Migration {
  version: number;
  description: string;
  sql: string;
  /** Trigger DDL statements that contain internal semicolons and must be executed whole. */
  triggers?: string[];
}

const MIGRATIONS: Migration[] = [
  // Legacy columns that were added via ensureColumn — consolidated into migrations.
  // These use ensureColumn-style idempotent checks since existing DBs already have them.
  {
    version: 1,
    description: "Add session_id column to tasks for agent session resume",
    sql: "ALTER TABLE tasks ADD COLUMN session_id TEXT",
  },
  {
    version: 2,
    description: "Add chat_sessions and chat_messages tables",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        agent_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 3,
    description: "Add attachments column to chat_messages",
    sql: "ALTER TABLE chat_messages ADD COLUMN attachments TEXT",
  },
  {
    version: 4,
    description: "Add parallel_enabled column to projects",
    sql: "ALTER TABLE projects ADD COLUMN parallel_enabled INTEGER NOT NULL DEFAULT 0",
  },
  {
    version: 5,
    description: "Add task locking columns for parallel execution",
    sql: `
      ALTER TABLE tasks ADD COLUMN locked_by TEXT;
      ALTER TABLE tasks ADD COLUMN locked_until TEXT;
    `,
  },
  {
    version: 6,
    description: "Add runtime profile persistence and runtime-neutral session columns",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        transport TEXT,
        base_url TEXT,
        api_key_env_var TEXT,
        default_model TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        options_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE projects ADD COLUMN default_task_runtime_profile_id TEXT;
      ALTER TABLE projects ADD COLUMN default_chat_runtime_profile_id TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_profile_id TEXT;
      ALTER TABLE tasks ADD COLUMN model_override TEXT;
      ALTER TABLE tasks ADD COLUMN runtime_options_json TEXT;
      ALTER TABLE chat_sessions ADD COLUMN runtime_profile_id TEXT;
      ALTER TABLE chat_sessions ADD COLUMN runtime_session_id TEXT;
    `,
  },
  {
    version: 7,
    description: "Add cascade cleanup triggers for runtime_profiles deletion",
    sql: "",
    triggers: [
      `CREATE TRIGGER IF NOT EXISTS trg_runtime_profiles_delete
       AFTER DELETE ON runtime_profiles
       FOR EACH ROW
       BEGIN
         UPDATE tasks SET runtime_profile_id = NULL WHERE runtime_profile_id = OLD.id;
         UPDATE projects SET default_task_runtime_profile_id = NULL WHERE default_task_runtime_profile_id = OLD.id;
         UPDATE projects SET default_chat_runtime_profile_id = NULL WHERE default_chat_runtime_profile_id = OLD.id;
         UPDATE chat_sessions SET runtime_profile_id = NULL WHERE runtime_profile_id = OLD.id;
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_projects_delete_profiles
       AFTER DELETE ON projects
       FOR EACH ROW
       BEGIN
         DELETE FROM runtime_profiles WHERE project_id = OLD.id;
       END`,
    ],
  },
  {
    version: 8,
    description: "Add per-stage runtime profile columns to projects",
    sql: `
      ALTER TABLE projects ADD COLUMN default_plan_runtime_profile_id TEXT;
      ALTER TABLE projects ADD COLUMN default_review_runtime_profile_id TEXT;
    `,
  },
];

function splitSqlStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function isIgnorableMigrationError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("duplicate column name") || message.includes("already exists");
}

function runMigrations(sqlite: Database.Database): void {
  const currentVersion = (sqlite.pragma("user_version", { simple: true }) as number) ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    // For fresh DBs (user_version=0) that were just created with CREATE TABLE IF NOT EXISTS
    // (which already includes session_id), set version to latest to skip migrations.
    if (currentVersion === 0 && MIGRATIONS.length > 0) {
      const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
      sqlite.pragma(`user_version = ${latest}`);
    }
    return;
  }

  log.info({ currentVersion, pendingCount: pending.length }, "Running database migrations");

  const runAll = sqlite.transaction(() => {
    for (const migration of pending) {
      const statements = splitSqlStatements(migration.sql);
      for (const statement of statements) {
        try {
          sqlite.exec(statement);
        } catch (err) {
          if (isIgnorableMigrationError(err)) {
            log.debug(
              { version: migration.version, statement },
              "Migration statement already applied, skipping",
            );
            continue;
          }
          throw err;
        }
      }
      for (const trigger of migration.triggers ?? []) {
        try {
          sqlite.exec(trigger);
        } catch (err) {
          if (isIgnorableMigrationError(err)) {
            log.debug({ version: migration.version }, "Trigger already exists, skipping");
            continue;
          }
          throw err;
        }
      }
      log.info(
        { version: migration.version, description: migration.description },
        "Migration applied",
      );
    }
    const latest = pending[pending.length - 1].version;
    sqlite.pragma(`user_version = ${latest}`);
  });

  runAll();
  log.info({ newVersion: pending[pending.length - 1].version }, "Migrations complete");
}

function hasColumn(sqlite: Database.Database, tableName: string, columnName: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function runRuntimeBackfills(sqlite: Database.Database): void {
  if (hasColumn(sqlite, "chat_sessions", "runtime_session_id")) {
    const sessionBackfill = sqlite
      .prepare(
        `
        UPDATE chat_sessions
        SET runtime_session_id = agent_session_id
        WHERE runtime_session_id IS NULL
          AND agent_session_id IS NOT NULL
      `,
      )
      .run();
    log.info(
      { backfilledRows: sessionBackfill.changes },
      "Backfilled runtime_session_id from legacy agent_session_id",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "headers_json")) {
    const headersBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET headers_json = '{}'
        WHERE headers_json IS NULL OR trim(headers_json) = ''
      `,
      )
      .run();
    log.info(
      { backfilledRows: headersBackfill.changes },
      "Backfilled runtime profile headers_json defaults",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "options_json")) {
    const optionsBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET options_json = '{}'
        WHERE options_json IS NULL OR trim(options_json) = ''
      `,
      )
      .run();
    log.info(
      { backfilledRows: optionsBackfill.changes },
      "Backfilled runtime profile options_json defaults",
    );
  }

  if (hasColumn(sqlite, "runtime_profiles", "enabled")) {
    const enabledBackfill = sqlite
      .prepare(
        `
        UPDATE runtime_profiles
        SET enabled = 1
        WHERE enabled IS NULL
      `,
      )
      .run();
    log.info(
      { backfilledRows: enabledBackfill.changes },
      "Backfilled runtime profile enabled defaults",
    );
  }
}

/** Idempotent trigger bootstrap — ensures cascade cleanup triggers exist on every startup. */
function ensureTriggers(sqlite: Database.Database): void {
  const allTriggers = MIGRATIONS.flatMap((m) => m.triggers ?? []);
  for (const trigger of allTriggers) {
    try {
      sqlite.exec(trigger);
    } catch (err) {
      if (isIgnorableMigrationError(err)) continue;
      log.error({ err }, "Trigger bootstrap failed");
    }
  }
  if (allTriggers.length > 0) {
    log.debug({ triggerCount: allTriggers.length }, "Trigger bootstrap complete");
  }
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
    // Task locking: find unlocked or stale-locked tasks
    "CREATE INDEX IF NOT EXISTS idx_tasks_locked ON tasks(locked_by, locked_until)",
    // Runtime profile selection by project scope
    "CREATE INDEX IF NOT EXISTS idx_runtime_profiles_project_id ON runtime_profiles(project_id)",
    // Runtime profile selection by runtime/provider
    "CREATE INDEX IF NOT EXISTS idx_runtime_profiles_runtime ON runtime_profiles(runtime_id, provider_id)",
    // Runtime profile lookups for tasks
    "CREATE INDEX IF NOT EXISTS idx_tasks_runtime_profile_id ON tasks(runtime_profile_id)",
    // Runtime profile lookups for chat sessions
    "CREATE INDEX IF NOT EXISTS idx_chat_sessions_runtime_profile_id ON chat_sessions(runtime_profile_id)",
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
