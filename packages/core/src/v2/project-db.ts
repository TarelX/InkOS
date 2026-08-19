/**
 * Project-level SQLite state store (`.inkos/inkos-v2.sqlite`).
 *
 * ADR-003: SQLite holds *state* (workflow runs/nodes/events/approvals) and
 * *indexes* (artifact index). Content truth lives in versioned artifacts and
 * the index must always be rebuildable from manifests.
 *
 * Uses node:sqlite (Node 22+), same pattern as state/memory-db.ts.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const MIGRATIONS: ReadonlyArray<{ readonly id: string; readonly sql: string }> = [
  {
    id: "0001_artifact_index",
    sql: `
      CREATE TABLE IF NOT EXISTS artifact_index (
        book_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        schema_id TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        run_id TEXT,
        node_id TEXT,
        inputs_json TEXT NOT NULL DEFAULT '[]',
        files_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (book_id, artifact_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_status
        ON artifact_index (book_id, artifact_id, status, version);
    `,
  },
  {
    id: "0002_workflow",
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_version TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workflow_nodes (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        idempotent INTEGER NOT NULL DEFAULT 1,
        depends_json TEXT NOT NULL DEFAULT '[]',
        input_versions_json TEXT NOT NULL DEFAULT '[]',
        output_artifacts_json TEXT NOT NULL DEFAULT '[]',
        gate_json TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        node_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events (run_id, seq);
      CREATE TABLE IF NOT EXISTS workflow_approvals (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        note TEXT NOT NULL DEFAULT ''
      );
    `,
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqliteDatabase = any;

export class ProjectDB {
  readonly db: SqliteDatabase;
  readonly path: string;

  constructor(projectRoot: string, fileName = join(".inkos", "inkos-v2.sqlite")) {
    const { DatabaseSync } = require("node:sqlite");
    this.path = join(projectRoot, fileName);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set<string>(
      this.db
        .prepare("SELECT id FROM schema_migrations")
        .all()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((row: any) => String(row.id)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
