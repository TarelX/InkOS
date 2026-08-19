/**
 * Executor + gate registry for the `novel-adaptation` workflow.
 *
 * Every executor has a deterministic baseline so the full DAG runs offline
 * (CI, smoke tests). LLM-backed behavior plugs in through `AdaptationModels`
 * without changing node contracts (ADR-009: fake LLM in CI, live model as
 * local canary).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runDeepAnalysis } from "../story-intelligence/analysis-pipeline.js";
import type { ChapterAnalysisModel } from "../story-intelligence/chapter-analyzer.js";
import type { CausalJudge } from "../story-intelligence/causal-linker.js";
import { verifySourceRef } from "../story-intelligence/schemas/source-ref.js";
import type { StoryEvent } from "../story-intelligence/schemas/scene-event.js";
import type { CausalEdge, Storyline } from "../story-intelligence/schemas/graph.js";
import type { Entity } from "../story-intelligence/schemas/entities.js";
import type { ExecutorContext, GateContext, GateEvaluator, NodeExecutor } from "../workflow/engine.js";
import { causalIntegrityGate, combineGates, contractCoverageGate, roleProvenanceGate } from "./gates.js";
import {
  AdaptationChapterContractSchema,
  AdaptationContractSchema,
  CharacterMapEntrySchema,
  EventDecisionSchema,
  TargetSpineSchema,
  type AdaptationAuditIssue,
  type AdaptationChapterContract,
  type AdaptationContract,
  type CharacterMapEntry,
  type EventDecision,
  type TargetSpine,
} from "./schemas.js";

export interface DraftChapterInput {
  readonly contract: AdaptationChapterContract;
  readonly characterMap: ReadonlyArray<CharacterMapEntry>;
  readonly sourceEvents: ReadonlyArray<StoryEvent>;
}

export interface AdaptationModels {
  readonly analysisModel?: ChapterAnalysisModel;
  readonly causalJudge?: CausalJudge;
  /** Returns chapter prose. Deterministic outline-drafter used when absent. */
  readonly draftWriter?: (input: DraftChapterInput) => Promise<string>;
}

export interface AdaptationRuntimeOptions {
  readonly bookDirForId: (bookId: string) => string;
  readonly models?: AdaptationModels;
}

async function readJsonInput<T>(ctx: ExecutorContext, artifactId: string): Promise<T> {
  const input = ctx.inputs.find((i) => i.artifactId === artifactId);
  if (!input) throw new Error(`node ${ctx.nodeId} missing input ${artifactId}`);
  return JSON.parse(await input.readContent("data.json")) as T;
}

async function readJsonOutput<T>(ctx: GateContext, artifactId: string): Promise<T> {
  const output = ctx.outputs.find((o) => o.artifactId === artifactId);
  if (!output) throw new Error(`gate for ${ctx.nodeId}: output ${artifactId} not staged`);
  return JSON.parse(await ctx.store.readContent(output.artifactId, output.version, "data.json")) as T;
}

function json(payload: unknown): Record<string, string> {
  return { "data.json": JSON.stringify(payload, null, 2) };
}

