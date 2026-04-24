import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { eq } from "drizzle-orm";
import { chatSessions } from "../schema.js";
import { closeDb, createTestDb, getDb } from "../db.js";

function removeSqliteArtifacts(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Windows can hold SQLite sidecars briefly after close; ignore cleanup noise in tests.
    }
  }
}

describe("db", () => {
  it("createTestDb returns a working database with indexes", () => {
    const db = createTestDb();
    expect(db).toBeDefined();
  });

  it("creates Codex index tables for fresh databases", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-codex-index-${Date.now()}-${Math.random()}.sqlite`);

    try {
      getDb(dbPath);
      closeDb();

      const sqlite = new Database(dbPath, { readonly: true });
      const tableNames = sqlite
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'codex_sessions',
              'codex_session_files',
              'codex_limit_heads',
              'codex_limit_history',
              'codex_index_cursors'
            )
        `,
        )
        .all() as Array<{ name: string }>;
      sqlite.close();

      expect(tableNames.map((row) => row.name).sort()).toEqual([
        "codex_index_cursors",
        "codex_limit_heads",
        "codex_limit_history",
        "codex_session_files",
        "codex_sessions",
      ]);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("index bootstrap is idempotent — calling createTestDb twice does not throw", () => {
    // Each call runs ensureTables + ensureIndexes with CREATE INDEX IF NOT EXISTS
    const db1 = createTestDb();
    const db2 = createTestDb();
    expect(db1).toBeDefined();
    expect(db2).toBeDefined();
  });

  it("creates and seeds a singleton app_settings row", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-app-settings-${Date.now()}-${Math.random()}.sqlite`);

    try {
      getDb(dbPath);
      closeDb();

      const sqlite = new Database(dbPath, { readonly: true });
      const rows = sqlite
        .prepare(
          `
          SELECT
            id,
            default_task_runtime_profile_id,
            default_plan_runtime_profile_id,
            default_review_runtime_profile_id,
            default_chat_runtime_profile_id
          FROM app_settings
        `,
        )
        .all() as Array<{
        id: number;
        default_task_runtime_profile_id: string | null;
        default_plan_runtime_profile_id: string | null;
        default_review_runtime_profile_id: string | null;
        default_chat_runtime_profile_id: string | null;
      }>;
      sqlite.close();

      expect(rows).toEqual([
        {
          id: 1,
          default_task_runtime_profile_id: null,
          default_plan_runtime_profile_id: null,
          default_review_runtime_profile_id: null,
          default_chat_runtime_profile_id: null,
        },
      ]);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("migrates pre-v6 schema and backfills runtime_session_id from agent_session_id", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-migrate-${Date.now()}-${Math.random()}.sqlite`);
    const sqlite = new Database(dbPath);

    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        planner_max_budget_usd REAL,
        plan_checker_max_budget_usd REAL,
        implementer_max_budget_usd REAL,
        review_sidecar_max_budget_usd REAL,
        parallel_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE tasks (
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
        use_subagents INTEGER NOT NULL DEFAULT 0,
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
        session_id TEXT,
        locked_by TEXT,
        locked_until TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE task_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'human',
        message TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        agent_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    sqlite
      .prepare(
        `
        INSERT INTO chat_sessions (id, project_id, title, agent_session_id)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run("legacy-chat", "legacy-project", "Legacy Chat", "legacy-agent-session");
    sqlite.pragma("user_version = 5");
    sqlite.close();

    try {
      const db = getDb(dbPath);
      const migrated = db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, "legacy-chat"))
        .get();

      expect(migrated).toBeDefined();
      expect(migrated?.runtimeSessionId).toBe("legacy-agent-session");
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("reconciles diverged feature-branch version-9 histories before applying v11", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-diverged-v9-${Date.now()}-${Math.random()}.sqlite`);
    const sqlite = new Database(dbPath);

    sqlite.exec(`
      CREATE TABLE projects (
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
      );
      CREATE TABLE tasks (
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
        use_subagents INTEGER NOT NULL DEFAULT 0,
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
        manual_review_required INTEGER NOT NULL DEFAULT 0,
        auto_review_state_json TEXT,
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
      );
      CREATE TABLE task_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'human',
        message TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE runtime_profiles (
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
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        agent_session_id TEXT,
        runtime_profile_id TEXT,
        runtime_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    sqlite.pragma("user_version = 9");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migratedSqlite = new Database(dbPath, { readonly: true });
      const usageEventsTable = migratedSqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'`)
        .get() as { name: string } | undefined;
      const projectColumns = migratedSqlite.prepare(`PRAGMA table_info(projects)`).all() as Array<{
        name: string;
      }>;
      const chatSessionColumns = migratedSqlite
        .prepare(`PRAGMA table_info(chat_sessions)`)
        .all() as Array<{ name: string }>;
      const taskColumns = migratedSqlite.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
        name: string;
      }>;
      const runtimeProfileColumns = migratedSqlite
        .prepare(`PRAGMA table_info(runtime_profiles)`)
        .all() as Array<{ name: string }>;
      const userVersion = migratedSqlite.pragma("user_version", { simple: true }) as number;
      migratedSqlite.close();

      expect(usageEventsTable?.name).toBe("usage_events");
      expect(projectColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["token_input", "token_output", "token_total", "cost_usd"]),
      );
      expect(chatSessionColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["token_input", "token_output", "token_total", "cost_usd"]),
      );
      expect(taskColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "manual_review_required",
          "auto_review_state_json",
          "runtime_limit_snapshot_json",
          "runtime_limit_updated_at",
        ]),
      );
      expect(runtimeProfileColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["runtime_limit_snapshot_json", "runtime_limit_updated_at"]),
      );
      expect(userVersion).toBe(16);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("recovers v13 runtime-limit columns for DBs stranded at user_version=14 after branch-merge reordering", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-v14-stranded-${Date.now()}-${Math.random()}.sqlite`);
    const sqlite = new Database(dbPath);

    sqlite.exec(`
      CREATE TABLE runtime_profiles (
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
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        position REAL NOT NULL DEFAULT 1000.0,
        retry_after TEXT,
        locked_by TEXT,
        locked_until TEXT,
        scheduled_at TEXT,
        runtime_profile_id TEXT
      );
    `);
    sqlite.pragma("user_version = 14");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migratedSqlite = new Database(dbPath, { readonly: true });
      const taskColumns = migratedSqlite.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
        name: string;
      }>;
      const profileColumns = migratedSqlite
        .prepare(`PRAGMA table_info(runtime_profiles)`)
        .all() as Array<{ name: string }>;
      const userVersion = migratedSqlite.pragma("user_version", { simple: true }) as number;
      migratedSqlite.close();

      expect(taskColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["runtime_limit_snapshot_json", "runtime_limit_updated_at"]),
      );
      expect(profileColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["runtime_limit_snapshot_json", "runtime_limit_updated_at"]),
      );
      expect(userVersion).toBe(16);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });
});
