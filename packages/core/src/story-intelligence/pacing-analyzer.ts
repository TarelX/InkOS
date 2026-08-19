/**
 * Pacing analysis: aggregate event deltas per scene, flag no-op scenes and
 * main-line stalls with pointers back to the text (ADR "拖沓可解释").
 */

import { NOOP_SCENE_FLAG, type Scene, type StoryEvent } from "./schemas/scene-event.js";
import { PacingReportSchema, computeNarrativeDelta, isNoopScene, type PacingReport, type ScenePacing } from "./schemas/pacing.js";
import type { Storyline } from "./schemas/graph.js";
import { detectMainlineStalls } from "./storyline-builder.js";

export function buildPacingReport(
  bookId: string,
  scenes: ReadonlyArray<Scene>,
  events: ReadonlyArray<StoryEvent>,
  storylines: ReadonlyArray<Storyline>,
): PacingReport {
  const eventsByScene = new Map<string, StoryEvent[]>();
  for (const event of events) {
    const list = eventsByScene.get(event.sceneId) ?? [];
    list.push(event);
    eventsByScene.set(event.sceneId, list);
  }

  const sceneReports: ScenePacing[] = scenes.map((scene) => {
    const sceneEvents = eventsByScene.get(scene.id) ?? [];
    const max = (pick: (e: StoryEvent) => number): number =>
      sceneEvents.reduce((acc, e) => Math.max(acc, pick(e)), 0);
    const input = {
      informationDelta: max((e) => e.informationDelta),
      stateDelta: sceneEvents.some((e) => e.stateChanges.length > 0) ? 0.6 : 0,
      conflictDelta: max((e) => e.conflictDelta),
      emotionDelta: max((e) => e.emotionDelta),
      hookDelta: sceneEvents.some((e) => e.hookOps.length > 0) ? 0.6 : 0,
      repetition: scene.pace.repetition,
      exposition: scene.pace.exposition,
      goallessDialogue: 0,
    };
    const flags: string[] = [];
    const notes: string[] = [];
    if (isNoopScene(input)) {
      flags.push(NOOP_SCENE_FLAG);
      notes.push("信息/状态/冲突/情绪/悬念增量同时低于阈值——候选合并或删除场景");
    }
    return {
      sceneId: scene.id,
      chapter: scene.chapter,
      ...input,
      narrativeDelta: computeNarrativeDelta(input),
      flags,
      notes,
      evidence: sceneEvents.slice(0, 3).map((e) => e.source),
    };
  });

  const chapters = [...new Set(scenes.map((s) => s.chapter))];
  const main = storylines.find((l) => l.type === "main");
  const mainlineStalls = main
    ? detectMainlineStalls(main, events, chapters).map((stall) => ({ storylineId: main.id, ...stall }))
    : [];

  return PacingReportSchema.parse({
    bookId,
    generatedAt: new Date().toISOString(),
    scenes: sceneReports,
    mainlineStalls,
  });
}
