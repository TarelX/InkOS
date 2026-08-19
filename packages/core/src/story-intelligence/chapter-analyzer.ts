/**
 * Per-chapter semantic analysis (Pass A of Map → Reduce → Verify).
 *
 * The LLM is injected behind `ChapterAnalysisModel`; its output is strictly
 * validated and every event must quote text found inside its scene span —
 * quotes that fail verification demote the event to `candidate` (or drop it
 * when nothing matches). A deterministic fallback keeps the pipeline usable
 * without any model (CI / fake-LLM integration tests).
 */

import { z } from "zod";

import { eventId } from "./ids.js";
import { buildSourceRef } from "./schemas/source-ref.js";
import { EventSchema, type Scene, type StoryEvent } from "./schemas/scene-event.js";
import type { ParsedChapter } from "./source-parser.js";

/** What the model must return for one scene. */
export const ModelSceneAnalysisSchema = z.object({
  events: z
    .array(
      z.object({
        summary: z.string().min(1).max(400),
        /** Verbatim quote copied from the scene text — the provenance anchor. */
        quote: z.string().min(4).max(300),
        participants: z.array(z.string()).default([]),
        goal: z.string().nullable().default(null),
        obstacle: z.string().nullable().default(null),
        action: z.string().nullable().default(null),
        outcome: z.string().nullable().default(null),
        stateChanges: z.array(z.string()).default([]),
        narrativeFunction: z.array(z.string()).default([]),
        informationDelta: z.number().min(0).max(1).default(0),
        conflictDelta: z.number().min(0).max(1).default(0),
        emotionDelta: z.number().min(0).max(1).default(0),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .default([]),
  dramaticQuestion: z.string().nullable().default(null),
  turningPoint: z.string().nullable().default(null),
});
export type ModelSceneAnalysis = z.infer<typeof ModelSceneAnalysisSchema>;
/** What implementations may return — defaults are filled in by the schema. */
export type ModelSceneAnalysisInput = z.input<typeof ModelSceneAnalysisSchema>;

export interface ChapterAnalysisModel {
  analyzeScene(input: {
    readonly bookId: string;
    readonly chapter: ParsedChapter;
    readonly scene: Scene;
    readonly sceneText: string;
  }): Promise<ModelSceneAnalysisInput>;
}

const VALID_FUNCTIONS = new Set([
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

export interface SceneAnalysisResult {
  readonly scene: Scene;
  readonly events: ReadonlyArray<StoryEvent>;
  /** Events the model claimed but whose quotes could not be located. */
  readonly droppedQuotes: ReadonlyArray<string>;
}

export async function analyzeScene(
  bookId: string,
  chapter: ParsedChapter,
  scene: Scene,
  model: ChapterAnalysisModel,
): Promise<SceneAnalysisResult> {
  const sceneText = chapter.content.slice(scene.start, scene.end);
  const raw = await model.analyzeScene({ bookId, chapter, scene, sceneText });
  const analysis = ModelSceneAnalysisSchema.parse(raw);

  const events: StoryEvent[] = [];
  const droppedQuotes: string[] = [];
  let order = 0;
  for (const item of analysis.events) {
    // Quote must be findable inside the scene span; offsets are scene-relative
    // to chapter content (SourceRef hash domain = chapter file content).
    const local = sceneText.indexOf(item.quote);
    if (local < 0) {
      droppedQuotes.push(item.quote);
      continue;
    }
    const start = scene.start + local;
    const source = buildSourceRef({
      chapterFile: chapter.relPath,
      chapter: chapter.number,
      content: chapter.content,
      start,
      end: start + item.quote.length,
    });
    const parsed = EventSchema.parse({
      id: eventId(bookId, chapter.contentSha256, chapter.number, scene.index, order),
      bookId,
      chapter: chapter.number,
      sceneId: scene.id,
      order,
      summary: item.summary,
      participants: item.participants,
      goal: item.goal,
      obstacle: item.obstacle,
      action: item.action,
      outcome: item.outcome,
      stateChanges: item.stateChanges,
      narrativeFunction: item.narrativeFunction.filter((f) => VALID_FUNCTIONS.has(f)),
      informationDelta: item.informationDelta,
      conflictDelta: item.conflictDelta,
      emotionDelta: item.emotionDelta,
      source,
      confidence: item.confidence,
      // Verified quote ⇒ eligible for acceptance; gate/human flips to accepted.
      status: "candidate",
    });
    events.push(parsed);
    order++;
  }

  const updatedScene: Scene = {
    ...scene,
    dramaticQuestion: analysis.dramaticQuestion,
    turningPoint: analysis.turningPoint,
    eventIds: events.map((e) => e.id),
  };
  return { scene: updatedScene, events, droppedQuotes };
}

/**
 * Deterministic no-LLM fallback: one low-confidence event per scene anchored
 * on the scene's first non-empty paragraph. Keeps CI and offline smoke runs
 * meaningful without pretending to be semantic analysis.
 */
export const deterministicAnalyzer: ChapterAnalysisModel = {
  async analyzeScene({ sceneText }) {
    const paragraph = sceneText
      .split(/\n+/)
      .map((p) => p.trim())
      .find((p) => p.length >= 8);
    if (!paragraph) return { events: [], dramaticQuestion: null, turningPoint: null };
    const quote = paragraph.slice(0, Math.min(120, paragraph.length));
    return {
      events: [
        {
          summary: quote.slice(0, 80),
          quote,
          participants: [],
          goal: null,
          obstacle: null,
          action: null,
          outcome: null,
          stateChanges: [],
          narrativeFunction: [],
          informationDelta: 0,
          conflictDelta: 0,
          emotionDelta: 0,
          confidence: 0.2,
        },
      ],
      dramaticQuestion: null,
      turningPoint: null,
    };
  },
};
