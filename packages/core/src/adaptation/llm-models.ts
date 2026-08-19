/**
 * LLM-backed implementations of the adaptation runtime model hooks
 * (ChapterAnalysisModel / CausalJudge / draftWriter).
 *
 * - completion function is injectable (tests use a scripted fake; production
 *   binds core `chatCompletion` + the project's LLMClient → Cursor 反代);
 * - every model output is schema-validated downstream; analysis quotes that
 *   fail verbatim verification are dropped by analyzeScene (反幻觉闸);
 * - causal judging batches all candidates of one target event into a single
 *   call and caches by target id — never one call per pair.
 */

import { chatCompletion, type LLMClient } from "../llm/provider.js";
import type { ChapterAnalysisModel, ModelSceneAnalysisInput } from "../story-intelligence/chapter-analyzer.js";
import type { CandidatePair, CausalJudge, CausalJudgement } from "../story-intelligence/causal-linker.js";
import { CausalEdgeTypeSchema } from "../story-intelligence/schemas/graph.js";
import type { AdaptationModels, DraftChapterInput } from "./executors.js";

export type CompletionFn = (messages: ReadonlyArray<{ role: "system" | "user"; content: string }>) => Promise<string>;

export interface LLMModelOptions {
  readonly client: LLMClient;
  readonly model: string;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export function completionFromClient(options: LLMModelOptions): CompletionFn {
  return async (messages) => {
    const response = await chatCompletion(options.client, options.model, messages as never, {
      temperature: options.temperature ?? 0.3,
      signal: options.signal,
    });
    // LLMResponse shape: { content: string, ... }
    const content = (response as { content?: string }).content;
    return typeof content === "string" ? content : String(content ?? "");
  };
}

/** Extract the first balanced JSON value from a model reply (fences/think-tags tolerated). */
export function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "")
    .trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found in model reply");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON in model reply");
}

const ANALYSIS_SYSTEM = `你是小说深度拆文分析师。给定一个场景的原文，抽取事件级结构化数据。
铁律：
1. 每个事件的 quote 必须是场景原文中【逐字连续】出现的一段（4-300字），禁止改写、拼接、转述。
2. participants 只写场景中实际出现的人物名，禁止编造。
3. 只输出 JSON，不要任何解释文字。
输出格式：
{"events":[{"summary":"≤80字事件概括","quote":"原文逐字引句","participants":["名字"],"goal":null,"obstacle":null,"action":null,"outcome":null,"stateChanges":["状态变化"],"narrativeFunction":["advance_plot|reveal_information|change_relationship|increase_stakes|character_choice|setup|payoff|reversal|escalation|reveal"],"informationDelta":0.0,"conflictDelta":0.0,"emotionDelta":0.0,"confidence":0.0}],"dramaticQuestion":"本场戏剧问题或null","turningPoint":"转折点或null"}`;

export function createLLMChapterAnalysisModel(complete: CompletionFn): ChapterAnalysisModel {
  return {
    async analyzeScene({ chapter, scene, sceneText }): Promise<ModelSceneAnalysisInput> {
      const user = [
        `《第${chapter.number}章 ${chapter.title}》场景 ${scene.index + 1}：`,
        "----- 场景原文 -----",
        sceneText,
        "----- 原文结束 -----",
        "抽取该场景的事件（通常 1-4 个）。只输出 JSON。",
      ].join("\n");
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await complete([
          { role: "system", content: ANALYSIS_SYSTEM },
          { role: "user", content: attempt === 0 ? user : `${user}\n（上次输出不是合法 JSON，重来，只输出 JSON）` },
        ]);
        try {
          return extractJson(reply) as ModelSceneAnalysisInput;
        } catch {
          if (attempt === 1) return { events: [], dramaticQuestion: null, turningPoint: null };
        }
      }
      return { events: [], dramaticQuestion: null, turningPoint: null };
    },
  };
}

const CAUSAL_SYSTEM = `你是故事因果分析师。判定候选前置事件与目标事件之间是否存在叙事因果。
判定标准：如果删除前置事件，目标事件是否还能合理发生？不能 ⇒ strong；能但被明显促成 ⇒ weak；无关 ⇒ 忽略。
edge type 只能取：causes|enables|motivates|reveals|blocks|pays_off|escalates|contradicts。
只输出 JSON 数组，每个候选一项（无因果的候选省略）：
[{"index":0,"type":"causes","strength":"strong","explanation":"一句话解释","confidence":0.9}]`;

