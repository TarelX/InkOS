/**
 * `new-novel` 工作流的执行器与 Gate。
 *
 * 与改编管线同构：每个执行器都有确定性基线（离线/CI 可跑完整 DAG），接入
 * LLM 后同一节点契约不变。Gate 只用可程序判定的硬约束否决（ADR-006）。
 */

import { join } from "node:path";

import type { ExecutorContext, GateContext, GateEvaluator, NodeExecutor } from "../workflow/engine.js";
import { extractJson, type CompletionFn } from "../adaptation/llm-models.js";
import {
  ArcPlanSchema,
  CanonBibleSchema,
  ChapterAuditReportSchema,
  ConceptCandidatesSchema,
  CreativeBriefSchema,
  OriginalChapterContractSchema,
  OriginalSpineSchema,
  StateSnapshotSchema,
  type ArcPlan,
  type CanonBible,
  type ChapterAuditReport,
  type ConceptCandidates,
  type CreativeBrief,
  type MajorBeat,
  type OriginalChapterContract,
  type OriginalSpine,
} from "./schemas.js";

export interface CreationModels {
  /** 注入后所有节点走 LLM；缺省走确定性基线。 */
  readonly complete?: CompletionFn;
}

export interface CreationRuntimeOptions {
  readonly bookDirForId: (bookId: string) => string;
  readonly models?: CreationModels;
}

