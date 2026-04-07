import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { eq } from "drizzle-orm";
import { chatSessions } from "../schema.js";
import { closeDb, createTestDb, getDb } from "../db.js";

describe("db", () => {
  it("createTestDb returns a working database with indexes", () => {
    const db = createTestDb();
    expect(db).toBeDefined();
  });

  it("index bootstrap is idempotent — calling createTestDb twice does not throw", () => {
    // Each call runs ensureTables + ensureIndexes with CREATE INDEX IF NOT EXISTS
    const db1 = createTestDb();
    const db2 = createTestDb();
    expect(db1).toBeDefined();
    expect(db2).toBeDefined();
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
      rmSync(dbPath, { force: true });
    }
  });
});
