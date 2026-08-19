/**
 * Scene / Event / Beat — the analysis units of Story Intelligence.
 *
 * Event is the smallest causal unit; Beat is the smallest visual-adaptation
 * unit. Chapter summaries are projections, never the source of truth.
 */

import { z } from "zod";
import { ConfidenceStatusSchema, SourceRefSchema } from "./source-ref.js";

export const NarrativeFunctionSchema = z.enum([
  "advance_plot",
  "reveal_information",
  "change_relationship",
  "increase_stakes",
  "character_choice",
  "setup",
  "payoff",
  "reversal",
  "recovery",
  "escalation",
  "reveal",
  "transition",
]);
export type NarrativeFunction = z.infer<typeof NarrativeFunctionSchema>;

/** 0..1 normalized delta scores. These are ranking signals, not ground truth. */
const Delta = z.number().min(0).max(1);

export const HookOpSchema = z.object({
  op: z.enum(["setup", "reminder", "payoff"]),
  foreshadowId: z.string(),
});

export const EventSchema = z.object({
  id: z.string().regex(/^evt_[0-9a-f]{12}$/),
  bookId: z.string().min(1),
  chapter: z.number().int().positive(),
  sceneId: z.string().regex(/^scn_[0-9a-f]{12}$/),
  order: z.number().int().nonnegative(),

  summary: z.string().min(1).max(400),
  participants: z.array(z.string()).default([]),
  locationEntityId: z.string().nullable().default(null),
  timeHint: z.string().nullable().default(null),

  povEntityId: z.string().nullable().default(null),
  goal: z.string().nullable().default(null),
  obstacle: z.string().nullable().default(null),
  action: z.string().nullable().default(null),
  outcome: z.string().nullable().default(null),

  stateChanges: z.array(z.string()).default([]),
  narrativeFunction: z.array(NarrativeFunctionSchema).default([]),
  hookOps: z.array(HookOpSchema).default([]),

  informationDelta: Delta.default(0),
  conflictDelta: Delta.default(0),
  emotionDelta: Delta.default(0),

  storylines: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1) })).default([]),

  source: SourceRefSchema,
  confidence: z.number().min(0).max(1),
  status: ConfidenceStatusSchema.default("candidate"),
});
export type StoryEvent = z.infer<typeof EventSchema>;

export const ScenePurposeSchema = NarrativeFunctionSchema;

export const SceneSchema = z.object({
  id: z.string().regex(/^scn_[0-9a-f]{12}$/),
  bookId: z.string().min(1),
  chapter: z.number().int().positive(),
  index: z.number().int().nonnegative(),

  /** Offset span within the chapter content (same hash domain as SourceRef). */
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),

  purpose: z.array(ScenePurposeSchema).default([]),
  dramaticQuestion: z.string().nullable().default(null),
  turningPoint: z.string().nullable().default(null),
  entryState: z.record(z.string()).default({}),
  exitState: z.record(z.string()).default({}),
  eventIds: z.array(z.string()).default([]),

  pace: z
    .object({
      density: Delta.default(0),
      repetition: Delta.default(0),
      exposition: Delta.default(0),
    })
    .default({ density: 0, repetition: 0, exposition: 0 }),

  status: ConfidenceStatusSchema.default("candidate"),
});
export type Scene = z.infer<typeof SceneSchema>;

/** A scene with no meaningful narrative delta — the "拖沓" primitive. */
export const NOOP_SCENE_FLAG = "PACING_NOOP_SCENE";
export const MAINLINE_STALL_FLAG = "MAINLINE_STALL";