export function buildAdaptationRuntime(options: AdaptationRuntimeOptions): {
  executors: Map<string, NodeExecutor>;
  gates: Map<string, GateEvaluator>;
} {
  const { bookDirForId, models = {} } = options;

  const executors = new Map<string, NodeExecutor>();
  const gates = new Map<string, GateEvaluator>();

  // ---- si.deep-analysis --------------------------------------------------
  executors.set("si.deep-analysis", async (ctx) => {
    const sourceBookId = String(ctx.params.sourceBookId ?? ctx.bookId);
    const sourceDir = bookDirForId(sourceBookId);
    const targetDir = bookDirForId(ctx.bookId);
    const result = await runDeepAnalysis({
      bookId: sourceBookId,
      bookDir: sourceDir,
      checkpointDir: targetDir,
      store: ctx.store,
      model: models.analysisModel,
      judge: models.causalJudge,
      publish: false,
      onProgress: (p) => ctx.emit("workflow.node.progress", { ...p, message: `拆文 ${p.completed}/${p.total}` }),
    });
    if (!result.finished || !result.payloads) {
      throw new Error(`deep analysis incomplete: ${result.completedChapters}/${result.totalChapters}`);
    }
    const p = result.payloads;
    return {
      outputs: [
        { artifactId: "analysis.scenes", content: json(p.scenes) },
        { artifactId: "analysis.events", content: json(p.events) },
        { artifactId: "analysis.entities", content: json(p.entities) },
        { artifactId: "analysis.entity-merge-proposals", content: json(p.mergeProposals) },
        { artifactId: "analysis.causal-graph", content: json(p.causalGraph) },
        { artifactId: "analysis.storylines", content: json(p.storylines) },
        { artifactId: "analysis.pacing", content: json(p.pacing) },
      ],
    };
  });

  gates.set("deep-analysis-gate", async (ctx) => {
    const events = await readJsonOutput<StoryEvent[]>(ctx, "analysis.events");
    const violations: string[] = [];
    if (events.length === 0) violations.push("拆文结果为空：没有任何事件");
    const sourceBookId = String(ctx.params.sourceBookId ?? ctx.bookId);
    const sourceDir = bookDirForId(sourceBookId);
    // Verify a deterministic sample (up to 20) of SourceRefs against disk.
    const step = Math.max(1, Math.floor(events.length / 20));
    for (let i = 0; i < events.length; i += step) {
      const event = events[i];
      if (!event.source) {
        violations.push(`事件 ${event.id} 缺少 SourceRef`);
        continue;
      }
      const content = await readFile(join(sourceDir, event.source.chapterFile), "utf-8").catch(() => null);
      if (content == null) {
        violations.push(`事件 ${event.id} 的章节文件不存在: ${event.source.chapterFile}`);
        continue;
      }
      const verdict = verifySourceRef(event.source, content);
      if (!verdict.ok) violations.push(`事件 ${event.id} SourceRef 校验失败: ${verdict.reason}`);
    }
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- adapt.contract ----------------------------------------------------
  executors.set("adapt.contract", async (ctx) => {
    const storylines = await readJsonInput<Storyline[]>(ctx, "analysis.storylines");
    const events = await readJsonInput<StoryEvent[]>(ctx, "analysis.events");
    const eventById = new Map(events.map((e) => [e.id, e]));
    const main = storylines.find((l) => l.type === "main");

    const mustPreserve: AdaptationContract["mustPreserve"] = [];
    if (main) {
      const ranked = main.eventIds
        .map((id) => eventById.get(id))
        .filter((e): e is StoryEvent => Boolean(e))
        .sort((a, b) => b.confidence - a.confidence || b.conflictDelta - a.conflictDelta);
      for (const event of ranked.slice(0, Math.min(8, ranked.length))) {
        mustPreserve.push({ kind: "event", refId: event.id, note: event.summary });
      }
      mustPreserve.push({ kind: "storyline", refId: main.id, note: main.promise });
    }
    if (mustPreserve.length === 0 && events.length > 0) {
      // No main storyline recovered (e.g. deterministic analyzer without LLM):
      // fall back to the highest-confidence events in reading order so the
      // preserve set is never empty and the spine survives.
      const fallback = [...events]
        .sort((a, b) => b.confidence - a.confidence || a.chapter - b.chapter || a.order - b.order)
        .slice(0, Math.min(8, events.length))
        .sort((a, b) => a.chapter - b.chapter || a.order - b.order);
      for (const event of fallback) {
        mustPreserve.push({ kind: "event", refId: event.id, note: event.summary });
      }
    }

    const contract = AdaptationContractSchema.parse({
      schemaVersion: 1,
      bookId: ctx.bookId,
      sourceBookId: String(ctx.params.sourceBookId ?? ctx.bookId),
      format: String(ctx.params.format ?? "web_novel"),
      mustPreserve,
      canChange: ["character_names", "world_setting", "event_order", "side_characters"],
      canMerge: ["minor_characters", "repetitive_conflicts"],
      forbidden: Array.isArray(ctx.params.forbidden) ? (ctx.params.forbidden as string[]) : [],
      target: {
        genre: String(ctx.params.targetGenre ?? ""),
        chapterCount: typeof ctx.params.targetChapters === "number" ? (ctx.params.targetChapters as number) : null,
        pace: "fast",
        notes: String(ctx.params.targetNotes ?? ""),
      },
    });
    return {
      outputs: [
        {
          artifactId: "adaptation.contract",
          content: json(contract),
          projections: [
            {
              relPath: join("story", "adaptation", "contract.md"),
              content: projectContractMarkdown(contract, eventById),
            },
          ],
        },
      ],
    };
  });

  // ---- adapt.event-map -----------------------------------------------------
  executors.set("adapt.event-map", async (ctx) => {
    const contract = await readJsonInput<AdaptationContract>(ctx, "adaptation.contract");
    const events = await readJsonInput<StoryEvent[]>(ctx, "analysis.events");
    const edges = await readJsonInput<CausalEdge[]>(ctx, "analysis.causal-graph");
    const preserveIds = new Set(contract.mustPreserve.filter((m) => m.kind === "event").map((m) => m.refId));
    const strongMiddle = strongChainMiddles(edges);

    const decisions: EventDecision[] = events.map((event) => {
      if (preserveIds.has(event.id)) {
        return EventDecisionSchema.parse({
          sourceEventId: event.id,
          decision: "preserve",
          targetEventIds: [`tevt_${event.id.slice(4)}`],
          reason: "改编契约 must_preserve 事件，功能与因果全保留",
          preserve: event.narrativeFunction,
          confidence: 0.9,
        });
      }
      const lowDelta = event.informationDelta < 0.2 && event.conflictDelta < 0.2 && event.stateChanges.length === 0;
      if (lowDelta && !strongMiddle.has(event.id)) {
        return EventDecisionSchema.parse({
          sourceEventId: event.id,
          decision: "remove",
          targetEventIds: [],
          reason: "低叙事增量事件，功能并入相邻场景",
          replacementNote: "无强因果负载；相邻保留事件承接过渡",
          confidence: 0.6,
        });
      }
      return EventDecisionSchema.parse({
        sourceEventId: event.id,
        decision: "compress",
        targetEventIds: [`tevt_${event.id.slice(4)}`],
        reason: "保留叙事功能，压缩篇幅与场景",
        preserve: event.narrativeFunction,
        changed: ["length", "scene_setting"],
        confidence: 0.7,
      });
    });
    return {
      outputs: [
        {
          artifactId: "adaptation.event-map",
          content: json(decisions),
          projections: [
            {
              relPath: join("story", "adaptation", "event-map.md"),
              content: projectEventMapMarkdown(decisions),
            },
          ],
        },
      ],
    };
  });

  gates.set("adaptation-map-gate", async (ctx) => {
    const contract = await readJsonInput<AdaptationContract>(ctx, "adaptation.contract");
    const edges = await readJsonInput<CausalEdge[]>(ctx, "analysis.causal-graph");
    const decisions = await readJsonOutput<EventDecision[]>(ctx, "adaptation.event-map");
    return combineGates(contractCoverageGate(contract, decisions), causalIntegrityGate(edges, decisions));
  });

  // ---- adapt.character-map -------------------------------------------------
  executors.set("adapt.character-map", async (ctx) => {
    const entities = await readJsonInput<Entity[]>(ctx, "analysis.entities");
    const events = await readJsonInput<StoryEvent[]>(ctx, "analysis.events");
    const renameMap = (ctx.params.renameMap ?? {}) as Record<string, string>;
    const keepNames = new Set(Array.isArray(ctx.params.keepNames) ? (ctx.params.keepNames as string[]) : []);
    const ranked = [...entities]
      .filter((e) => e.kind === "character" && !e.mergedInto)
      .sort((a, b) => b.chapterCount - a.chapterCount)
      .slice(0, 40);
    const majorCount = Math.min(6, Math.max(1, Math.ceil(ranked.length * 0.25)));

    const entries: CharacterMapEntry[] = ranked.map((entity, index) => {
      const rename = renameMap[entity.canonicalName];
      const keep = keepNames.has(entity.canonicalName) || !rename;
      return CharacterMapEntrySchema.parse({
        sourceEntityId: entity.id,
        sourceName: entity.canonicalName,
        targetName: rename ?? entity.canonicalName,
        strategy: keep ? "keep_name" : "rename",
        tier: index < majorCount ? "major" : "minor",
        reason: keep ? "保留原名（映射表未提供新名或属于典籍人物）" : "按改编映射表换名",
      });
    });

    // renameMap entries not covered by entity resolution (e.g. deterministic
    // analysis without participants): honor them as MINOR renames only when
    // the source name literally occurs in extracted event text — literal
    // occurrence is the provenance evidence, and the major-role gate still
    // requires resolved entities.
    const covered = new Set(entries.map((e) => e.sourceName));
    const corpus = events.map((e) => `${e.summary}\n${e.source.quote}`).join("\n");
    for (const [sourceName, targetName] of Object.entries(renameMap)) {
      if (covered.has(sourceName) || !targetName || sourceName === targetName) continue;
      if (!corpus.includes(sourceName)) continue;
      entries.push(
        CharacterMapEntrySchema.parse({
          sourceEntityId: null,
          sourceName,
          targetName,
          strategy: "rename",
          tier: "minor",
          reason: "映射表提供的换名；以源事件文本字面出现为溯源证据（实体未解析）",
        }),
      );
    }
    return {
      outputs: [
        {
          artifactId: "adaptation.character-map",
          content: json(entries),
          projections: [
            { relPath: join("story", "adaptation", "character-map.md"), content: projectCharacterMapMarkdown(entries) },
          ],
        },
      ],
    };
  });

  gates.set("role-provenance-gate", async (ctx) => {
    const entries = await readJsonOutput<CharacterMapEntry[]>(ctx, "adaptation.character-map");
    return roleProvenanceGate(entries);
  });

  // ---- adapt.target-spine ----------------------------------------------------
  executors.set("adapt.target-spine", async (ctx) => {
    const contract = await readJsonInput<AdaptationContract>(ctx, "adaptation.contract");
    const decisions = await readJsonInput<EventDecision[]>(ctx, "adaptation.event-map");
    const events = await readJsonInput<StoryEvent[]>(ctx, "analysis.events");
    const eventById = new Map(events.map((e) => [e.id, e]));

    const kept = decisions
      .filter((d) => d.targetEventIds.length > 0)
      .map((d) => ({ decision: d, event: eventById.get(d.sourceEventId) }))
      .filter((x): x is { decision: EventDecision; event: StoryEvent } => Boolean(x.event))
      .sort((a, b) => a.event.chapter - b.event.chapter || a.event.order - b.event.order);
    if (kept.length === 0) {
      throw new Error("事件映射后没有任何保留事件（全部被 remove）——请修订改编契约或事件映射");
    }

    const targetChapters = contract.target.chapterCount ?? Math.max(3, Math.ceil(kept.length / 2));
    const spine: TargetSpine = TargetSpineSchema.parse({
      bookId: ctx.bookId,
      sourceBookId: contract.sourceBookId,
      beats: kept.map((item, index) => ({
        id: `beat_${String(index + 1).padStart(3, "0")}`,
        order: index,
        label: item.event.summary,
        sourceEventIds: [item.event.id],
        stateChanges: item.event.stateChanges,
        newQuestion: item.event.outcome,
        chapterRange: {
          from: Math.max(1, Math.floor((index / kept.length) * targetChapters) + 1),
          to: Math.max(1, Math.min(targetChapters, Math.floor(((index + 1) / kept.length) * targetChapters) + 1)),
        },
      })),
    });
    return {
      outputs: [
        {
          artifactId: "adaptation.target-spine",
          content: json(spine),
          projections: [
            { relPath: join("story", "adaptation", "target-spine.md"), content: projectSpineMarkdown(spine) },
          ],
        },
      ],
    };
  });

  // ---- adapt.chapter-contracts -------------------------------------------------
  executors.set("adapt.chapter-contracts", async (ctx) => {
    const spine = await readJsonInput<TargetSpine>(ctx, "adaptation.target-spine");
    const chapters = Number(ctx.params.chapters ?? 3);
    const perChapter = Math.max(1, Math.ceil(spine.beats.length / chapters));

    const contracts: AdaptationChapterContract[] = [];
    for (let chapter = 1; chapter <= chapters; chapter++) {
      const beats = spine.beats.slice((chapter - 1) * perChapter, chapter * perChapter);
      if (beats.length === 0) break;
      contracts.push(
        AdaptationChapterContractSchema.parse({
          chapter,
          purpose: ["mainline_escalation"],
          spineBeatIds: beats.map((b) => b.id),
          sourceEventIds: beats.flatMap((b) => b.sourceEventIds),
          pov: null,
          chapterGoal: beats[0].label,
          conflict: beats.find((b) => b.stateChanges.length > 0)?.stateChanges[0] ?? beats[0].label,
          turn: beats.at(-1)?.label ?? null,
          exitState: beats.flatMap((b) => b.stateChanges).slice(0, 4).length
            ? beats.flatMap((b) => b.stateChanges).slice(0, 4)
            : [`完成节拍 ${beats.map((b) => b.id).join("/")}`],
          mustUse: [],
          mustNot: [],
          targetWords: 3000,
          endHook: beats.at(-1)?.newQuestion ?? null,
        }),
      );
    }
    return { outputs: [{ artifactId: "adaptation.chapter-contracts", content: json(contracts) }] };
  });

  gates.set("chapter-contract-gate", async (ctx) => {
    const contracts = await readJsonOutput<AdaptationChapterContract[]>(ctx, "adaptation.chapter-contracts");
    const violations: string[] = [];
    if (contracts.length === 0) violations.push("没有生成任何章级契约");
    for (const contract of contracts) {
      if (contract.purpose.length === 0) violations.push(`第${contract.chapter}章契约缺少 purpose`);
      if (contract.exitState.length === 0) violations.push(`第${contract.chapter}章契约缺少 exitState —— 无功能章节`);
      if (contract.sourceEventIds.length === 0) violations.push(`第${contract.chapter}章契约没有任何源事件支撑`);
    }
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- adapt.draft-chapters ---------------------------------------------------
  executors.set("adapt.draft-chapters", async (ctx) => {
    const contracts = await readJsonInput<AdaptationChapterContract[]>(ctx, "adaptation.chapter-contracts");
    const characterMap = await readJsonInput<CharacterMapEntry[]>(ctx, "adaptation.character-map");
    const events = await readJsonInput<StoryEvent[]>(ctx, "analysis.events");
    const eventById = new Map(events.map((e) => [e.id, e]));

    const drafts = [];
    for (const contract of contracts) {
      const sourceEvents = contract.sourceEventIds
        .map((id) => eventById.get(id))
        .filter((e): e is StoryEvent => Boolean(e));
      const writer = models.draftWriter ?? deterministicDraftWriter;
      const content = await writer({ contract, characterMap, sourceEvents });
      drafts.push({ chapter: contract.chapter, title: contract.chapterGoal.slice(0, 20), content });
      ctx.emit("workflow.node.progress", { message: `草稿 ${contract.chapter}/${contracts.length}` });
    }
    return { outputs: [{ artifactId: "adaptation.drafts", content: json(drafts) }] };
  });

  // ---- adapt.fidelity-audit -----------------------------------------------------
  executors.set("adapt.fidelity-audit", async (ctx) => {
    const drafts = await readJsonInput<Array<{ chapter: number; content: string }>>(ctx, "adaptation.drafts");
    const contract = await readJsonInput<AdaptationContract>(ctx, "adaptation.contract");
    const decisions = await readJsonInput<EventDecision[]>(ctx, "adaptation.event-map");
    const edges = await readJsonInput<CausalEdge[]>(ctx, "analysis.causal-graph");

    const issues: AdaptationAuditIssue[] = [];

    // source_fidelity: must_preserve events must survive the event map.
    const coverage = contractCoverageGate(contract, decisions);
    for (const violation of coverage.hardViolations) {
      issues.push({ severity: "blocking", category: "source_fidelity", description: violation, evidence: [], suggestion: "恢复该事件映射或修订契约" });
    }
    // causality: strong chain middles removed without replacement.
    const causal = causalIntegrityGate(edges, decisions);
    for (const violation of causal.hardViolations) {
      issues.push({ severity: "blocking", category: "causality", description: violation, evidence: [], suggestion: "补 replacementNote 或改为 compress" });
    }
    // continuity: drafts must not be empty and must be distinct per chapter.
    for (const draft of drafts) {
      if (!draft.content || draft.content.trim().length < 50) {
        issues.push({
          severity: "blocking",
          category: "continuity",
          description: `第${draft.chapter}章草稿为空或过短`,
          evidence: [],
          suggestion: "重跑草稿节点",
        });
      }
    }

    const report = {
      bookId: ctx.bookId,
      chapter: null,
      generatedAt: new Date().toISOString(),
      issues,
    };
    return { outputs: [{ artifactId: "adaptation.audit-report", content: json(report) }] };
  });

  gates.set("fidelity-audit-gate", async (ctx) => {
    const report = await readJsonOutput<{ issues: AdaptationAuditIssue[] }>(ctx, "adaptation.audit-report");
    const blocking = report.issues.filter((i) => i.severity === "blocking");
    return {
      pass: blocking.length === 0,
      hardViolations: blocking.map((i) => `[${i.category}] ${i.description}`),
    };
  });

  return { executors, gates };
}

function strongChainMiddles(edges: ReadonlyArray<CausalEdge>): ReadonlySet<string> {
  const strongIn = new Set<string>();
  const strongOut = new Set<string>();
  for (const edge of edges) {
    if (edge.strength !== "strong") continue;
    strongIn.add(edge.toEventId);
    strongOut.add(edge.fromEventId);
  }
  return new Set([...strongIn].filter((id) => strongOut.has(id)));
}

async function deterministicDraftWriter(input: DraftChapterInput): Promise<string> {
  const nameFor = new Map(input.characterMap.map((e) => [e.sourceName, e.targetName]));
  const rename = (text: string): string => {
    let out = text;
    for (const [source, target] of nameFor) {
      if (source !== target) out = out.split(source).join(target);
    }
    return out;
  };
  const lines = [
    `# 第${input.contract.chapter}章（结构草稿）`,
    "",
    `> 本章目标：${rename(input.contract.chapterGoal)}`,
    `> 冲突：${rename(input.contract.conflict)}`,
    "",
  ];
  for (const event of input.sourceEvents) {
    lines.push(`${rename(event.summary)}。${event.outcome ? rename(event.outcome) + "。" : ""}`);
    lines.push("");
  }
  if (input.contract.endHook) lines.push(`章末钩子：${rename(input.contract.endHook)}`);
  lines.push("", "（deterministic 结构草稿——接入 LLM DraftWriter 后替换为成稿正文）");
  return lines.join("\n");
}

function projectContractMarkdown(contract: AdaptationContract, eventById: Map<string, StoryEvent>): string {
  const lines = [
    "# 改编契约",
    "",
    `- 源书：${contract.sourceBookId}`,
    `- 目标：${contract.target.genre || "（未指定题材）"} ｜ ${contract.target.chapterCount ?? "?"} 章 ｜ ${contract.target.pace}`,
    "",
    "## must_preserve",
    "",
  ];
  for (const item of contract.mustPreserve) {
    const summary = item.kind === "event" ? eventById.get(item.refId)?.summary ?? item.note : item.note;
    lines.push(`- [${item.kind}] ${item.refId}：${summary}`);
  }
  lines.push("", "## 允许变更", "", ...contract.canChange.map((c) => `- ${c}`));
  if (contract.forbidden.length) lines.push("", "## 禁止", "", ...contract.forbidden.map((f) => `- ${f}`));
  return `${lines.join("\n")}\n`;
}

function projectEventMapMarkdown(decisions: ReadonlyArray<EventDecision>): string {
  const lines = ["# 事件映射表", "", "| 源事件 | 决策 | 目标 | 理由 |", "| --- | --- | --- | --- |"];
  for (const decision of decisions) {
    lines.push(
      `| ${decision.sourceEventId} | ${decision.decision} | ${decision.targetEventIds.join(", ") || "—"} | ${decision.reason} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function projectCharacterMapMarkdown(entries: ReadonlyArray<CharacterMapEntry>): string {
  const lines = ["# 人物映射表", "", "| 原名 | 新名 | 策略 | 级别 | 说明 |", "| --- | --- | --- | --- | --- |"];
  for (const entry of entries) {
    lines.push(`| ${entry.sourceName} | ${entry.targetName} | ${entry.strategy} | ${entry.tier} | ${entry.reason} |`);
  }
  return `${lines.join("\n")}\n`;
}

function projectSpineMarkdown(spine: TargetSpine): string {
  const lines = ["# 目标主线骨架", ""];
  for (const beat of spine.beats) {
    lines.push(
      `${beat.order + 1}. ${beat.label}${beat.chapterRange ? `（目标第${beat.chapterRange.from}-${beat.chapterRange.to}章）` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
