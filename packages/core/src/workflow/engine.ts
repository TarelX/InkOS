/**
 * Persistent DAG workflow engine (ADR-005).
 *
 * State machine (per node):
 *   pending → running → succeeded
 *                     → gate fail → pending (attempt < max) | failed
 *                     → waiting_approval → succeeded | failed
 *   dep failed → blocked; run cancel → cancelled;
 *   process crash → interrupted (recovery); newer accepted upstream → stale.
 *
 * Node outputs are staged as `draft` artifact versions and only flip to
 * `accepted` when the gate passes and (if required) a human approves.
 */

import type { ArtifactInput } from "../artifacts/manifest.js";
import type { ArtifactStore, PublishInput } from "../artifacts/artifact-store.js";
import { RunRepository, type NodeRecord, type RunRecord } from "./run-repository.js";
import { compileWorkflow, type CompiledWorkflow, type WorkflowNode } from "./template.js";

export interface ResolvedInput extends ArtifactInput {
  readContent(fileName: string): Promise<string>;
}

export interface ExecutorContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly bookId: string;
  readonly attempt: number;
  readonly params: Record<string, unknown>;
  readonly inputs: ReadonlyArray<ResolvedInput>;
  readonly store: ArtifactStore;
  emit(type: string, payload?: Record<string, unknown>): void;
}

export interface ExecutorOutput {
  readonly artifactId: string;
  readonly content: Readonly<Record<string, string>>;
  readonly schemaId?: string | null;
  readonly projections?: PublishInput["projections"];
}

export interface ExecutorResult {
  readonly outputs: ReadonlyArray<ExecutorOutput>;
}

export type NodeExecutor = (ctx: ExecutorContext) => Promise<ExecutorResult>;

export interface GateResult {
  readonly pass: boolean;
  /** Programmatically-checked hard-constraint violations (one veto each). */
  readonly hardViolations: ReadonlyArray<string>;
  /** Rubric scores are ranking signals only (ADR-006). */
  readonly rubric?: Record<string, number>;
  readonly evidence?: unknown;
}

export interface GateContext extends ExecutorContext {
  readonly outputs: ReadonlyArray<ArtifactInput>;
}

export type GateEvaluator = (ctx: GateContext) => Promise<GateResult>;

export interface WorkflowEngineOptions {
  readonly repo: RunRepository;
  readonly storeForBook: (bookId: string) => ArtifactStore;
  readonly executors: ReadonlyMap<string, NodeExecutor>;
  readonly gates?: ReadonlyMap<string, GateEvaluator>;
}

export class WorkflowEngine {
  private readonly repo: RunRepository;
  private readonly storeForBook: (bookId: string) => ArtifactStore;
  private readonly executors: ReadonlyMap<string, NodeExecutor>;
  private readonly gates: ReadonlyMap<string, GateEvaluator>;
  private readonly compiled = new Map<string, CompiledWorkflow>();

  constructor(options: WorkflowEngineOptions) {
    this.repo = options.repo;
    this.storeForBook = options.storeForBook;
    this.executors = options.executors;
    this.gates = options.gates ?? new Map();
  }

  registerTemplate(raw: unknown): CompiledWorkflow {
    const compiled = compileWorkflow(raw, new Set(this.executors.keys()));
    this.compiled.set(compiled.template.id, compiled);
    return compiled;
  }

  getTemplate(templateId: string): CompiledWorkflow {
    const compiled = this.compiled.get(templateId);
    if (!compiled) throw new Error(`workflow template not registered: ${templateId}`);
    return compiled;
  }

  listTemplates(): ReadonlyArray<CompiledWorkflow> {
    return [...this.compiled.values()];
  }

  createRun(templateId: string, bookId: string, params: Record<string, unknown> = {}): RunRecord {
    const compiled = this.getTemplate(templateId);
    const run = this.repo.createRun(compiled.template, bookId, params);
    this.repo.appendEvent(run.runId, null, "workflow.run.created", { templateId, bookId });
    return run;
  }

  /** Execute every currently-ready node once. Returns number of nodes executed. */
  async tick(runId: string): Promise<number> {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status === "cancelled" || run.status === "failed" || run.status === "succeeded") return 0;

    const compiled = this.getTemplate(run.templateId);
    if (run.status === "created") {
      this.repo.setRunStatus(runId, "running");
      this.repo.appendEvent(runId, null, "workflow.run.started", {});
    }

    this.propagateBlocked(runId);

    const nodes = new Map(this.repo.listNodes(runId).map((n) => [n.nodeId, n]));
    let executed = 0;
    for (const nodeId of compiled.order) {
      const record = nodes.get(nodeId);
      if (!record || (record.status !== "pending" && record.status !== "ready")) continue;
      if (!this.depsSucceeded(record, nodes)) continue;
      await this.executeNode(run, compiled.nodesById.get(nodeId)!, record);
      executed++;
      // refresh snapshot: this node's completion may unblock later nodes in the same tick
      for (const n of this.repo.listNodes(runId)) nodes.set(n.nodeId, n);
    }

