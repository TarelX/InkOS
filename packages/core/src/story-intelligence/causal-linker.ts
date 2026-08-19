/**
 * Causal linking (Pass C) with windowed candidate recall.
 *
 * Never O(N²) over the whole book: an event only considers predecessors
 * within `chapterWindow` chapters that share a participant, plus its direct
 * in-scene predecessor. A judge (LLM or heuristic) decides edge type and
 * strength; strong edges require an explanation.
 */

import { causalEdgeId } from "./ids.js";
import { CausalEdgeSchema, type CausalEdge, type CausalEdgeType } from "./schemas/graph.js";
import type { StoryEvent } from "./schemas/scene-event.js";

export interface CandidatePair {
  readonly from: StoryEvent;
  readonly to: StoryEvent;
  readonly reason: "same-scene-adjacent" | "participant-overlap";
}

export function candidatePairs(
  events: ReadonlyArray<StoryEvent>,
  options: { chapterWindow?: number; maxPerEvent?: number } = {},
): ReadonlyArray<CandidatePair> {
  const chapterWindow = options.chapterWindow ?? 12;
  const maxPerEvent = options.maxPerEvent ?? 12;
  const sorted = [...events].sort((a, b) => a.chapter - b.chapter || a.sceneId.localeCompare(b.sceneId) || a.order - b.order);

  const pairs: CandidatePair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const to = sorted[i];
    const participants = new Set(to.participants);
    let taken = 0;

    for (let j = i - 1; j >= 0 && taken < maxPerEvent; j--) {
      const from = sorted[j];
      if (to.chapter - from.chapter > chapterWindow) break;
      if (from.sceneId === to.sceneId && from.order === to.order - 1) {
        pairs.push({ from, to, reason: "same-scene-adjacent" });
        taken++;
        continue;
      }
      if (from.participants.some((p) => participants.has(p))) {
        pairs.push({ from, to, reason: "participant-overlap" });
        taken++;
      }
    }
  }
  return pairs;
}

export interface CausalJudgement {
  readonly type: CausalEdgeType;
  readonly strength: "strong" | "weak";
  readonly explanation: string;
  readonly confidence: number;
}

export type CausalJudge = (pair: CandidatePair) => Promise<CausalJudgement | null>;

/** Deterministic fallback: in-scene adjacency ⇒ weak `enables` edge. */
export const heuristicJudge: CausalJudge = async (pair) => {
  if (pair.reason === "same-scene-adjacent") {
    return {
      type: "enables",
      strength: "weak",
      explanation: "同场景相邻事件（启发式候选，待模型/人工确认）",
      confidence: 0.3,
    };
  }
  return null;
};

export async function linkCausally(
  bookId: string,
  events: ReadonlyArray<StoryEvent>,
  judge: CausalJudge,
  options: { chapterWindow?: number; maxPerEvent?: number } = {},
): Promise<ReadonlyArray<CausalEdge>> {
  const edges: CausalEdge[] = [];
  const seen = new Set<string>();
  for (const pair of candidatePairs(events, options)) {
    const judgement = await judge(pair);
    if (!judgement) continue;
    const id = causalEdgeId(pair.from.id, pair.to.id, judgement.type);
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push(
      CausalEdgeSchema.parse({
        id,
        bookId,
        fromEventId: pair.from.id,
        toEventId: pair.to.id,
        type: judgement.type,
        strength: judgement.strength,
        explanation: judgement.explanation,
        evidence: [pair.from.source, pair.to.source],
        confidence: judgement.confidence,
        status: judgement.strength === "strong" && judgement.confidence >= 0.75 ? "accepted" : "candidate",
      }),
    );
  }
  return edges;
}

/** A3 acceptance primitive: which events lose causal grounding if `eventId` is removed? */
export function orphanedByRemoval(edges: ReadonlyArray<CausalEdge>, eventId: string): ReadonlyArray<string> {
  const strongIncoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.strength !== "strong") continue;
    const list = strongIncoming.get(edge.toEventId) ?? [];
    list.push(edge.fromEventId);
    strongIncoming.set(edge.toEventId, list);
  }
  const orphaned: string[] = [];
  const removed = new Set([eventId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [to, froms] of strongIncoming.entries()) {
      if (removed.has(to)) continue;
      if (froms.length > 0 && froms.every((f) => removed.has(f))) {
        removed.add(to);
        orphaned.push(to);
        changed = true;
      }
    }
  }
  return orphaned;
}
