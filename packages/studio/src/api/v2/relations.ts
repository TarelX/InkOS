/**
 * 人物羁绊提取：从逐章拆解记录（V1 导入或 V2 拆文）构建人物对证据，
 * 交给 LLM 分类出有语义的关系（盟友/敌对/师徒/亲属/恋慕/对手/从属/交易），
 * 产物落为 `analysis.character-relations`。没有 LLM 时退化为同场统计（诚实标注）。
 */
import type { CompletionFn } from "@actalk/inkos-core/v2";

export interface ChapterRecordLike {
  readonly chapterNumber: number;
  readonly title: string;
  readonly characters: ReadonlyArray<{ readonly name: string; readonly count?: number }>;
  readonly plot: string;
}

export interface RelationEvidencePair {
  readonly a: string;
  readonly b: string;
  readonly coChapters: number;
  readonly excerpts: ReadonlyArray<{ readonly chapter: number; readonly title: string; readonly plot: string }>;
}

export interface CharacterRelation {
  readonly a: string;
  readonly b: string;
  /** 盟友|敌对|师徒|亲属|恋慕|对手|从属|交易|其他|同场 */
  readonly type: string;
  /** ≤12 字关系短语，如 "宿敌，多次交手" */
  readonly label: string;
  /** ≤40 字判定依据 */
  readonly note: string;
  readonly chapters: ReadonlyArray<number>;
  readonly coChapters: number;
}

export const RELATION_TYPES = ["盟友", "敌对", "师徒", "亲属", "恋慕", "对手", "从属", "交易", "其他"] as const;

/** 从逐章记录构建人物对证据：top 人物两两配对，按共现强度取前 maxPairs 对。 */
export function buildRelationEvidence(
  records: ReadonlyArray<ChapterRecordLike>,
  options?: { topCharacters?: number; maxPairs?: number; excerptsPerPair?: number; excerptChars?: number },
): RelationEvidencePair[] {
  const topCharacters = options?.topCharacters ?? 12;
  const maxPairs = options?.maxPairs ?? 24;
  const excerptsPerPair = options?.excerptsPerPair ?? 3;
  const excerptChars = options?.excerptChars ?? 220;

  const appearance = new Map<string, number>();
  for (const record of records) {
    for (const person of new Set(record.characters.map((c) => c.name))) {
      appearance.set(person, (appearance.get(person) ?? 0) + 1);
    }
  }
  const top = new Set(
    [...appearance.entries()].sort((x, y) => y[1] - x[1]).slice(0, topCharacters).map(([name]) => name),
  );

  const pairChapters = new Map<string, number[]>();
  for (const record of records) {
    const people = [...new Set(record.characters.map((c) => c.name))].filter((name) => top.has(name));
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const key = [people[i]!, people[j]!].sort().join("\u0000");
        const list = pairChapters.get(key) ?? [];
        list.push(record.chapterNumber);
        pairChapters.set(key, list);
      }
    }
  }

  const byChapter = new Map(records.map((record) => [record.chapterNumber, record]));
  return [...pairChapters.entries()]
    .sort((x, y) => y[1].length - x[1].length)
    .slice(0, maxPairs)
    .map(([key, chapters]) => {
      const [a, b] = key.split("\u0000") as [string, string];
      // 取首、中、尾各一章的剧情节选：覆盖关系的建立与演变
      const picks = chapters.length <= excerptsPerPair
        ? chapters
        : [chapters[0]!, chapters[Math.floor(chapters.length / 2)]!, chapters[chapters.length - 1]!];
      const excerpts = picks.map((chapter) => {
        const record = byChapter.get(chapter);
        return {
          chapter,
          title: record?.title ?? "",
          plot: (record?.plot ?? "").slice(0, excerptChars),
        };
      });
      return { a, b, coChapters: chapters.length, excerpts };
    });
}

/** 无 LLM 的诚实退化：只有同场统计，不编造关系语义。 */
export function deterministicRelations(pairs: ReadonlyArray<RelationEvidencePair>): CharacterRelation[] {
  return pairs.map((pair) => ({
    a: pair.a,
    b: pair.b,
    type: "同场",
    label: `同场 ${pair.coChapters} 章`,
    note: "未接入 LLM，仅共现统计",
    chapters: pair.excerpts.map((e) => e.chapter),
    coChapters: pair.coChapters,
  }));
}

function extractJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM 响应中没有 JSON 对象");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** LLM 关系分类：一次调用批量判定全部人物对。 */
export async function extractCharacterRelations(args: {
  complete: CompletionFn;
  pairs: ReadonlyArray<RelationEvidencePair>;
}): Promise<CharacterRelation[]> {
  const evidence = args.pairs.map((pair, index) => {
    const lines = pair.excerpts.map((e) => `  第${e.chapter}章《${e.title}》：${e.plot}`);
    return `${index + 1}. ${pair.a} × ${pair.b}（同场 ${pair.coChapters} 章）\n${lines.join("\n")}`;
  }).join("\n\n");

  const system = [
    "你是小说人物关系分析师。根据逐章剧情证据，判定每对人物之间的关系（羁绊）。",
    `type 只能取：${RELATION_TYPES.join("、")}。`,
    "label 是 ≤12 字的关系短语（例：宿敌，多次交手 / 结拜兄弟 / 收服的部下）。",
    "note 是 ≤40 字的判定依据。证据不足以判断语义时 type 用「其他」，不许编造。",
    "严格输出 JSON，不要任何其他文字：",
    `{"relations":[{"a":"甲","b":"乙","type":"敌对","label":"...","note":"..."}]}`,
    "relations 数组必须覆盖给出的每一对人物，a/b 名字原样保留。",
  ].join("\n");

  const raw = await args.complete([
    { role: "system", content: system },
    { role: "user", content: `人物对与证据：\n\n${evidence}` },
  ]);
  const parsed = extractJsonBlock(raw) as { relations?: unknown[] } | null;
  const items = Array.isArray(parsed?.relations) ? parsed.relations : [];
  const byKey = new Map<string, { type: string; label: string; note: string }>();
  for (const raw of items) {
    const item = raw as { a?: unknown; b?: unknown; type?: unknown; label?: unknown; note?: unknown } | null;
    if (!item || typeof item.a !== "string" || typeof item.b !== "string") continue;
    const type = typeof item.type === "string" && (RELATION_TYPES as ReadonlyArray<string>).includes(item.type) ? item.type : "其他";
    byKey.set([item.a, item.b].sort().join("\u0000"), {
      type,
      label: typeof item.label === "string" ? item.label.slice(0, 24) : type,
      note: typeof item.note === "string" ? item.note.slice(0, 80) : "",
    });
  }
  if (byKey.size === 0) throw new Error("LLM 未返回任何有效关系");

  return args.pairs.map((pair) => {
    const hit = byKey.get([pair.a, pair.b].sort().join("\u0000"));
    return {
      a: pair.a,
      b: pair.b,
      type: hit?.type ?? "其他",
      label: hit?.label ?? (hit?.type ?? "其他"),
      note: hit?.note ?? "",
      chapters: pair.excerpts.map((e) => e.chapter),
      coChapters: pair.coChapters,
    };
  });
}