    this.settleRunStatus(runId);
    return executed;
  }

  /** Loop ticks until no node makes progress (terminal or waiting on human). */
  async runToCompletion(runId: string, maxTicks = 100): Promise<RunRecord> {
    for (let i = 0; i < maxTicks; i++) {
      const executed = await this.tick(runId);
      if (executed === 0) break;
    }
    return this.repo.getRun(runId)!;
  }

  private depsSucceeded(record: NodeRecord, nodes: ReadonlyMap<string, NodeRecord>): boolean {
    return record.dependsOn.every((dep) => nodes.get(dep)?.status === "succeeded");
  }

  private propagateBlocked(runId: string): void {
    const nodes = new Map(this.repo.listNodes(runId).map((n) => [n.nodeId, n]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes.values()) {
        if (node.status !== "pending" && node.status !== "ready") continue;
        const badDep = node.dependsOn.some((dep) => {
          const status = nodes.get(dep)?.status;
          return status === "failed" || status === "blocked" || status === "cancelled";
        });
        if (badDep) {
          this.repo.updateNode(runId, node.nodeId, { status: "blocked" });
          this.repo.appendEvent(runId, node.nodeId, "workflow.node.blocked", {});
          nodes.set(node.nodeId, { ...node, status: "blocked" });
          changed = true;
        }
      }
    }
  }

  private async resolveInputs(
    run: RunRecord,
    node: WorkflowNode,
    store: ArtifactStore,
  ): Promise<{ resolved: ResolvedInput[]; missing: string[] }> {
    const resolved: ResolvedInput[] = [];
    const missing: string[] = [];
    for (const input of node.inputs) {
      let version: number | null = null;
      if (input.version === "latest") {
        const latest = await store.latest(input.artifactId, { status: "accepted" });
        version = latest?.version ?? null;
      } else {
        version = (await store.getManifest(input.artifactId, input.version)) ? input.version : null;
      }
      if (version == null) {
        if (!input.optional) missing.push(input.artifactId);
        continue;
      }
      const pinnedVersion = version;
      resolved.push({
        artifactId: input.artifactId,
        version: pinnedVersion,
        readContent: (fileName) => store.readContent(input.artifactId, pinnedVersion, fileName),
      });
    }
    return { resolved, missing };
  }

  private async executeNode(run: RunRecord, node: WorkflowNode, record: NodeRecord): Promise<void> {
    const { runId } = run;
    const store = this.storeForBook(run.bookId);
    const attempt = record.attempt + 1;

    const { resolved, missing } = await this.resolveInputs(run, node, store);
    if (missing.length > 0) {
      this.failNode(runId, node, attempt, `missing required input artifacts: ${missing.join(", ")}`);
      return;
    }

    this.repo.updateNode(runId, node.id, {
      status: "running",
      attempt,
      startedAt: new Date().toISOString(),
      inputVersions: resolved.map(({ artifactId, version }) => ({ artifactId, version })),
      error: null,
    });
    this.repo.appendEvent(runId, node.id, "workflow.node.started", { attempt });

    const executor = this.executors.get(node.executor);
    if (!executor) {
      this.failNode(runId, node, attempt, `executor not registered: ${node.executor}`, false);
      return;
    }

    const ctx: ExecutorContext = {
      runId,
      nodeId: node.id,
      bookId: run.bookId,
      attempt,
      params: { ...run.params, ...node.params },
      inputs: resolved,
      store,
      emit: (type, payload = {}) => {
        this.repo.appendEvent(runId, node.id, type, payload);
      },
    };

    let result: ExecutorResult;
    try {
      result = await executor(ctx);
    } catch (err) {
      this.retryOrFail(runId, node, attempt, err instanceof Error ? err.message : String(err));
      return;
    }

    const declared = new Set(node.outputs.map((o) => o.artifactId));
    const undeclared = result.outputs.filter((o) => !declared.has(o.artifactId));
    if (undeclared.length > 0) {
      this.failNode(
        runId,
        node,
        attempt,
        `executor produced undeclared artifacts: ${undeclared.map((o) => o.artifactId).join(", ")}`,
        false,
      );
      return;
    }

    // Stage outputs as drafts pinned to the resolved inputs.
    const published: ArtifactInput[] = [];
    for (const output of result.outputs) {
      const schemaId = node.outputs.find((o) => o.artifactId === output.artifactId)?.schemaId ?? output.schemaId ?? null;
      const manifest = await store.publish({
        artifactId: output.artifactId,
        createdBy: node.executor,
        content: output.content,
        inputs: resolved.map(({ artifactId, version }) => ({ artifactId, version })),
        runId,
        nodeId: node.id,
        schemaId,
        projections: output.projections,
        status: "draft",
      });
      published.push({ artifactId: manifest.artifactId, version: manifest.version });
      this.repo.appendEvent(runId, node.id, "workflow.node.artifact", {
        artifactId: manifest.artifactId,
        version: manifest.version,
      });
    }
    this.repo.updateNode(runId, node.id, { outputArtifacts: published });

    // Gate evaluation.
    if (node.gate) {
      const evaluator = this.gates.get(node.gate.evaluator);
      if (!evaluator) {
        this.failNode(runId, node, attempt, `gate evaluator not registered: ${node.gate.evaluator}`, false);
        return;
      }
      const gateResult = await evaluator({ ...ctx, outputs: published });
      this.repo.updateNode(runId, node.id, { gateResult });
      if (!gateResult.pass) {
        for (const artifact of published) {
          await store.setStatus(artifact.artifactId, artifact.version, "rejected", `gate:${node.gate.evaluator}`);
        }
        this.repo.appendEvent(runId, node.id, "workflow.node.gate_failed", {
          hardViolations: [...gateResult.hardViolations],
        });
        this.retryOrFail(runId, node, attempt, `gate failed: ${gateResult.hardViolations.join("; ") || "rubric below bar"}`);
        return;
      }
    }

    if (node.approval.required) {
      this.repo.createApproval(runId, node.id);
      this.repo.updateNode(runId, node.id, { status: "waiting_approval" });
      this.repo.appendEvent(runId, node.id, "workflow.node.waiting_approval", { role: node.approval.role });
      return;
    }

    await this.finalizeSuccess(runId, run.bookId, node.id, published, node.executor);
  }

  private async finalizeSuccess(
    runId: string,
    bookId: string,
    nodeId: string,
    outputs: ReadonlyArray<ArtifactInput>,
    acceptedBy: string,
  ): Promise<void> {
    const store = this.storeForBook(bookId);
    for (const artifact of outputs) {
      await store.setStatus(artifact.artifactId, artifact.version, "accepted", acceptedBy);
    }
    this.repo.updateNode(runId, nodeId, { status: "succeeded", finishedAt: new Date().toISOString() });
    this.repo.appendEvent(runId, nodeId, "workflow.node.succeeded", {
      outputs: outputs.map((o) => `${o.artifactId}@v${o.version}`),
    });
  }

  private retryOrFail(runId: string, node: WorkflowNode, attempt: number, error: string): void {
    if (attempt < node.retry.maxAttempts) {
      this.repo.updateNode(runId, node.id, { status: "pending", error });
      this.repo.appendEvent(runId, node.id, "workflow.node.retry_scheduled", { attempt, error });
    } else {
      this.failNode(runId, node, attempt, error);
    }
  }

  private failNode(runId: string, node: WorkflowNode, attempt: number, error: string, countAttempt = true): void {
    this.repo.updateNode(runId, node.id, {
      status: "failed",
      attempt: countAttempt ? attempt : attempt - 1,
      error,
      finishedAt: new Date().toISOString(),
    });
    this.repo.appendEvent(runId, node.id, "workflow.node.failed", { error });
  }

  private settleRunStatus(runId: string): void {
    const nodes = this.repo.listNodes(runId);
    const run = this.repo.getRun(runId)!;
    if (run.status === "cancelled") return;
    if (nodes.every((n) => n.status === "succeeded")) {
      this.repo.setRunStatus(runId, "succeeded");
      this.repo.appendEvent(runId, null, "workflow.run.completed", {});
      return;
    }
    if (nodes.some((n) => n.status === "waiting_approval")) {
      this.repo.setRunStatus(runId, "waiting_approval");
      return;
    }
    const anyActionable = nodes.some(
      (n) => n.status === "pending" || n.status === "ready" || n.status === "running",
    );
    if (!anyActionable && nodes.some((n) => n.status === "failed" || n.status === "blocked")) {
      this.repo.setRunStatus(runId, "failed");
      this.repo.appendEvent(runId, null, "workflow.run.failed", {});
      return;
    }
    this.repo.setRunStatus(runId, "running");
  }

  async approve(approvalId: string, by: string, note = ""): Promise<void> {
    const approval = this.repo.getApproval(approvalId);
    if (!approval || approval.status !== "pending") throw new Error(`approval not pending: ${approvalId}`);
    const run = this.repo.getRun(approval.runId)!;
    const node = this.repo.getNode(approval.runId, approval.nodeId)!;
    this.repo.resolveApproval(approvalId, "approved", by, note);
    await this.finalizeSuccess(approval.runId, run.bookId, approval.nodeId, node.outputArtifacts, by);
    this.settleRunStatus(approval.runId);
  }

  async reject(approvalId: string, by: string, note = ""): Promise<void> {
    const approval = this.repo.getApproval(approvalId);
    if (!approval || approval.status !== "pending") throw new Error(`approval not pending: ${approvalId}`);
    const run = this.repo.getRun(approval.runId)!;
    const node = this.repo.getNode(approval.runId, approval.nodeId)!;
    const store = this.storeForBook(run.bookId);
    this.repo.resolveApproval(approvalId, "rejected", by, note);
    for (const artifact of node.outputArtifacts) {
      await store.setStatus(artifact.artifactId, artifact.version, "rejected", by, note);
    }
    this.repo.updateNode(approval.runId, approval.nodeId, {
      status: "failed",
      error: `rejected by ${by}: ${note}`,
      finishedAt: new Date().toISOString(),
    });
    this.repo.appendEvent(approval.runId, approval.nodeId, "workflow.node.failed", { error: "approval rejected" });
    this.propagateBlocked(approval.runId);
    this.settleRunStatus(approval.runId);
  }

  /** Manual retry of a failed/interrupted/stale node: fresh attempt budget, unblocks downstream. */
  retryNode(runId: string, nodeId: string): void {
    const node = this.repo.getNode(runId, nodeId);
    if (!node) throw new Error(`node not found: ${nodeId}`);
    if (!["failed", "interrupted", "stale", "blocked"].includes(node.status)) {
      throw new Error(`node ${nodeId} is ${node.status}; only failed/interrupted/stale/blocked can be retried`);
    }
    this.repo.updateNode(runId, nodeId, { status: "pending", attempt: 0, error: null, finishedAt: null });
    this.repo.appendEvent(runId, nodeId, "workflow.node.retried", {});
    // Downstream blocked nodes get another chance.
    for (const other of this.repo.listNodes(runId)) {
      if (other.status === "blocked") {
        this.repo.updateNode(runId, other.nodeId, { status: "pending" });
      }
    }
    const run = this.repo.getRun(runId)!;
    if (run.status === "failed") this.repo.setRunStatus(runId, "running");
  }

  cancelRun(runId: string): void {
    for (const node of this.repo.listNodes(runId)) {
      if (["pending", "ready", "running", "waiting_approval", "interrupted"].includes(node.status)) {
        this.repo.updateNode(runId, node.nodeId, { status: "cancelled" });
        this.repo.appendEvent(runId, node.nodeId, "workflow.node.cancelled", {});
      }
    }
    this.repo.setRunStatus(runId, "cancelled");
    this.repo.appendEvent(runId, null, "workflow.run.cancelled", {});
  }

  /**
   * Staleness sweep: a succeeded node is stale when any pinned input has a
   * newer accepted version; staleness propagates to succeeded descendants.
   */
  async markStale(runId: string): Promise<ReadonlyArray<string>> {
    const run = this.repo.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const compiled = this.getTemplate(run.templateId);
    const store = this.storeForBook(run.bookId);
    const nodes = new Map(this.repo.listNodes(runId).map((n) => [n.nodeId, n]));
    const stale = new Set<string>();

    for (const nodeId of compiled.order) {
      const node = nodes.get(nodeId);
      if (!node || node.status !== "succeeded") continue;
      const upstreamStale = node.dependsOn.some((dep) => stale.has(dep));
      let inputStale = false;
      if (!upstreamStale) {
        for (const input of node.inputVersions) {
          const latest = await store.latest(input.artifactId, { status: "accepted" });
          if (latest && latest.version > input.version) {
            inputStale = true;
            break;
          }
        }
      }
      if (upstreamStale || inputStale) {
        stale.add(nodeId);
        this.repo.updateNode(runId, nodeId, { status: "stale" });
        this.repo.appendEvent(runId, nodeId, "workflow.node.stale", {
          reason: upstreamStale ? "upstream-stale" : "newer-accepted-input",
        });
      }
    }
    return [...stale];
  }

  /** Startup recovery: interrupt running nodes; auto-requeue idempotent ones. */
  recover(): { interrupted: number; requeued: number } {
    const interrupted = this.repo.markRunningAsInterrupted();
    let requeued = 0;
    for (const run of this.repo.listRuns()) {
      if (["succeeded", "failed", "cancelled"].includes(run.status)) continue;
      for (const node of this.repo.listNodes(run.runId)) {
        if (node.status === "interrupted" && node.idempotent) {
          this.repo.updateNode(run.runId, node.nodeId, { status: "pending", error: null });
          this.repo.appendEvent(run.runId, node.nodeId, "workflow.node.requeued", { reason: "recovery" });
          requeued++;
        }
      }
    }
    return { interrupted, requeued };
  }
}
