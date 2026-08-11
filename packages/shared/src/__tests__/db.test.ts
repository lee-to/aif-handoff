import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { eq } from "drizzle-orm";
import { chatSessions } from "../schema.js";
import { closeDb, createTestDb, getDb } from "../db.js";

const CURRENT_SCHEMA_VERSION = 28;

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

  it("creates restart-safe GitHub linkage tables", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-github-${Date.now()}-${Math.random()}.sqlite`);

    try {
      getDb(dbPath);
      closeDb();
      const sqlite = new Database(dbPath, { readonly: true });
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('github_repositories', 'github_issues') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const userVersion = sqlite.pragma("user_version", { simple: true }) as number;
      sqlite.close();

      expect(tables.map((row) => row.name)).toEqual(["github_issues", "github_repositories"]);
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
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
      const dirtyIndex = sqlite
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND name = 'idx_codex_session_files_dirty'
        `,
        )
        .get() as { name: string } | undefined;
      sqlite.close();

      expect(tableNames.map((row) => row.name).sort()).toEqual([
        "codex_index_cursors",
        "codex_limit_heads",
        "codex_limit_history",
        "codex_session_files",
        "codex_sessions",
      ]);
      expect(dirtyIndex).toBeUndefined();
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

  it("migrates v24 project tables with pinning and grouping columns", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-project-org-${Date.now()}-${Math.random()}.sqlite`);
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite.pragma("user_version = 24");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migrated = new Database(dbPath, { readonly: true });
      const columns = migrated.pragma("table_info(projects)") as Array<{ name: string }>;
      const userVersion = migrated.pragma("user_version", { simple: true }) as number;
      migrated.close();

      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["pinned_at", "group_name"]),
      );
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("migrates v25 tasks with restart-safe auto-queue commit columns", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-auto-commit-${Date.now()}-${Math.random()}.sqlite`);
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        position REAL NOT NULL DEFAULT 1000,
        retry_after TEXT,
        locked_by TEXT,
        locked_until TEXT,
        scheduled_at TEXT,
        runtime_profile_id TEXT
      );
      INSERT INTO tasks (id, project_id, title) VALUES ('task-1', 'project-1', 'Existing task');
    `);
    sqlite.pragma("user_version = 25");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migrated = new Database(dbPath, { readonly: true });
      const columns = migrated.pragma("table_info(tasks)") as Array<{ name: string }>;
      const task = migrated
        .prepare("SELECT title, commit_sha FROM tasks WHERE id = 'task-1'")
        .get() as { title: string; commit_sha: string | null };
      const userVersion = migrated.pragma("user_version", { simple: true }) as number;
      migrated.close();

      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "auto_queue_commit_status",
          "auto_queue_commit_base_sha",
          "commit_sha",
          "auto_queue_commit_error",
          "auto_queue_commit_completed_at",
        ]),
      );
      expect(task).toEqual({ title: "Existing task", commit_sha: null });
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("migrates v26 tasks to AI ownership and backfills immutable executor history", () => {
    closeDb();
    const dbPath = join(
      tmpdir(),
      `aif-shared-participants-migration-${Date.now()}-${Math.random()}.sqlite`,
    );
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        position REAL NOT NULL DEFAULT 1000,
        retry_after TEXT,
        locked_by TEXT,
        locked_until TEXT,
        scheduled_at TEXT,
        runtime_profile_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'human',
        message TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      INSERT INTO tasks (
        id,
        project_id,
        title,
        status,
        created_at,
        updated_at
      ) VALUES (
        'task-existing',
        'project-1',
        'Existing task',
        'planning',
        '2026-07-01T12:00:00.000Z',
        '2026-07-01T12:00:00.000Z'
      );
    `);
    sqlite.pragma("user_version = 26");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migrated = new Database(dbPath, { readonly: true });
      const task = migrated
        .prepare(
          `
            SELECT execution_owner, ownership_revision
            FROM tasks
            WHERE id = 'task-existing'
          `,
        )
        .get() as { execution_owner: string; ownership_revision: number };
      const history = migrated
        .prepare(
          `
            SELECT
              task_id,
              task_title_snapshot,
              ownership_revision,
              execution_owner,
              assignees_snapshot_json,
              status_snapshot,
              actor_kind,
              reason,
              created_at
            FROM task_executor_history
            WHERE task_id = 'task-existing'
          `,
        )
        .get() as Record<string, unknown>;
      const commentColumns = migrated.pragma("table_info(task_comments)") as Array<{
        name: string;
      }>;
      const userVersion = migrated.pragma("user_version", { simple: true }) as number;
      migrated.close();

      expect(task).toEqual({ execution_owner: "ai", ownership_revision: 0 });
      expect(history).toEqual({
        task_id: "task-existing",
        task_title_snapshot: "Existing task",
        ownership_revision: 0,
        execution_owner: "ai",
        assignees_snapshot_json: "[]",
        status_snapshot: "planning",
        actor_kind: "system",
        reason: "migration_v27_initial_owner",
        created_at: "2026-07-01T12:00:00.000Z",
      });
      expect(commentColumns.map((column) => column.name)).toContain("participant_id");
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("creates constrained participant tables, ownership indexes, and append-only ledgers", () => {
    closeDb();
    const dbPath = join(
      tmpdir(),
      `aif-shared-participants-fresh-${Date.now()}-${Math.random()}.sqlite`,
    );

    try {
      getDb(dbPath);
      closeDb();

      const sqlite = new Database(dbPath);
      const tableNames = sqlite
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name IN (
                'participants',
                'participant_sessions',
                'task_assignments',
                'task_executor_history',
                'audit_events'
              )
          `,
        )
        .all() as Array<{ name: string }>;
      const indexNames = sqlite
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'idx_participants_normalized_username',
                'idx_participant_sessions_token_digest',
                'idx_task_assignments_participant',
                'idx_task_executor_history_revision',
                'idx_audit_events_task'
              )
          `,
        )
        .all() as Array<{ name: string }>;
      const triggerNames = sqlite
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'trg_task_executor_history_prevent_update',
                'trg_task_executor_history_prevent_delete',
                'trg_audit_events_prevent_update',
                'trg_audit_events_prevent_delete'
              )
          `,
        )
        .all() as Array<{ name: string }>;

      sqlite
        .prepare(
          `
            INSERT INTO participants (
              id,
              username,
              normalized_username,
              display_name,
              password_hash,
              role
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run("participant-1", "Alice", "alice", "Alice", "scrypt:test", "admin");
      expect(() =>
        sqlite
          .prepare(
            `
              INSERT INTO participants (
                id,
                username,
                normalized_username,
                display_name,
                password_hash,
                role
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run("participant-2", "ALICE", "alice", "Other Alice", "scrypt:test", "member"),
      ).toThrow();

      sqlite
        .prepare(
          `
            INSERT INTO task_executor_history (
              id,
              task_id,
              task_title_snapshot,
              ownership_revision,
              execution_owner,
              assignees_snapshot_json,
              status_snapshot,
              actor_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run("history-1", "task-1", "Task", 0, "ai", "[]", "backlog", "system");
      sqlite
        .prepare(
          `
            INSERT INTO audit_events (
              id,
              action,
              entity_type,
              entity_id,
              actor_kind
            ) VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run("audit-1", "task.created", "task", "task-1", "system");

      expect(() =>
        sqlite
          .prepare("UPDATE task_executor_history SET reason = 'changed' WHERE id = 'history-1'")
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        sqlite.prepare("DELETE FROM task_executor_history WHERE id = 'history-1'").run(),
      ).toThrow(/append-only/);
      expect(() =>
        sqlite.prepare("UPDATE audit_events SET action = 'changed' WHERE id = 'audit-1'").run(),
      ).toThrow(/append-only/);
      expect(() => sqlite.prepare("DELETE FROM audit_events WHERE id = 'audit-1'").run()).toThrow(
        /append-only/,
      );
      sqlite.close();

      expect(tableNames.map((row) => row.name).sort()).toEqual([
        "audit_events",
        "participant_sessions",
        "participants",
        "task_assignments",
        "task_executor_history",
      ]);
      expect(indexNames).toHaveLength(5);
      expect(triggerNames).toHaveLength(4);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
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
          "branch_name",
          "worktree_path",
          "active_runtime_status",
          "active_runtime_selection_json",
        ]),
      );
      expect(runtimeProfileColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["runtime_limit_snapshot_json", "runtime_limit_updated_at"]),
      );
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("drops the unused Codex session-files dirty index when migrating v17 databases", () => {
    closeDb();
    const dbPath = join(
      tmpdir(),
      `aif-shared-codex-index-drop-${Date.now()}-${Math.random()}.sqlite`,
    );
    const sqlite = new Database(dbPath);

    sqlite.exec(`
      CREATE TABLE codex_session_files (
        file_path TEXT PRIMARY KEY,
        session_id TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        parsed_offset INTEGER NOT NULL DEFAULT 0,
        pending_tail TEXT NOT NULL DEFAULT '',
        missing INTEGER NOT NULL DEFAULT 0,
        import_version INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX idx_codex_session_files_dirty
        ON codex_session_files(missing, mtime_ms, size_bytes);
    `);
    sqlite.pragma("user_version = 17");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migratedSqlite = new Database(dbPath, { readonly: true });
      const dirtyIndex = migratedSqlite
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND name = 'idx_codex_session_files_dirty'
        `,
        )
        .get() as { name: string } | undefined;
      const taskColumns = migratedSqlite.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
        name: string;
      }>;
      const userVersion = migratedSqlite.pragma("user_version", { simple: true }) as number;
      migratedSqlite.close();

      expect(dirtyIndex).toBeUndefined();
      expect(taskColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["active_runtime_status", "active_runtime_selection_json"]),
      );
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
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
        expect.arrayContaining([
          "runtime_limit_snapshot_json",
          "runtime_limit_updated_at",
          "branch_name",
          "worktree_path",
          "active_runtime_status",
          "active_runtime_selection_json",
        ]),
      );
      expect(profileColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["runtime_limit_snapshot_json", "runtime_limit_updated_at"]),
      );
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("upgrades a v18 schema to current by adding task git-isolation columns and warmup sessions", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-v18-to-v19-${Date.now()}-${Math.random()}.sqlite`);
    const sqlite = new Database(dbPath);

    // Minimal pre-v19 schema with the columns the v6→v18 migrations would have
    // produced. The point of this test is to lock the v19 contract: the
    // upgrade must add `branch_name` and `worktree_path`, while leaving every
    // prior column (esp. the v15 runtime_limit recovery columns) intact. If
    // this PR lands second after another migration merges to main, this test
    // will fail and force the rebaser to bump to a free trailing version slot
    // rather than silently re-using an existing version with different SQL.
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        position REAL NOT NULL DEFAULT 1000.0,
        manual_review_required INTEGER NOT NULL DEFAULT 0,
        auto_review_state_json TEXT,
        runtime_limit_snapshot_json TEXT,
        runtime_limit_updated_at TEXT,
        runtime_profile_id TEXT
      );
    `);
    sqlite.pragma("user_version = 18");
    sqlite.close();

    try {
      getDb(dbPath);
      closeDb();

      const migratedSqlite = new Database(dbPath, { readonly: true });
      const taskColumns = migratedSqlite.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
        name: string;
      }>;
      const warmupTable = migratedSqlite
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name = 'runtime_warmup_sessions'
        `,
        )
        .get() as { name: string } | undefined;
      const userVersion = migratedSqlite.pragma("user_version", { simple: true }) as number;
      migratedSqlite.close();

      const taskColumnNames = taskColumns.map((column) => column.name);
      expect(taskColumnNames).toContain("branch_name");
      expect(taskColumnNames).toContain("worktree_path");
      expect(taskColumnNames).toEqual(
        expect.arrayContaining([
          "manual_review_required",
          "auto_review_state_json",
          "runtime_limit_snapshot_json",
          "runtime_limit_updated_at",
          "active_runtime_status",
          "active_runtime_selection_json",
        ]),
      );
      expect(warmupTable?.name).toBe("runtime_warmup_sessions");
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });

  it("creates runtime warmup sessions table and lookup indexes for fresh databases", () => {
    closeDb();
    const dbPath = join(tmpdir(), `aif-shared-warmup-${Date.now()}-${Math.random()}.sqlite`);

    try {
      getDb(dbPath);
      closeDb();

      const sqlite = new Database(dbPath, { readonly: true });
      const table = sqlite
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name = 'runtime_warmup_sessions'
        `,
        )
        .get() as { name: string } | undefined;
      const indexes = sqlite
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_runtime_warmup_active_lookup',
              'idx_runtime_warmup_expires'
            )
        `,
        )
        .all() as Array<{ name: string }>;
      const userVersion = sqlite.pragma("user_version", { simple: true }) as number;
      sqlite.close();

      expect(table?.name).toBe("runtime_warmup_sessions");
      expect(indexes.map((row) => row.name).sort()).toEqual([
        "idx_runtime_warmup_active_lookup",
        "idx_runtime_warmup_expires",
      ]);
      expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      closeDb();
      removeSqliteArtifacts(dbPath);
    }
  });
});
