/**
 * Causal graph and storyline schemas.
 *
 * Edge test (Pass C): "if event A is deleted, can event B still plausibly
 * happen?" — no ⇒ strong edge. Every strong edge carries an explanation and
 * evidence; unexplained edges cannot be accepted.
 */

import { z } from "zod";
import { ConfidenceStatusSchema, SourceRefSchema } from "./source-ref.js";

export const CausalEdgeTypeSchema = z.enum([
  "causes",
  "enables",
  "motivates",
  "reveals",
  "blocks",
  "pays_off",
  "escalates",
  "contradicts",
]);
export type CausalEdgeType = z.infer<typeof CausalEdgeTypeSchema>;

export const CausalEdgeSchema = z.object({
  id: z.string().regex(/^edge_[0-9a-f]{12}$/),
  bookId: z.string().min(1),
  fromEventId: z.string(),
  toEventId: z.string(),
  type: CausalEdgeTypeSchema,
  strength: z.enum(["strong", "weak"]),
  explanation: z.string().min(1),
  evidence: z.array(SourceRefSchema).default([]),
  confidence: z.number().min(0).max(1),
  status: ConfidenceStatusSchema.default("candidate"),
}).refine((e) => e.fromEventId !== e.toEventId, { message: "causal edge cannot be reflexive" });
export type CausalEdge = z.infer<typeof CausalEdgeSchema>;

export const StorylineTypeSchema = z.enum([
  "main",
  "sub",
  "character_arc",
  "relationship",
  "mystery",
  "faction",
  "progression",
  "side",
]);
export type StorylineType = z.infer<typeof StorylineTypeSchema>;

export const StorylinePhaseSchema = z.object({
  name: z.string().min(1),
  startEventId: z.string().nullable().default(null),
  endEventId: z.string().nullable().default(null),
});

export const StorylineSchema = z.object({
  id: z.string().regex(/^line_[0-9a-f]{12}$/),
  bookId: z.string().min(1),
  name: z.string().min(1),
  type: StorylineTypeSchema,
  /** The reader promise this line makes ("主角查清灭门真相并完成复仇"). */
  promise: z.string().min(1),
  phases: z.array(StorylinePhaseSchema).default([]),
  eventIds: z.array(z.string()).default([]),
  startEventId: z.string().nullable().default(null),
  payoffEventId: z.string().nullable().default(null),
  status: z.enum(["active", "resolved", "abandoned"]).default("active"),
  /** Pacing gate: max consecutive chapters allowed without progress. */
  maxSilenceWindow: z.number().int().positive().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  reviewStatus: ConfidenceStatusSchema.default("candidate"),
});
export type Storyline = z.infer<typeof StorylineSchema>;

export const TimelineEntrySchema = z.object({
  eventId: z.string(),
  /** Narrative order (reading order). */
  narrativeOrder: z.number().int().nonnegative(),
  /** Story-world time hint when derivable ("same_day_evening", "三日后"). */
  storyTime: z.string().nullable().default(null),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
