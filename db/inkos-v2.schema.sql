-- InkOS V2 项目库（.inkos/inkos-v2.sqlite）：产物索引 + 工作流运行/节点/事件/审批
-- 仅结构，无数据。运行时由代码迁移自动建表，此文件用于查阅/审计。

CREATE TABLE artifact_index (
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

CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE workflow_approvals (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        note TEXT NOT NULL DEFAULT ''
      );

CREATE TABLE workflow_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        node_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

CREATE TABLE workflow_nodes (
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

CREATE TABLE workflow_runs (
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

CREATE INDEX idx_artifact_status
        ON artifact_index (book_id, artifact_id, status, version);

CREATE INDEX idx_workflow_events_run ON workflow_events (run_id, seq);
