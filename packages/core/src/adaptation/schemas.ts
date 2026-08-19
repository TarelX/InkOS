/**
 * Adaptation pipeline contracts (V2.1 vertical).
 *
 * The Adaptation Contract is decided WITH the user before any rewriting; the
 * Event Map makes every keep/compress/merge/drop/reorder decision visible;
 * gates block silent destruction of must-preserve experiences and strong
 * causal chains.
 */

import { z } from "zod";

export const MustPreserveSchema = z.object({
  kind: z.enum(["event", "storyline", "relationship", "reveal", "character_arc", "emotional_payoff"]),
  refId: z.string().min(1),
  note: z.string().default(""),
});

export const AdaptationContractSchema = z.object({
  schemaVersion: z.literal(1),
  bookId: z.string().min(1),
  sourceBookId: z.string().min(1),
  format: z.string().default("web_novel"),
  mustPreserve: z.array(MustPreserveSchema).default([]),
  canChange: z.array(z.string()).default([]),
  canMerge: z.array(z.string()).default([]),
  forbidden: z.array(z.string()).default([]),
  target: z
    .object({
      genre: z.string().default(""),
      chapterCount: z.number().int().positive().nullable().default(null),
      pace: z.enum(["fast", "medium", "slow"]).default("fast"),
      notes: z.string().default(""),
    })
    .default({ genre: "", chapterCount: null, pace: "fast", notes: "" }),
});
export type AdaptationContract = z.infer<typeof AdaptationContractSchema>;

export const EventDecisionKindSchema = z.enum([
  "preserve",
  "compress",
  "merge",
  "split",
  "reorder",
  "replace",
  "remove",
]);
export type EventDecisionKind = z.infer<typeof EventDecisionKindSchema>;

export const EventDecisionSchema = z.object({
  sourceEventId: z.string().min(1),
  decision: EventDecisionKindSchema,
  targetEventIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
  preserve: z.array(z.string()).default([]),
  changed: z.array(z.string()).default([]),
  /** Required when removing an event that sits inside a strong causal chain. */
  replacementNote: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type EventDecision = z.infer<typeof EventDecisionSchema>;

export const CharacterMapEntrySchema = z.object({
  sourceEntityId: z.string().nullable().default(null),
  sourceName: z.string().min(1),
  targetName: z.string().min(1),
  strategy: z.enum(["rename", "keep_name", "merge_into", "drop", "invent"]),
  mergedIntoTargetName: z.string().nullable().default(null),
  /** invent 必须经人工批准才能过溯源闸。 */
  approvedInvention: z.boolean().default(false),
  tier: z.enum(["major", "minor"]).default("minor"),
  reason: z.string().default(""),
});
export type CharacterMapEntry = z.infer<typeof CharacterMapEntrySchema>;

export const TargetSpineBeatSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  label: z.string().min(1),
  sourceEventIds: z.array(z.string()).default([]),
  stateChanges: z.array(z.string()).default([]),
  newQuestion: z.string().nullable().default(null),
  chapterRange: z
    .object({ from: z.number().int().positive(), to: z.number().int().positive() })
    .nullable()
    .default(null),
});

export const TargetSpineSchema = z.object({
  bookId: z.string().min(1),
  sourceBookId: z.string().min(1),
  beats: z.array(TargetSpineBeatSchema).min(1),
});
export type TargetSpine = z.infer<typeof TargetSpineSchema>;

export const AdaptationChapterContractSchema = z.object({
  chapter: z.number().int().positive(),
  purpose: z.array(z.string()).min(1),
  spineBeatIds: z.array(z.string()).default([]),
  sourceEventIds: z.array(z.string()).default([]),
  pov: z.string().nullable().default(null),
  chapterGoal: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().nullable().default(null),
  exitState: z.array(z.string()).default([]),
  mustUse: z.array(z.string()).default([]),
  mustNot: z.array(z.string()).default([]),
  targetWords: z.number().int().positive().default(3000),
  endHook: z.string().nullable().default(null),
});
export type AdaptationChapterContract = z.infer<typeof AdaptationChapterContractSchema>;

export const AuditSeveritySchema = z.enum(["info", "warning", "blocking"]);

export const AuditIssueSchema = z.object({
  severity: AuditSeveritySchema,
  category: z.enum(["continuity", "causality", "pacing", "source_fidelity"]),
  description: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  suggestion: z.string().default(""),
});
export type AdaptationAuditIssue = z.infer<typeof AuditIssueSchema>;

export const AdaptationAuditReportSchema = z.object({
  bookId: z.string().min(1),
  chapter: z.number().int().positive().nullable().default(null),
  generatedAt: z.string(),
  issues: z.array(AuditIssueSchema).default([]),
});
export type AdaptationAuditReport = z.infer<typeof AdaptationAuditReportSchema>;
