/**
 * 原创小说创作管线契约（V2.2 纵切）。
 *
 * 与改编管线对称：先把「这本书为什么成立」结构化成 Canon，再让每一章都从
 * 契约出发。所有产物走同一套版本化 Artifact + Gate + Approval 机制。
 */

import { z } from "zod";

// ---------- 第一阶段：创作简报 ----------

export const CreativeBriefSchema = z.object({
  schemaVersion: z.literal(1),
  bookId: z.string().min(1),
  projectType: z.literal("original_novel").default("original_novel"),
  genre: z.array(z.string()).default([]),
  targetAudience: z.string().default(""),
  targetChapters: z.number().int().positive().nullable().default(null),
  chapterWordTarget: z.number().int().positive().default(3000),
  platformStyle: z.string().default("web_serial"),
  /** 核心爽点/情感承诺：后续 Arc Review 持续拿它校验有没有写偏。 */
  coreFantasy: z.string().default(""),
  readerPromise: z.array(z.string()).default([]),
  tone: z.array(z.string()).default([]),
  mustHave: z.array(z.string()).default([]),
  mustAvoid: z.array(z.string()).default([]),
  pov: z.string().default("third_limited"),
  /** 信息不足时允许假设，但必须显式标注，供人工复核。 */
  assumptions: z.array(z.string()).default([]),
});
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;

// ---------- 第二阶段：概念孵化 ----------

export const ConceptScoreSchema = z.object({
  hookStrength: z.number().min(0).max(10),
  conflictSustainability: z.number().min(0).max(10),
  characterAgency: z.number().min(0).max(10),
  worldExpandability: z.number().min(0).max(10),
  serialPotential: z.number().min(0).max(10),
  emotionalDepth: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
});
export type ConceptScore = z.infer<typeof ConceptScoreSchema>;

export const StoryConceptSchema = z.object({
  id: z.string().min(1),
  premise: z.string().min(1),
  coreConflict: z.string().default(""),
  protagonistGoal: z.string().default(""),
  longTermObstacle: z.string().default(""),
  uniqueMechanism: z.string().default(""),
  emotionalCore: z.string().default(""),
  commercialHook: z.string().default(""),
  risks: z.array(z.string()).default([]),
  scores: ConceptScoreSchema,
  /** 综合分只用于排序展示，不作为客观真值（ADR-006）。 */
  totalScore: z.number().min(0).max(10),
});
export type StoryConcept = z.infer<typeof StoryConceptSchema>;

export const ConceptCandidatesSchema = z.object({
  bookId: z.string().min(1),
  candidates: z.array(StoryConceptSchema).min(1),
  /** 人工锁定的方案 id；未锁定时取最高分。 */
  lockedConceptId: z.string().nullable().default(null),
});
export type ConceptCandidates = z.infer<typeof ConceptCandidatesSchema>;

// ---------- 第三阶段：Canon Bible ----------

export const CanonRuleSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  /** hard = 绝对不可打破；soft = 可有代价地例外。 */
  hardness: z.enum(["hard", "soft"]).default("hard"),
  exceptions: z.array(z.string()).default([]),
  cost: z.string().default(""),
});
export type CanonRule = z.infer<typeof CanonRuleSchema>;

export const CanonCharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["protagonist", "antagonist", "ally", "foil", "supporting"]).default("supporting"),
  want: z.string().default(""),
  need: z.string().default(""),
  fear: z.string().default(""),
  lie: z.string().default(""),
  secret: z.string().default(""),
  flaw: z.string().default(""),
  /** 不会做什么——写作时的硬边界，防止人物为剧情降智。 */
  boundary: z.string().default(""),
  voice: z.string().default(""),
  arcStart: z.string().default(""),
  arcEnd: z.string().default(""),
});
export type CanonCharacter = z.infer<typeof CanonCharacterSchema>;

export const ConflictEngineSchema = z.object({
  protagonistLongGoal: z.string().default(""),
  systemicObstacle: z.string().default(""),
  antagonistGoal: z.string().default(""),
  escalationMechanism: z.string().default(""),
  /** 每次胜利带来的新问题——长篇可持续的关键。 */
  victoryCost: z.array(z.string()).default([]),
  failureCost: z.array(z.string()).default([]),
});

export const CanonBibleSchema = z.object({
  bookId: z.string().min(1),
  storyPromise: z.string().default(""),
  themeTensions: z.array(z.tuple([z.string(), z.string()])).default([]),
  centralQuestion: z.string().default(""),
  endingDirection: z.string().default(""),
  rules: z.array(CanonRuleSchema).default([]),
  factions: z.array(z.object({ name: z.string(), goal: z.string().default("") })).default([]),
  locations: z.array(z.object({ name: z.string(), note: z.string().default("") })).default([]),
  characters: z.array(CanonCharacterSchema).default([]),
  conflictEngine: ConflictEngineSchema.default({
    protagonistLongGoal: "",
    systemicObstacle: "",
    antagonistGoal: "",
    escalationMechanism: "",
    victoryCost: [],
    failureCost: [],
  }),
});
export type CanonBible = z.infer<typeof CanonBibleSchema>;