function json(payload: unknown): Record<string, string> {
  return { "data.json": JSON.stringify(payload, null, 2) };
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

/** 模型输出解析失败时不炸管线：返回 null，由调用方回退到确定性基线。 */
async function tryModelJson<T>(complete: CompletionFn | undefined, system: string, user: string): Promise<T | null> {
  if (!complete) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await complete([
        { role: "system", content: system },
        { role: "user", content: attempt === 0 ? user : `${user}\n（上次输出不是合法 JSON，重来，只输出 JSON）` },
      ]);
      return extractJson(reply) as T;
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

export function buildCreationRuntime(options: CreationRuntimeOptions): {
  executors: Map<string, NodeExecutor>;
  gates: Map<string, GateEvaluator>;
} {
  const complete = options.models?.complete;
  const executors = new Map<string, NodeExecutor>();
  const gates = new Map<string, GateEvaluator>();

  // ---- novel.brief ---------------------------------------------------------
  executors.set("novel.brief", async (ctx) => {
    const idea = String(ctx.params.idea ?? ctx.params.premise ?? "").trim();
    const genre = Array.isArray(ctx.params.genre)
      ? (ctx.params.genre as string[])
      : String(ctx.params.genre ?? "").split(/[、,，/]/).map((s) => s.trim()).filter(Boolean);
    const targetChapters = typeof ctx.params.targetChapters === "number" ? ctx.params.targetChapters : null;

    const modelResult = await tryModelJson<Partial<CreativeBrief>>(
      complete,
      `你是网文创作总监。把用户的创意扩展成可执行的创作简报。只输出 JSON：
{"coreFantasy":"核心爽点一句话","readerPromise":["读者承诺1","承诺2"],"tone":["基调"],"mustHave":["必须有"],"mustAvoid":["必须避免"],"targetAudience":"目标读者","assumptions":["你做的假设"]}`,
      [
        `创意：${idea || "（用户未提供，按题材给出通用但具体的定位）"}`,
        genre.length ? `题材：${genre.join("、")}` : "",
        targetChapters ? `目标篇幅：${targetChapters} 章` : "",
      ].filter(Boolean).join("\n"),
    );

    const brief = CreativeBriefSchema.parse({
      schemaVersion: 1,
      bookId: ctx.bookId,
      projectType: "original_novel",
      genre,
      targetAudience: modelResult?.targetAudience ?? String(ctx.params.targetAudience ?? ""),
      targetChapters,
      chapterWordTarget: typeof ctx.params.chapterWordTarget === "number" ? ctx.params.chapterWordTarget : 3000,
      coreFantasy: modelResult?.coreFantasy ?? idea,
      readerPromise: modelResult?.readerPromise ?? (idea ? [idea] : []),
      tone: modelResult?.tone ?? [],
      mustHave: modelResult?.mustHave ?? [],
      mustAvoid: modelResult?.mustAvoid ?? [],
      pov: String(ctx.params.pov ?? "third_limited"),
      assumptions: modelResult?.assumptions ?? (idea ? [] : ["用户未提供创意，简报为题材通用定位，需人工确认"]),
    });

    return {
      outputs: [
        {
          artifactId: "creation.brief",
          content: json(brief),
          projections: [{ relPath: join("story", "creative", "brief.md"), content: projectBriefMarkdown(brief) }],
        },
      ],
    };
  });

  gates.set("creative-brief-gate", async (ctx) => {
    const brief = await readJsonOutput<CreativeBrief>(ctx, "creation.brief");
    const violations: string[] = [];
    if (!brief.coreFantasy.trim()) violations.push("创作简报缺少核心爽点（coreFantasy）——没有它后续无法校验写没写偏");
    if (brief.readerPromise.length === 0) violations.push("创作简报缺少读者承诺（readerPromise）");
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- novel.concept-forge -------------------------------------------------
  executors.set("novel.concept-forge", async (ctx) => {
    const brief = await readJsonInput<CreativeBrief>(ctx, "creation.brief");
    const count = Math.max(2, Math.min(5, Number(ctx.params.candidateCount ?? 3)));

    const modelResult = await tryModelJson<{ candidates?: Array<Record<string, unknown>> }>(
      complete,
      `你是网文策划。基于创作简报，生成 ${count} 个【差异明显】的故事方案（不是同一个故事换名字）。
每个方案给出 premise/coreConflict/protagonistGoal/longTermObstacle/uniqueMechanism/emotionalCore/commercialHook/risks
以及 0-10 的评分 scores{hookStrength,conflictSustainability,characterAgency,worldExpandability,serialPotential,emotionalDepth,novelty}。
只输出 JSON：{"candidates":[{...}]}`,
      [
        `题材：${brief.genre.join("、") || "未指定"}`,
        `核心爽点：${brief.coreFantasy}`,
        `读者承诺：${brief.readerPromise.join("；")}`,
        brief.mustAvoid.length ? `必须避免：${brief.mustAvoid.join("；")}` : "",
      ].filter(Boolean).join("\n"),
    );

    const raw: Array<Record<string, unknown>> =
      Array.isArray(modelResult?.candidates) && modelResult.candidates.length > 0
        ? modelResult.candidates.slice(0, count)
        : Array.from({ length: count }, (_, i) => {
            const core = brief.coreFantasy || "主角在压迫性规则下求生";
            return {
              premise: `${core}（方案 ${i + 1}）`,
              coreConflict: brief.readerPromise[0] ?? core,
              // 冲突引擎的两个必填项在这里就要有值，否则 canon-gate 会判定
              // "无法支撑长篇"而阻断——基线方案也必须是可推进的。
              protagonistGoal: `达成：${core}`,
              longTermObstacle: brief.mustAvoid[0]
                ? `阻力：避免${brief.mustAvoid[0]}的同时仍要推进目标`
                : "系统性阻力：既有秩序会自我修复，压制任何越界者",
              uniqueMechanism: brief.tone[0] ? `以${brief.tone[0]}的方式解决冲突` : "",
              emotionalCore: brief.readerPromise[1] ?? "",
              risks: ["确定性基线方案，需接入模型或人工细化"],
            };
          });

    const candidates = raw.map((item, index) => {
      const s = (item.scores ?? {}) as Record<string, number>;
      const scores = {
        hookStrength: clamp10(s.hookStrength, 5),
        conflictSustainability: clamp10(s.conflictSustainability, 5),
        characterAgency: clamp10(s.characterAgency, 5),
        worldExpandability: clamp10(s.worldExpandability, 5),
        serialPotential: clamp10(s.serialPotential, 5),
        emotionalDepth: clamp10(s.emotionalDepth, 5),
        novelty: clamp10(s.novelty, 5),
      };
      const total = Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
      return {
        id: `concept_${index + 1}`,
        premise: String(item.premise ?? `方案 ${index + 1}`),
        coreConflict: String(item.coreConflict ?? ""),
        protagonistGoal: String(item.protagonistGoal ?? ""),
        longTermObstacle: String(item.longTermObstacle ?? ""),
        uniqueMechanism: String(item.uniqueMechanism ?? ""),
        emotionalCore: String(item.emotionalCore ?? ""),
        commercialHook: String(item.commercialHook ?? ""),
        risks: Array.isArray(item.risks) ? (item.risks as string[]).map(String) : [],
        scores,
        totalScore: Number(total.toFixed(2)),
      };
    });

    const doc = ConceptCandidatesSchema.parse({
      bookId: ctx.bookId,
      candidates,
      lockedConceptId: [...candidates].sort((a, b) => b.totalScore - a.totalScore)[0]?.id ?? null,
    });
    return {
      outputs: [
        {
          artifactId: "creation.concepts",
          content: json(doc),
          projections: [{ relPath: join("story", "creative", "concepts.md"), content: projectConceptsMarkdown(doc) }],
        },
      ],
    };
  });

  gates.set("concept-gate", async (ctx) => {
    const doc = await readJsonOutput<ConceptCandidates>(ctx, "creation.concepts");
    const violations: string[] = [];
    if (doc.candidates.length < 2) violations.push("概念孵化至少要产出 2 个可比较的方案");
    const premises = new Set(doc.candidates.map((c) => c.premise.trim()));
    if (premises.size < doc.candidates.length) violations.push("存在重复 premise —— 方案之间没有实质差异");
    if (!doc.lockedConceptId) violations.push("没有锁定方案（lockedConceptId）");
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- novel.canon ---------------------------------------------------------
  executors.set("novel.canon", async (ctx) => {
    const brief = await readJsonInput<CreativeBrief>(ctx, "creation.brief");
    const concepts = await readJsonInput<ConceptCandidates>(ctx, "creation.concepts");
    const locked = concepts.candidates.find((c) => c.id === concepts.lockedConceptId) ?? concepts.candidates[0];

    const modelResult = await tryModelJson<Partial<CanonBible>>(
      complete,
      `你是世界观与人物架构师。基于锁定方案构建 Canon。只输出 JSON：
{"storyPromise":"","themeTensions":[["自由","秩序"]],"centralQuestion":"","endingDirection":"",
"rules":[{"id":"rule_01","statement":"世界规则","hardness":"hard","exceptions":[],"cost":"代价"}],
"factions":[{"name":"","goal":""}],"locations":[{"name":"","note":""}],
"characters":[{"id":"char_01","name":"","role":"protagonist","want":"","need":"","fear":"","lie":"","secret":"","flaw":"","boundary":"","voice":"","arcStart":"","arcEnd":""}],
"conflictEngine":{"protagonistLongGoal":"","systemicObstacle":"","antagonistGoal":"","escalationMechanism":"","victoryCost":[],"failureCost":[]}}`,
      [
        `锁定方案：${locked?.premise ?? ""}`,
        `核心矛盾：${locked?.coreConflict ?? ""}`,
        `独特机制：${locked?.uniqueMechanism ?? ""}`,
        `读者承诺：${brief.readerPromise.join("；")}`,
      ].join("\n"),
    );

    const canon = CanonBibleSchema.parse({
      bookId: ctx.bookId,
      storyPromise: modelResult?.storyPromise ?? locked?.premise ?? brief.coreFantasy,
      themeTensions: modelResult?.themeTensions ?? [],
      centralQuestion: modelResult?.centralQuestion ?? "",
      endingDirection: modelResult?.endingDirection ?? "",
      rules: modelResult?.rules ?? [],
      factions: modelResult?.factions ?? [],
      locations: modelResult?.locations ?? [],
      characters: modelResult?.characters?.length
        ? modelResult.characters
        : [{ id: "char_01", name: "主角", role: "protagonist", want: locked?.protagonistGoal ?? "" }],
      conflictEngine: modelResult?.conflictEngine ?? {
        protagonistLongGoal: locked?.protagonistGoal ?? "",
        systemicObstacle: locked?.longTermObstacle ?? "",
        antagonistGoal: "",
        escalationMechanism: locked?.uniqueMechanism ?? "",
        victoryCost: [],
        failureCost: [],
      },
    });

    return {
      outputs: [
        {
          artifactId: "creation.canon",
          content: json(canon),
          projections: [
            { relPath: join("story", "bible", "canon.md"), content: projectCanonMarkdown(canon) },
          ],
        },
      ],
    };
  });

  gates.set("canon-gate", async (ctx) => {
    const canon = await readJsonOutput<CanonBible>(ctx, "creation.canon");
    const violations: string[] = [];
    if (!canon.storyPromise.trim()) violations.push("Canon 缺少 Story Promise");
    if (canon.characters.length === 0) violations.push("Canon 没有任何人物");
    if (!canon.characters.some((c) => c.role === "protagonist")) violations.push("Canon 没有标记主角（role=protagonist）");
    if (!canon.conflictEngine.protagonistLongGoal.trim() && !canon.conflictEngine.systemicObstacle.trim()) {
      violations.push("冲突引擎为空 —— 无法判断这本书能否支撑长篇");
    }
    const ruleIds = canon.rules.map((r) => r.id);
    if (new Set(ruleIds).size !== ruleIds.length) violations.push("Canon 规则 id 重复");
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- novel.spine ---------------------------------------------------------
  executors.set("novel.spine", async (ctx) => {
    const canon = await readJsonInput<CanonBible>(ctx, "creation.canon");
    const brief = await readJsonInput<CreativeBrief>(ctx, "creation.brief");
    const targetChapters = brief.targetChapters ?? 60;

    const STAGES = [
      "开场状态", "激励事件", "第一次承诺", "第一次重大反转",
      "中点转向", "重大失去", "真相揭露", "最终承诺", "高潮", "结局",
    ];

    const modelResult = await tryModelJson<{ beats?: Array<Record<string, unknown>> }>(
      complete,
      `你是故事结构师。基于 Canon 输出 8-12 个主线转折点（Major Beats），每个必须有明确状态变化与因果依赖。只输出 JSON：
{"beats":[{"stage":"阶段名","label":"一句话事件","goalBefore":"","event":"","causedBy":["前置 beat 的 stage 名"],"stateChange":["状态变化"],"characterArcImpact":[""],"newQuestion":"新悬念"}]}`,
      [
        `Story Promise：${canon.storyPromise}`,
        `中心问题：${canon.centralQuestion}`,
        `冲突引擎：${canon.conflictEngine.protagonistLongGoal} vs ${canon.conflictEngine.systemicObstacle}`,
        `结局方向：${canon.endingDirection}`,
        `目标篇幅：${targetChapters} 章`,
      ].join("\n"),
    );

    const rawBeats: Array<Record<string, unknown>> =
      Array.isArray(modelResult?.beats) && modelResult.beats.length >= 4
        ? modelResult.beats
        : STAGES.map((stage, i) => ({
            stage,
            label: `${stage}：${canon.storyPromise || "主线推进"}`,
            stateChange: [`阶段 ${i + 1} 状态推进`],
          }));

    const perBeat = Math.max(1, Math.round(targetChapters / rawBeats.length));
    const beats: MajorBeat[] = rawBeats.map((item, index) => ({
      id: `major_${String(index + 1).padStart(2, "0")}`,
      order: index,
      stage: String(item.stage ?? STAGES[index] ?? `阶段 ${index + 1}`),
      label: String(item.label ?? `节拍 ${index + 1}`),
      goalBefore: String(item.goalBefore ?? ""),
      event: String(item.event ?? ""),
      // 因果链兜底：模型没给依赖时按顺序串联，保证 Gate 能验证连贯性。
      causedBy: Array.isArray(item.causedBy) && item.causedBy.length > 0
        ? [`major_${String(index).padStart(2, "0")}`].filter(() => index > 0)
        : index > 0 ? [`major_${String(index).padStart(2, "0")}`] : [],
      stateChange: Array.isArray(item.stateChange) ? (item.stateChange as string[]).map(String) : [],
      characterArcImpact: Array.isArray(item.characterArcImpact) ? (item.characterArcImpact as string[]).map(String) : [],
      newQuestion: item.newQuestion ? String(item.newQuestion) : null,
      chapterRange: {
        from: index * perBeat + 1,
        to: Math.min(targetChapters, (index + 1) * perBeat),
      },
    }));

    const spine = OriginalSpineSchema.parse({ bookId: ctx.bookId, beats });
    return {
      outputs: [
        {
          artifactId: "creation.spine",
          content: json(spine),
          projections: [{ relPath: join("story", "plans", "story-spine.md"), content: projectSpineMarkdown(spine) }],
        },
      ],
    };
  });

  gates.set("spine-gate", async (ctx) => {
    const spine = await readJsonOutput<OriginalSpine>(ctx, "creation.spine");
    const violations: string[] = [];
    if (spine.beats.length < 4) violations.push("主线骨架少于 4 个转折点 —— 不足以支撑长篇");
    const ids = new Set(spine.beats.map((b) => b.id));
    for (const beat of spine.beats) {
      if (beat.order > 0 && beat.causedBy.length === 0) {
        violations.push(`节拍 ${beat.id}「${beat.label}」没有因果前置 —— 会变成"发生了很多事但主线没动"`);
      }
      for (const dep of beat.causedBy) {
        if (!ids.has(dep)) violations.push(`节拍 ${beat.id} 依赖了不存在的前置 ${dep}`);
      }
      if (beat.stateChange.length === 0) {
        violations.push(`节拍 ${beat.id}「${beat.label}」没有状态变化 —— 无效节拍`);
      }
    }
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- novel.arc-plan ------------------------------------------------------
  executors.set("novel.arc-plan", async (ctx) => {
    const spine = await readJsonInput<OriginalSpine>(ctx, "creation.spine");
    const brief = await readJsonInput<CreativeBrief>(ctx, "creation.brief");
    const arcCount = Math.max(1, Math.min(6, Math.ceil(spine.beats.length / 3)));
    const per = Math.ceil(spine.beats.length / arcCount);

    const arcs = Array.from({ length: arcCount }, (_, index) => {
      const slice = spine.beats.slice(index * per, (index + 1) * per);
      if (slice.length === 0) return null;
      return {
        id: `arc_${String(index + 1).padStart(2, "0")}`,
        index: index + 1,
        title: `第${index + 1}卷 · ${slice[0].stage}`,
        promise: slice[0].label,
        entryState: index === 0 ? [] : spine.beats[index * per - 1]?.stateChange ?? [],
        coreConflict: slice.find((b) => b.event)?.event ?? slice[0].label,
        midTurn: slice[Math.floor(slice.length / 2)]?.label ?? "",
        climax: slice[slice.length - 1]?.label ?? "",
        exitState: slice[slice.length - 1]?.stateChange ?? [],
        beatIds: slice.map((b) => b.id),
        chapterRange: slice[0].chapterRange && slice[slice.length - 1].chapterRange
          ? { from: slice[0].chapterRange!.from, to: slice[slice.length - 1].chapterRange!.to }
          : null,
      };
    }).filter((a): a is NonNullable<typeof a> => a !== null);

    const plan = ArcPlanSchema.parse({ bookId: ctx.bookId, arcs });
    ctx.emit("workflow.node.progress", { message: `卷纲 ${arcs.length} 卷 / 目标 ${brief.targetChapters ?? "?"} 章` });
    return {
      outputs: [
        {
          artifactId: "creation.arcs",
          content: json(plan),
          projections: [{ relPath: join("story", "plans", "arcs.md"), content: projectArcsMarkdown(plan) }],
        },
      ],
    };
  });

  // ---- novel.chapter-contracts --------------------------------------------
  executors.set("novel.chapter-contracts", async (ctx) => {
    const plan = await readJsonInput<ArcPlan>(ctx, "creation.arcs");
    const spine = await readJsonInput<OriginalSpine>(ctx, "creation.spine");
    const canon = await readJsonInput<CanonBible>(ctx, "creation.canon");
    const chapters = Math.max(1, Number(ctx.params.chapters ?? 3));
    const beatById = new Map(spine.beats.map((b) => [b.id, b]));
    const protagonist = canon.characters.find((c) => c.role === "protagonist")?.name ?? null;

    const firstArc = plan.arcs[0];
    const beatsForChapters = (firstArc?.beatIds ?? spine.beats.map((b) => b.id))
      .map((id) => beatById.get(id))
      .filter((b): b is MajorBeat => Boolean(b));

    const perChapter = Math.max(1, Math.ceil(beatsForChapters.length / chapters));
    const contracts: OriginalChapterContract[] = [];
    for (let chapter = 1; chapter <= chapters; chapter++) {
      const slice = beatsForChapters.slice((chapter - 1) * perChapter, chapter * perChapter);
      const beats = slice.length > 0 ? slice : [beatsForChapters[beatsForChapters.length - 1]].filter(Boolean);
      if (beats.length === 0) break;
      contracts.push(
        OriginalChapterContractSchema.parse({
          chapter,
          arcId: firstArc?.id ?? "",
          purpose: ["mainline_escalation"],
          beatIds: beats.map((b) => b.id),
          pov: protagonist,
          chapterGoal: beats[0].label,
          conflict: beats[0].goalBefore || beats[0].event || beats[0].label,
          turn: beats[beats.length - 1]?.newQuestion ?? beats[beats.length - 1]?.label ?? null,
          exitState: beats.flatMap((b) => b.stateChange).slice(0, 4).length
            ? beats.flatMap((b) => b.stateChange).slice(0, 4)
            : [`完成节拍 ${beats.map((b) => b.id).join("/")}`],
          setupHooks: [],
          payoffHooks: [],
          mustUse: [],
          // Canon 硬规则直接进 mustNot：Writer 不得无痕打破世界规则。
          mustNot: canon.rules.filter((r) => r.hardness === "hard").slice(0, 4).map((r) => `不得违反：${r.statement}`),
          targetWords: 3000,
          endHook: beats[beats.length - 1]?.newQuestion ?? null,
        }),
      );
    }
    return { outputs: [{ artifactId: "creation.chapter-contracts", content: json(contracts) }] };
  });

  gates.set("chapter-plan-gate", async (ctx) => {
    const contracts = await readJsonOutput<OriginalChapterContract[]>(ctx, "creation.chapter-contracts");
    const violations: string[] = [];
    if (contracts.length === 0) violations.push("没有生成任何章级契约");
    for (const contract of contracts) {
      if (contract.purpose.length === 0) violations.push(`第${contract.chapter}章缺少 purpose`);
      if (contract.exitState.length === 0) violations.push(`第${contract.chapter}章没有 exitState —— 无功能章节`);
      if (!contract.conflict.trim()) violations.push(`第${contract.chapter}章没有冲突`);
      if (contract.beatIds.length === 0) violations.push(`第${contract.chapter}章没有挂任何主线节拍`);
    }
    return { pass: violations.length === 0, hardViolations: violations };
  });

  // ---- novel.draft-chapters ------------------------------------------------
  executors.set("novel.draft-chapters", async (ctx) => {
    const contracts = await readJsonInput<OriginalChapterContract[]>(ctx, "creation.chapter-contracts");
    const canon = await readJsonInput<CanonBible>(ctx, "creation.canon");
    const drafts: Array<{ chapter: number; title: string; content: string }> = [];

    for (const contract of contracts) {
      let content: string | null = null;
      if (complete) {
        try {
          content = await complete([
            {
              role: "system",
              content: `你是网文写手。严格按章级契约写完整章节正文。铁律：
1. 契约 mustNot 列出的内容绝对禁止出现；
2. 章末必须落在 exitState 描述的状态上；
3. 人物行为必须符合 Canon 的 want/fear/boundary；
4. 直接输出正文，不要解释。`,
            },
            {
              role: "user",
              content: [
                `# 第${contract.chapter}章契约`,
                `目标：${contract.chapterGoal}`,
                `冲突：${contract.conflict}`,
                contract.turn ? `转折：${contract.turn}` : "",
                `退出状态：${contract.exitState.join("；")}`,
                contract.mustNot.length ? `禁止：${contract.mustNot.join("；")}` : "",
                contract.endHook ? `章末钩子：${contract.endHook}` : "",
                `目标字数：约 ${contract.targetWords} 字`,
                "",
                "# Canon 人物",
                ...canon.characters.slice(0, 6).map((c) => `- ${c.name}（${c.role}）想要：${c.want}｜害怕：${c.fear}｜不会做：${c.boundary}`),
              ].filter(Boolean).join("\n"),
            },
          ]);
        } catch {
          content = null;
        }
      }
      drafts.push({
        chapter: contract.chapter,
        title: contract.chapterGoal.slice(0, 20),
        content: content?.trim() || deterministicDraft(contract, canon),
      });
      ctx.emit("workflow.node.progress", { completed: drafts.length, total: contracts.length, message: `正文 ${drafts.length}/${contracts.length}` });
    }
    return { outputs: [{ artifactId: "creation.drafts", content: json(drafts) }] };
  });

  // ---- novel.audit ---------------------------------------------------------
  executors.set("novel.audit", async (ctx) => {
    const drafts = await readJsonInput<Array<{ chapter: number; content: string }>>(ctx, "creation.drafts");
    const contracts = await readJsonInput<OriginalChapterContract[]>(ctx, "creation.chapter-contracts");
    const canon = await readJsonInput<CanonBible>(ctx, "creation.canon");
    const contractByChapter = new Map(contracts.map((c) => [c.chapter, c]));

    const chapters = drafts.map((draft) => {
      const contract = contractByChapter.get(draft.chapter);
      const issues: ChapterAuditReport["chapters"][number]["issues"] = [];
      const text = draft.content ?? "";

      if (text.trim().length < 50) {
        issues.push({ severity: "blocking", category: "canon", description: `第${draft.chapter}章正文为空或过短`, suggestion: "重跑正文节点" });
      }
      // Canon 硬约束：mustNot 命中即 blocking（可程序判定的部分）。
      for (const forbidden of contract?.mustNot ?? []) {
        const keyword = forbidden.replace(/^不得违反：/, "").slice(0, 12);
        if (keyword && text.includes(keyword)) {
          issues.push({ severity: "blocking", category: "canon", description: `第${draft.chapter}章疑似违反硬规则：${forbidden}`, suggestion: "修订该段或申请修改 Canon" });
        }
      }
      // 字数偏离：只提示，不阻断。
      const target = contract?.targetWords ?? 3000;
      const ratio = text.length / target;
      if (ratio < 0.5) {
        issues.push({ severity: "warning", category: "pacing", description: `第${draft.chapter}章字数 ${text.length}，不足目标 ${target} 的一半`, suggestion: "补充承重段落" });
      }
      const povName = contract?.pov;
      if (povName && !text.includes(povName)) {
        issues.push({ severity: "warning", category: "character", description: `第${draft.chapter}章正文未出现 POV 人物「${povName}」`, suggestion: "确认视角是否漂移" });
      }
      const scores: Record<string, number> = {
        canonConsistency: issues.some((i) => i.category === "canon" && i.severity === "blocking") ? 40 : 92,
        pacing: ratio < 0.5 ? 60 : 82,
        characterMotivation: povName && !text.includes(povName) ? 65 : 85,
      };
      return { chapter: draft.chapter, issues, scores };
    });

    // 有模型时叠加一轮语义审计（模型只能加 warning/info，不能推翻硬约束）。
    if (complete && chapters.length > 0) {
      const semantic = await tryModelJson<{ issues?: Array<Record<string, unknown>> }>(
        complete,
        `你是章节审计员。检查正文是否存在：人物动机断裂、因果突兀、重复信息、解释性对白过多。
只输出 JSON：{"issues":[{"chapter":1,"category":"causality|character|pacing|style|foreshadow","description":"","suggestion":""}]}`,
        drafts.map((d) => `## 第${d.chapter}章\n${(d.content ?? "").slice(0, 1200)}`).join("\n\n"),
      );
      for (const raw of semantic?.issues ?? []) {
        const chapter = Number(raw.chapter);
        const target = chapters.find((c) => c.chapter === chapter);
        if (!target) continue;
        const category = String(raw.category ?? "pacing");
        target.issues.push({
          severity: "warning",
          category: (["canon", "causality", "character", "pacing", "style", "foreshadow"].includes(category)
            ? category
            : "pacing") as ChapterAuditReport["chapters"][number]["issues"][number]["category"],
          description: String(raw.description ?? "").slice(0, 300) || "（模型未给出描述）",
          suggestion: String(raw.suggestion ?? ""),
        });
      }
    }

    const report = ChapterAuditReportSchema.parse({
      bookId: ctx.bookId,
      generatedAt: new Date().toISOString(),
      chapters,
    });
    void canon;
    return { outputs: [{ artifactId: "creation.audit-report", content: json(report) }] };
  });

  gates.set("chapter-audit-gate", async (ctx) => {
    const report = await readJsonOutput<ChapterAuditReport>(ctx, "creation.audit-report");
    const blocking = report.chapters.flatMap((c) => c.issues.filter((i) => i.severity === "blocking").map((i) => `第${c.chapter}章 [${i.category}] ${i.description}`));
    return { pass: blocking.length === 0, hardViolations: blocking };
  });

  // ---- novel.state-settle --------------------------------------------------
  executors.set("novel.state-settle", async (ctx) => {
    const drafts = await readJsonInput<Array<{ chapter: number; content: string }>>(ctx, "creation.drafts");
    const contracts = await readJsonInput<OriginalChapterContract[]>(ctx, "creation.chapter-contracts");
    const through = drafts.reduce((max, d) => Math.max(max, d.chapter), 0);
    const settled = contracts.filter((c) => c.chapter <= through);

    const snapshot = StateSnapshotSchema.parse({
      bookId: ctx.bookId,
      throughChapter: through,
      characterStates: [],
      // 只把契约里"本章确实要发生"的退出状态结算回 Canon State。
      worldState: settled.flatMap((c) => c.exitState),
      openQuestions: settled.map((c) => c.endHook).filter((h): h is string => Boolean(h)),
      hookLedger: settled.flatMap((c) => c.setupHooks.map((id) => ({ id, status: "open" as const, note: `第${c.chapter}章埋设` }))),
      updatedAt: new Date().toISOString(),
    });
    return {
      outputs: [
        {
          artifactId: "creation.state",
          content: json(snapshot),
          projections: [{ relPath: join("story", "state", "current.md"), content: projectStateMarkdown(snapshot) }],
        },
      ],
    };
  });

  return { executors, gates };
}

function clamp10(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : fallback;
}

function deterministicDraft(contract: OriginalChapterContract, canon: CanonBible): string {
  const protagonist = canon.characters.find((c) => c.role === "protagonist")?.name ?? "主角";
  return [
    `# 第${contract.chapter}章（结构草稿）`,
    "",
    `> 本章目标：${contract.chapterGoal}`,
    `> 冲突：${contract.conflict}`,
    contract.turn ? `> 转折：${contract.turn}` : "",
    "",
    `${protagonist}面对的处境由上一章的状态推进而来。${contract.conflict}`,
    "",
    ...contract.exitState.map((state) => `本章结束时：${state}。`),
    "",
    contract.endHook ? `章末钩子：${contract.endHook}` : "",
    "",
    "（deterministic 结构草稿——配置模型后由 LLM Writer 生成成稿正文）",
  ].filter(Boolean).join("\n");
}

// ---------- Markdown projections ----------

function projectBriefMarkdown(brief: CreativeBrief): string {
  return [
    "# 创作简报",
    "",
    `- 题材：${brief.genre.join("、") || "（未指定）"}`,
    `- 目标读者：${brief.targetAudience || "（未指定）"}`,
    `- 篇幅：${brief.targetChapters ?? "?"} 章 · 单章约 ${brief.chapterWordTarget} 字`,
    `- 视角：${brief.pov}`,
    "",
    "## 核心爽点",
    brief.coreFantasy || "（待补）",
    "",
    "## 读者承诺",
    ...(brief.readerPromise.length ? brief.readerPromise.map((p) => `- ${p}`) : ["（待补）"]),
    ...(brief.mustAvoid.length ? ["", "## 必须避免", ...brief.mustAvoid.map((p) => `- ${p}`)] : []),
    ...(brief.assumptions.length ? ["", "## 假设（需人工确认）", ...brief.assumptions.map((p) => `- ${p}`)] : []),
    "",
  ].join("\n");
}

function projectConceptsMarkdown(doc: ConceptCandidates): string {
  const lines = ["# 故事方案候选", ""];
  for (const c of doc.candidates) {
    lines.push(
      `## ${c.id}${doc.lockedConceptId === c.id ? "（已锁定）" : ""} · ${c.totalScore.toFixed(1)}/10`,
      "",
      `- Premise：${c.premise}`,
      `- 核心矛盾：${c.coreConflict || "（待补）"}`,
      `- 独特机制：${c.uniqueMechanism || "（待补）"}`,
      ...(c.risks.length ? [`- 风险：${c.risks.join("；")}`] : []),
      "",
    );
  }
  return lines.join("\n");
}

function projectCanonMarkdown(canon: CanonBible): string {
  const lines = [
    "# Canon Bible",
    "",
    `Story Promise：${canon.storyPromise || "（待补）"}`,
    canon.centralQuestion ? `中心问题：${canon.centralQuestion}` : "",
    "",
    "## 世界规则",
  ];
  lines.push(...(canon.rules.length ? canon.rules.map((r) => `- [${r.hardness}] ${r.statement}${r.cost ? `（代价：${r.cost}）` : ""}`) : ["（待补）"]));
  lines.push("", "## 人物");
  lines.push(...(canon.characters.length
    ? canon.characters.map((c) => `- ${c.name}（${c.role}）想要：${c.want || "?"}｜害怕：${c.fear || "?"}｜边界：${c.boundary || "?"}`)
    : ["（待补）"]));
  lines.push("", "## 冲突引擎", `- 主角长期目标：${canon.conflictEngine.protagonistLongGoal || "（待补）"}`, `- 系统性阻力：${canon.conflictEngine.systemicObstacle || "（待补）"}`, "");
  return lines.filter(Boolean).join("\n");
}

function projectSpineMarkdown(spine: OriginalSpine): string {
  const lines = ["# 主线骨架", ""];
  for (const beat of spine.beats) {
    lines.push(
      `${beat.order + 1}. **${beat.stage}** — ${beat.label}` +
        (beat.chapterRange ? `（第 ${beat.chapterRange.from}-${beat.chapterRange.to} 章）` : ""),
      ...(beat.stateChange.length ? [`   - 状态变化：${beat.stateChange.join("、")}`] : []),
      ...(beat.newQuestion ? [`   - 新悬念：${beat.newQuestion}`] : []),
    );
  }
  return `${lines.join("\n")}\n`;
}

function projectArcsMarkdown(plan: ArcPlan): string {
  const lines = ["# 卷纲", ""];
  for (const arc of plan.arcs) {
    lines.push(
      `## ${arc.title}${arc.chapterRange ? `（第 ${arc.chapterRange.from}-${arc.chapterRange.to} 章）` : ""}`,
      "",
      `- 本卷 Promise：${arc.promise}`,
      `- 核心冲突：${arc.coreConflict}`,
      `- 中段转折：${arc.midTurn || "（待补）"}`,
      `- 卷高潮：${arc.climax || "（待补）"}`,
      ...(arc.exitState.length ? [`- 退出状态：${arc.exitState.join("、")}`] : []),
      "",
    );
  }
  return lines.join("\n");
}

function projectStateMarkdown(snapshot: import("./schemas.js").StateSnapshot): string {
  return [
    "# 当前状态",
    "",
    `已结算至第 ${snapshot.throughChapter} 章 · ${snapshot.updatedAt}`,
    "",
    "## 世界状态",
    ...(snapshot.worldState.length ? snapshot.worldState.map((s) => `- ${s}`) : ["（暂无）"]),
    "",
    "## 未解决问题",
    ...(snapshot.openQuestions.length ? snapshot.openQuestions.map((q) => `- ${q}`) : ["（暂无）"]),
    "",
  ].join("\n");
}
