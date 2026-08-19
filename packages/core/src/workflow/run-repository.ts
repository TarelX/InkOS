/**
 * SQLite persistence for workflow runs/nodes/events/approvals.
 * The engine never keeps authoritative state in memory (ADR-005):
 * browser refresh and process restart both recover from these tables.
 */

import { randomUUID } from "node:crypto";

import type { ProjectDB } from "../v2/project-db.js";
import type { ArtifactInput } from "../artifacts/manifest.js";
import type { NodeStatus, WorkflowRunStatus, WorkflowTemplate } from "./template.js";

export interface RunRecord {
  readonly runId: string;
  readonly bookId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly status: WorkflowRunStatus;
  readonly params: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface NodeRecord {
  readonly runId: string;
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotent: boolean;
  readonly dependsOn: ReadonlyArray<string>;
  readonly inputVersions: ReadonlyArray<ArtifactInput>;
  readonly outputArtifacts: ReadonlyArray<ArtifactInput>;
  readonly gateResult: unknown;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface WorkflowEventRecord {
  readonly seq: number;
  readonly runId: string;
  readonly nodeId: string | null;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly requestedAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly note: string;
}

export class RunRepository {
  constructor(private readonly projectDb: ProjectDB) {}

  private get db() {
    return this.projectDb.db;
  }

  createRun(template: WorkflowTemplate, bookId: string, params: Record<string, unknown>): RunRecord {
    const now = new Date().toISOString();
    const runId = `run_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO workflow_runs (run_id, book_id, template_id, template_version, status, params_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?)`,
      )
      .run(runId, bookId, template.id, template.version, JSON.stringify(params), now, now);
    for (const node of template.nodes) {
      this.db
        .prepare(
          `INSERT INTO workflow_nodes
             (run_id, node_id, status, attempt, max_attempts, idempotent, depends_json, updated_at)
           VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .run(runId, node.id, node.retry.maxAttempts, node.idempotent ? 1 : 0, JSON.stringify(node.dependsOn), now);
    }
    return this.getRun(runId)!;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`).get(runId);
    return row ? mapRun(row) : null;
  }

  listRuns(bookId?: string): ReadonlyArray<RunRecord> {
    const rows = bookId
      ? this.db.prepare(`SELECT * FROM workflow_runs WHERE book_id = ? ORDER BY created_at DESC`).all(bookId)
      : this.db.prepare(`SELECT * FROM workflow_runs ORDER BY created_at DESC`).all();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((row: any) => mapRun(row));
  }

  setRunStatus(runId: string, status: WorkflowRunStatus): void {
    const now = new Date().toISOString();
    const finished = status === "succeeded" || status === "failed" || status === "cancelled" ? now : null;
    this.db
      .prepare(`UPDATE workflow_runs SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at) WHERE run_id = ?`)
      .run(status, now, finished, runId);
  }

  getNode(runId: string, nodeId: string): NodeRecord | null {
    const row = this.db.prepare(`SELECT * FROM workflow_nodes WHERE run_id = ? AND node_id = ?`).get(runId, nodeId);
    return row ? mapNode(row) : null;
  }

  listNodes(runId: string): ReadonlyArray<NodeRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.db.prepare(`SELECT * FROM workflow_nodes WHERE run_id = ?`).all(runId).map((r: any) => mapNode(r));
  }

  updateNode(
    runId: string,
    nodeId: string,
    patch: Partial<{
      status: NodeStatus;
      attempt: number;
      inputVersions: ReadonlyArray<ArtifactInput>;
      outputArtifacts: ReadonlyArray<ArtifactInput>;
      gateResult: unknown;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
    }>,
  ): void {
    const current = this.getNode(runId, nodeId);
    if (!current) throw new Error(`node ${nodeId} not found in run ${runId}`);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workflow_nodes SET
           status = ?, attempt = ?, input_versions_json = ?, output_artifacts_json = ?,
           gate_json = ?, error = ?, started_at = ?, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND node_id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.attempt ?? current.attempt,
        JSON.stringify(patch.inputVersions ?? current.inputVersions),
        JSON.stringify(patch.outputArtifacts ?? current.outputArtifacts),
        patch.gateResult !== undefined ? JSON.stringify(patch.gateResult) : serializeGate(current.gateResult),
        patch.error !== undefined ? patch.error : current.error,
        patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
        now,
        runId,
        nodeId,
      );
  }