// ---------- 第四阶段：Story Spine / 卷纲 ----------

export const MajorBeatSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  stage: z.string().min(1),
  label: z.string().min(1),
  goalBefore: z.string().default(""),
  event: z.string().default(""),
  /** 因果依赖：本节拍由哪些前置节拍导致。空 = 开局节拍。 */
  causedBy: z.array(z.string()).default([]),
  stateChange: z.array(z.string()).default([]),
  characterArcImpact: z.array(z.string()).default([]),
  newQuestion: z.string().nullable().default(null),
  chapterRange: z
    .object({ from: z.number().int().positive(), to: z.number().int().positive() })
    .nullable()
    .default(null),
});
export type MajorBeat = z.infer<typeof MajorBeatSchema>;

export const OriginalSpineSchema = z.object({
  bookId: z.string().min(1),
  beats: z.array(MajorBeatSchema).min(1),
});
export type OriginalSpine = z.infer<typeof OriginalSpineSchema>;

export const ArcPlanSchema = z.object({
  bookId: z.string().min(1),
  arcs: z
    .array(
      z.object({
        id: z.string().min(1),
        index: z.number().int().positive(),
        title: z.string().min(1),
        promise: z.string().default(""),
        entryState: z.array(z.string()).default([]),
        coreConflict: z.string().default(""),
        midTurn: z.string().default(""),
        climax: z.string().default(""),
        exitState: z.array(z.string()).default([]),
        beatIds: z.array(z.string()).default([]),
        chapterRange: z
          .object({ from: z.number().int().positive(), to: z.number().int().positive() })
          .nullable()
          .default(null),
      }),
    )
    .min(1),
});
export type ArcPlan = z.infer<typeof ArcPlanSchema>;

// ---------- 第五阶段：章级契约 / 草稿 / 审计 / 状态 ----------

export const OriginalChapterContractSchema = z.object({
  chapter: z.number().int().positive(),
  arcId: z.string().default(""),
  purpose: z.array(z.string()).min(1),
  beatIds: z.array(z.string()).default([]),
  pov: z.string().nullable().default(null),
  chapterGoal: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().nullable().default(null),
  exitState: z.array(z.string()).min(1),
  setupHooks: z.array(z.string()).default([]),
  payoffHooks: z.array(z.string()).default([]),
  mustUse: z.array(z.string()).default([]),
  /** Writer 无权违反的硬约束（提前揭谜、超纲能力等）。 */
  mustNot: z.array(z.string()).default([]),
  targetWords: z.number().int().positive().default(3000),
  endHook: z.string().nullable().default(null),
});
export type OriginalChapterContract = z.infer<typeof OriginalChapterContractSchema>;

export const ChapterAuditIssueSchema = z.object({
  severity: z.enum(["info", "warning", "blocking"]),
  category: z.enum(["canon", "causality", "character", "pacing", "style", "foreshadow"]),
  description: z.string().min(1),
  suggestion: z.string().default(""),
});
export type ChapterAuditIssue = z.infer<typeof ChapterAuditIssueSchema>;

export const ChapterAuditReportSchema = z.object({
  bookId: z.string().min(1),
  generatedAt: z.string(),
  chapters: z.array(
    z.object({
      chapter: z.number().int().positive(),
      issues: z.array(ChapterAuditIssueSchema).default([]),
      /** 分项评分（0-100）；只做排序提示，硬约束才有否决权。 */
      scores: z.record(z.number().min(0).max(100)).default({}),
    }),
  ),
});
export type ChapterAuditReport = z.infer<typeof ChapterAuditReportSchema>;

export const StateSnapshotSchema = z.object({
  bookId: z.string().min(1),
  throughChapter: z.number().int().nonnegative(),
  characterStates: z
    .array(z.object({ name: z.string(), location: z.string().default(""), status: z.string().default(""), knows: z.array(z.string()).default([]) }))
    .default([]),
  worldState: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  hookLedger: z
    .array(z.object({ id: z.string(), status: z.enum(["open", "reminded", "paid"]), note: z.string().default("") }))
    .default([]),
  updatedAt: z.string(),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

/** 原创管线产出的 artifact id 常量。 */
export const CREATION_ARTIFACTS = {
  brief: "creation.brief",
  concepts: "creation.concepts",
  canon: "creation.canon",
  spine: "creation.spine",
  arcs: "creation.arcs",
  chapterContracts: "creation.chapter-contracts",
  drafts: "creation.drafts",
  audit: "creation.audit-report",
  state: "creation.state",
} as const;