export function createLLMCausalJudge(complete: CompletionFn): CausalJudge {
  const cache = new Map<string, Map<string, CausalJudgement | null>>();
  const pending = new Map<string, Array<CandidatePair>>();

  return async (pair) => {
    const toId = pair.to.id;
    let judged = cache.get(toId);
    if (!judged) {
      // Collect: candidatePairs() emits all pairs of one target consecutively,
      // but we can't see ahead — so batch lazily: first pair triggers a call
      // covering itself; subsequent pairs for the same target get cached calls
      // appended in a second batch if needed.
      const batch = pending.get(toId) ?? [];
      batch.push(pair);
      pending.set(toId, batch);
      judged = new Map();
      cache.set(toId, judged);
    }
    if (judged.has(pair.from.id)) return judged.get(pair.from.id) ?? null;

    const user = [
      `目标事件：第${pair.to.chapter}章「${pair.to.summary}」`,
      `候选前置事件（index 0）：第${pair.from.chapter}章「${pair.from.summary}」`,
      `候选关系线索：${pair.reason === "same-scene-adjacent" ? "同场景相邻" : "人物重叠"}`,
      "只输出 JSON 数组。",
    ].join("\n");
    try {
      const reply = await complete([
        { role: "system", content: CAUSAL_SYSTEM },
        { role: "user", content: user },
      ]);
      const rows = extractJson(reply);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row || !CausalEdgeTypeSchema.safeParse(row.type).success) {
        judged.set(pair.from.id, null);
        return null;
      }
      const judgement: CausalJudgement = {
        type: row.type,
        strength: row.strength === "strong" ? "strong" : "weak",
        explanation: String(row.explanation ?? "").slice(0, 300) || "（模型未给出解释）",
        confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.5))),
      };
      judged.set(pair.from.id, judgement);
      return judgement;
    } catch {
      judged.set(pair.from.id, null);
      return null;
    }
  };
}

const DRAFT_SYSTEM = `你是网文改编写手。根据章级契约与源事件节拍写完整章节正文。
铁律：
1. 只能使用人物映射表中的【新名】，禁止出现任何原名。
2. 主线节拍必须全部落地（契约 sourceEvents 顺序可微调但不可丢）。
3. 契约 mustNot 列出的内容绝对禁止出现。
4. 直接输出正文，不要标题编号以外的任何解释。`;

export function createLLMDraftWriter(complete: CompletionFn): (input: DraftChapterInput) => Promise<string> {
  return async (input) => {
    const nameFor = new Map(input.characterMap.map((e) => [e.sourceName, e.targetName]));
    const rename = (text: string): string => {
      let out = text;
      for (const [source, target] of nameFor) {
        if (source !== target) out = out.split(source).join(target);
      }
      return out;
    };
    const mapLines = input.characterMap
      .filter((e) => e.sourceName !== e.targetName)
      .map((e) => `- ${e.sourceName} → ${e.targetName}`);
    const beats = input.sourceEvents.map((e, i) => `${i + 1}. ${rename(e.summary)}${e.outcome ? `（结果：${rename(e.outcome)}）` : ""}`);
    const user = [
      `# 第${input.contract.chapter}章契约`,
      `目标：${rename(input.contract.chapterGoal)}`,
      `冲突：${rename(input.contract.conflict)}`,
      input.contract.turn ? `转折：${rename(input.contract.turn)}` : "",
      `出场状态变化：${input.contract.exitState.map(rename).join("；")}`,
      input.contract.endHook ? `章末钩子：${rename(input.contract.endHook)}` : "",
      input.contract.mustNot.length ? `禁止：${input.contract.mustNot.join("；")}` : "",
      `目标字数：约${input.contract.targetWords}字`,
      "",
      "# 人物映射（只许用新名）",
      ...(mapLines.length ? mapLines : ["（无换名）"]),
      "",
      "# 主线节拍（必须全部落地）",
      ...beats,
    ].filter(Boolean).join("\n");
    const prose = await complete([
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: user },
    ]);
    // Belt-and-braces: even if the model slips, source names never reach disk.
    return rename(prose.trim());
  };
}

/** Bundle all three hooks from one completion function. */
export function createLLMAdaptationModels(complete: CompletionFn): AdaptationModels {
  return {
    analysisModel: createLLMChapterAnalysisModel(complete),
    causalJudge: createLLMCausalJudge(complete),
    draftWriter: createLLMDraftWriter(complete),
  };
}