  appendEvent(runId: string, nodeId: string | null, type: string, payload: Record<string, unknown> = {}): number {
    const result = this.db
      .prepare(`INSERT INTO workflow_events (run_id, node_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, nodeId, type, JSON.stringify(payload), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, afterSeq = 0): ReadonlyArray<WorkflowEventRecord> {
    return this.db
      .prepare(`SELECT * FROM workflow_events WHERE run_id = ? AND seq > ? ORDER BY seq`)
      .all(runId, afterSeq)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((row: any) => ({
        seq: Number(row.seq),
        runId: String(row.run_id),
        nodeId: row.node_id == null ? null : String(row.node_id),
        type: String(row.type),
        payload: JSON.parse(String(row.payload_json || "{}")),
        createdAt: String(row.created_at),
      }));
  }

  createApproval(runId: string, nodeId: string): ApprovalRecord {
    const approvalId = `apr_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO workflow_approvals (approval_id, run_id, node_id, status, requested_at) VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(approvalId, runId, nodeId, new Date().toISOString());
    return this.getApproval(approvalId)!;
  }

  getApproval(approvalId: string): ApprovalRecord | null {
    const row = this.db.prepare(`SELECT * FROM workflow_approvals WHERE approval_id = ?`).get(approvalId);
    return row ? mapApproval(row) : null;
  }

  pendingApprovalFor(runId: string, nodeId: string): ApprovalRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_approvals WHERE run_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`)
      .get(runId, nodeId);
    return row ? mapApproval(row) : null;
  }

  resolveApproval(approvalId: string, status: "approved" | "rejected", by: string, note = ""): void {
    this.db
      .prepare(`UPDATE workflow_approvals SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE approval_id = ?`)
      .run(status, new Date().toISOString(), by, note, approvalId);
  }

  /** Startup recovery: every `running` node becomes `interrupted` (ADR-005). */
  markRunningAsInterrupted(): number {
    const rows = this.db.prepare(`SELECT run_id, node_id FROM workflow_nodes WHERE status = 'running'`).all();
    for (const row of rows) {
      this.updateNode(String(row.run_id), String(row.node_id), { status: "interrupted" });
      this.appendEvent(String(row.run_id), String(row.node_id), "workflow.node.interrupted", {});
    }
    return rows.length;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeGate(gate: any): string | null {
  return gate == null ? null : JSON.stringify(gate);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRun(row: any): RunRecord {
  return {
    runId: String(row.run_id),
    bookId: String(row.book_id),
    templateId: String(row.template_id),
    templateVersion: String(row.template_version ?? ""),
    status: String(row.status) as WorkflowRunStatus,
    params: JSON.parse(String(row.params_json || "{}")),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapNode(row: any): NodeRecord {
  return {
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    status: String(row.status) as NodeStatus,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    idempotent: Boolean(row.idempotent),
    dependsOn: JSON.parse(String(row.depends_json || "[]")),
    inputVersions: JSON.parse(String(row.input_versions_json || "[]")),
    outputArtifacts: JSON.parse(String(row.output_artifacts_json || "[]")),
    gateResult: row.gate_json == null ? null : JSON.parse(String(row.gate_json)),
    error: row.error == null ? null : String(row.error),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    updatedAt: String(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapApproval(row: any): ApprovalRecord {
  return {
    approvalId: String(row.approval_id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    status: String(row.status) as ApprovalRecord["status"],
    requestedAt: String(row.requested_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    resolvedBy: row.resolved_by == null ? null : String(row.resolved_by),
    note: String(row.note ?? ""),
  };
}
