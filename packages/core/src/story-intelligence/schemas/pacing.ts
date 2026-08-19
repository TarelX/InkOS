/**
 * Pacing analysis output.
 *
 * Narrative Delta = information + state + conflict + emotion + hook deltas,
 * penalized by repetition / redundant exposition / goal-less dialogue.
 * Numbers are ranking signals for editors, never a fake objective score
 * (ADR-006).
 */

import { z } from "zod";
import { SourceRefSchema } from "./source-ref.js";

const Delta = z.number().min(0).max(1);

export const ScenePacingSchema = z.object({
  sceneId: z.string(),
  chapter: z.number().int().positive(),
  informationDelta: Delta,
  stateDelta: Delta,
  conflictDelta: Delta,
  emotionDelta: Delta,
  hookDelta: Delta,
  repetition: Delta,
  exposition: Delta,
  goallessDialogue: Delta,
  narrativeDelta: z.number().min(-3).max(5),
  flags: z.array(z.string()).default([]),
  /** Editor-facing explanation with pointers into the text. */
  notes: z.array(z.string()).default([]),
  evidence: z.array(SourceRefSchema).default([]),
});
export type ScenePacing = z.infer<typeof ScenePacingSchema>;

export const PacingReportSchema = z.object({
  bookId: z.string().min(1),
  generatedAt: z.string(),
  scenes: z.array(ScenePacingSchema),
  /** Chapters where the main storyline made no progress for N chapters. */
  mainlineStalls: z
    .array(
      z.object({
        storylineId: z.string(),
        fromChapter: z.number().int().positive(),
        toChapter: z.number().int().positive(),
        reason: z.string(),
      }),
    )
    .default([]),
});
export type PacingReport = z.infer<typeof PacingReportSchema>;

export interface NarrativeDeltaInput {
  readonly informationDelta: number;
  readonly stateDelta: number;
  readonly conflictDelta: number;
  readonly emotionDelta: number;
  readonly hookDelta: number;
  readonly repetition: number;
  readonly exposition: number;
  readonly goallessDialogue: number;
}

export function computeNarrativeDelta(input: NarrativeDeltaInput): number {
  const gain =
    input.informationDelta + input.stateDelta + input.conflictDelta + input.emotionDelta + input.hookDelta;
  const penalty = input.repetition + input.exposition + input.goallessDialogue;
  return Number((gain - penalty).toFixed(4));
}

/** Threshold rule for PACING_NOOP_SCENE: every gain axis low simultaneously. */
export function isNoopScene(input: NarrativeDeltaInput, threshold = 0.15): boolean {
  return (
    input.informationDelta < threshold &&
    input.stateDelta < threshold &&
    input.conflictDelta < threshold &&
    input.emotionDelta < threshold &&
    input.hookDelta < threshold
  );
}
