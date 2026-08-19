/**
 * Built-in `novel-adaptation` workflow template (V2.1 vertical slice).
 *
 * Human gates sit on the two highest-leverage decisions: the Adaptation
 * Contract and the Target Spine (ADR "不要确认地狱"). Draft chapters gate on
 * the combined fidelity audits.
 *
 * Projects may override built-ins by dropping a YAML template with the same
 * id into `.agents/workflows/` (see workflow/template-loader.ts).
 */

import type { WorkflowTemplate } from "../workflow/template.js";

/**
 * 分析专用模板：只跑深度拆文，产物落在本书自身（sourceBookId 缺省 = 自己）。
 * 面向"导入原著 → 先分析、后决定改编"的工作流（设计方案 §18 novel-analysis）。
 */
export const NOVEL_ANALYSIS_TEMPLATE: WorkflowTemplate = {
  id: "novel-analysis",
  version: "2.1",
  label: "深度拆文（仅分析）",
  nodes: [
    {
      id: "deep_deconstruction",
      label: "深度拆文",
      executor: "si.deep-analysis",
      dependsOn: [],
      inputs: [],
      outputs: [
        { artifactId: "analysis.scenes", schemaId: "scene.v2" },
        { artifactId: "analysis.events", schemaId: "event.v2" },
        { artifactId: "analysis.entities", schemaId: "entity.v2" },
        { artifactId: "analysis.entity-merge-proposals", schemaId: "entity-merge.v2" },
        { artifactId: "analysis.causal-graph", schemaId: "causal-edge.v2" },
        { artifactId: "analysis.storylines", schemaId: "storyline.v2" },
        { artifactId: "analysis.pacing", schemaId: "pacing.v2" },
      ],
      gate: { evaluator: "deep-analysis-gate", required: true },
      retry: { maxAttempts: 2 },
      approval: { required: false, role: "creator" },
      idempotent: true,
      params: {},
    },
  ],
};

export const NOVEL_ADAPTATION_TEMPLATE: WorkflowTemplate = {
  id: "novel-adaptation",
  version: "2.1",
  label: "小说改编（保真闭环）",
  nodes: [
    {
      id: "deep_deconstruction",
      label: "深度拆文",
      executor: "si.deep-analysis",
      dependsOn: [],
      inputs: [],
      outputs: [
        { artifactId: "analysis.scenes", schemaId: "scene.v2" },
        { artifactId: "analysis.events", schemaId: "event.v2" },
        { artifactId: "analysis.entities", schemaId: "entity.v2" },
        { artifactId: "analysis.entity-merge-proposals", schemaId: "entity-merge.v2" },
        { artifactId: "analysis.causal-graph", schemaId: "causal-edge.v2" },
        { artifactId: "analysis.storylines", schemaId: "storyline.v2" },
        { artifactId: "analysis.pacing", schemaId: "pacing.v2" },
      ],
      gate: { evaluator: "deep-analysis-gate", required: true },
      retry: { maxAttempts: 2 },
      approval: { required: false, role: "creator" },
      idempotent: true,
      params: {},
    },
    {
      id: "adaptation_contract",
      label: "改编契约",
      executor: "adapt.contract",
      dependsOn: ["deep_deconstruction"],
      inputs: [
        { artifactId: "analysis.storylines", version: "latest", optional: false },
        { artifactId: "analysis.events", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.contract", schemaId: "adaptation-contract.v1" }],
      gate: null,
      retry: { maxAttempts: 1 },
      approval: { required: true, role: "creator" },
      idempotent: true,
      params: {},
    },
    {
      id: "event_map",
      label: "事件映射",
      executor: "adapt.event-map",
      dependsOn: ["adaptation_contract"],
      inputs: [
        { artifactId: "adaptation.contract", version: "latest", optional: false },
        { artifactId: "analysis.events", version: "latest", optional: false },
        { artifactId: "analysis.causal-graph", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.event-map", schemaId: "event-decision.v1" }],
      gate: { evaluator: "adaptation-map-gate", required: true },
      retry: { maxAttempts: 2 },
      approval: { required: false, role: "creator" },
      idempotent: true,
      params: {},
    },
    {
      id: "character_map",
      label: "人物映射",
      executor: "adapt.character-map",
      dependsOn: ["adaptation_contract"],
      inputs: [
        { artifactId: "adaptation.contract", version: "latest", optional: false },
        { artifactId: "analysis.entities", version: "latest", optional: false },
        { artifactId: "analysis.events", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.character-map", schemaId: "character-map.v1" }],
      gate: { evaluator: "role-provenance-gate", required: true },
      retry: { maxAttempts: 2 },
      approval: { required: false, role: "creator" },
      idempotent: true,
      params: {},
    },
    {
      id: "target_spine",
      label: "目标主线骨架",
      executor: "adapt.target-spine",
      dependsOn: ["event_map", "character_map"],
      inputs: [
        { artifactId: "adaptation.contract", version: "latest", optional: false },
        { artifactId: "adaptation.event-map", version: "latest", optional: false },
        { artifactId: "adaptation.character-map", version: "latest", optional: false },
        { artifactId: "analysis.storylines", version: "latest", optional: false },
        { artifactId: "analysis.events", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.target-spine", schemaId: "target-spine.v1" }],
      gate: null,
      retry: { maxAttempts: 2 },
      approval: { required: true, role: "creator" },
      idempotent: true,
      params: {},
    },
    {
      id: "chapter_contracts",
      label: "章级契约",
      executor: "adapt.chapter-contracts",
      dependsOn: ["target_spine"],
      inputs: [
        { artifactId: "adaptation.target-spine", version: "latest", optional: false },
        { artifactId: "adaptation.event-map", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.chapter-contracts", schemaId: "chapter-contract.v1" }],
      gate: { evaluator: "chapter-contract-gate", required: true },
      retry: { maxAttempts: 2 },
      approval: { required: false, role: "creator" },
      idempotent: true,
      params: { chapters: 3 },
    },
    {
      id: "draft_chapters",
      label: "改编章节草稿",
      executor: "adapt.draft-chapters",
      dependsOn: ["chapter_contracts"],
      inputs: [
        { artifactId: "adaptation.chapter-contracts", version: "latest", optional: false },
        { artifactId: "adaptation.character-map", version: "latest", optional: false },
        { artifactId: "analysis.events", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.drafts", schemaId: "adaptation-draft.v1" }],
      gate: null,
      retry: { maxAttempts: 2 },
      approval: { required: false, role: "creator" },
      idempotent: false,
      params: {},
    },
    {
      id: "fidelity_audit",
      label: "保真审计",
      executor: "adapt.fidelity-audit",
      dependsOn: ["draft_chapters"],
      inputs: [
        { artifactId: "adaptation.drafts", version: "latest", optional: false },
        { artifactId: "adaptation.contract", version: "latest", optional: false },
        { artifactId: "adaptation.event-map", version: "latest", optional: false },
        { artifactId: "analysis.causal-graph", version: "latest", optional: false },
      ],
      outputs: [{ artifactId: "adaptation.audit-report", schemaId: "adaptation-audit.v1" }],
      gate: { evaluator: "fidelity-audit-gate", required: true },
      retry: { maxAttempts: 1 },
      approval: { required: true, role: "creator" },
      idempotent: true,
      params: {},
    },
  ],
};
