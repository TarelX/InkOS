/**
 * Workflow template schema + DAG compiler.
 *
 * Templates are YAML/JSON documents describing node contracts (ADR-005).
 * The compiler rejects duplicate nodes, missing dependencies, cycles and
 * unknown executors before a run is ever created.
 */

import { z } from "zod";

export const NodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "stale",
  "interrupted",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const RunStatusSchema = z.enum(["created", "running", "waiting_approval", "succeeded", "failed", "cancelled"]);
export type WorkflowRunStatus = z.infer<typeof RunStatusSchema>;

export const NodeInputSchema = z.object({
  artifactId: z.string().min(1),
  /** "latest" pins the newest accepted version at execution time. */
  version: z.union([z.literal("latest"), z.number().int().positive()]).default("latest"),
  /** Optional inputs don't block readiness when absent. */
  optional: z.boolean().default(false),
});
export type NodeInput = z.infer<typeof NodeInputSchema>;

export const NodeOutputSchema = z.object({
  artifactId: z.string().min(1),
  schemaId: z.string().nullable().default(null),
});

export const NodeGateSchema = z.object({
  evaluator: z.string().min(1),
  /** Gate failure consumes an attempt; when attempts are exhausted → failed. */
  required: z.boolean().default(true),
});

export const NodeRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
});

export const NodeApprovalSchema = z.object({
  required: z.boolean().default(false),
  role: z.string().default("creator"),
});

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  label: z.string().default(""),
  executor: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  inputs: z.array(NodeInputSchema).default([]),
  outputs: z.array(NodeOutputSchema).default([]),
  gate: NodeGateSchema.nullable().default(null),
  retry: NodeRetrySchema.default({ maxAttempts: 1 }),
  approval: NodeApprovalSchema.default({ required: false, role: "creator" }),
  /** Idempotent nodes may auto-resume after an interruption. */
  idempotent: z.boolean().default(true),
  params: z.record(z.unknown()).default({}),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowTemplateSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  version: z.string().default("1"),
  label: z.string().default(""),
  nodes: z.array(WorkflowNodeSchema).min(1),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

export interface CompiledWorkflow {
  readonly template: WorkflowTemplate;
  /** Topological order (stable: template order among independent nodes). */
  readonly order: ReadonlyArray<string>;
  readonly nodesById: ReadonlyMap<string, WorkflowNode>;
  readonly dependentsOf: ReadonlyMap<string, ReadonlyArray<string>>;
}

export class WorkflowCompileError extends Error {
  constructor(readonly issues: ReadonlyArray<string>) {
    super(`workflow template invalid:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowCompileError";
  }
}

export function compileWorkflow(raw: unknown, knownExecutors?: ReadonlySet<string>): CompiledWorkflow {
  const template = WorkflowTemplateSchema.parse(raw);
  const issues: string[] = [];

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of template.nodes) {
    if (nodesById.has(node.id)) issues.push(`duplicate node id: ${node.id}`);
    nodesById.set(node.id, node);
  }

  const producers = new Map<string, string>();
  for (const node of template.nodes) {
    for (const output of node.outputs) {
      const existing = producers.get(output.artifactId);
      if (existing) issues.push(`artifact ${output.artifactId} produced by both ${existing} and ${node.id}`);
      else producers.set(output.artifactId, node.id);
    }
  }

  for (const node of template.nodes) {
    for (const dep of node.dependsOn) {
      if (!nodesById.has(dep)) issues.push(`node ${node.id} depends on unknown node ${dep}`);
      if (dep === node.id) issues.push(`node ${node.id} depends on itself`);
    }
    if (knownExecutors && !knownExecutors.has(node.executor)) {
      issues.push(`node ${node.id} uses unknown executor ${node.executor}`);
    }
  }

  // Kahn topological sort, preserving template order for determinism.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of template.nodes) {
    inDegree.set(node.id, node.dependsOn.filter((d) => nodesById.has(d)).length);
    for (const dep of node.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(node.id);
    }
  }
  const order: string[] = [];
  const queue = template.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length !== template.nodes.length && issues.length === 0) {
    const inCycle = template.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    issues.push(`dependency cycle involving: ${inCycle.join(", ")}`);
  }

  if (issues.length > 0) throw new WorkflowCompileError(issues);

  return {
    template,
    order,
    nodesById,
    dependentsOf: new Map([...dependents.entries()].map(([k, v]) => [k, [...v]])),
  };
}
