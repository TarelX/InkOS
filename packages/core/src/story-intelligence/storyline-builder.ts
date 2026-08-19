/**
 * Storyline clustering (Pass D) — deterministic base implementation.
 *
 * Strong-edge connected components become storylines; the component with the
 * highest protagonist participation is `main`. An LLM refiner can later merge
 * or label lines, but structure and membership stay evidence-derived.
 */

import { storylineId } from "./ids.js";
import type { CausalEdge } from "./schemas/graph.js";
import { StorylineSchema, type Storyline } from "./schemas/graph.js";
import type { StoryEvent } from "./schemas/scene-event.js";

export interface StorylineBuildOptions {
  /** Entity name to treat as protagonist; defaults to the most frequent participant. */
  readonly protagonist?: string;
  readonly minEvents?: number;
}

export function buildStorylines(
  bookId: string,
  events: ReadonlyArray<StoryEvent>,
  edges: ReadonlyArray<CausalEdge>,
  options: StorylineBuildOptions = {},
): ReadonlyArray<Storyline> {
  const minEvents = options.minEvents ?? 2;
  const eventById = new Map(events.map((e) => [e.id, e]));

  // Union-find over strong + accepted-weak edges.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const event of events) parent.set(event.id, event.id);
  for (const edge of edges) {
    if (!eventById.has(edge.fromEventId) || !eventById.has(edge.toEventId)) continue;
    union(edge.fromEventId, edge.toEventId);
  }

  const components = new Map<string, StoryEvent[]>();
  for (const event of events) {
    const root = find(event.id);
    const list = components.get(root) ?? [];
    list.push(event);
    components.set(root, list);
  }

  const protagonist = options.protagonist ?? mostFrequentParticipant(events);

  const lines: Storyline[] = [];
  let subIndex = 1;
  const ranked = [...components.values()]
    .filter((members) => members.length >= minEvents)
    .sort((a, b) => b.length - a.length);

  for (const members of ranked) {
    members.sort((a, b) => a.chapter - b.chapter || a.order - b.order);
    const isMain =
      lines.every((l) => l.type !== "main") &&
      protagonist !== null &&
      members.some((e) => e.participants.includes(protagonist)) &&
      members.length === ranked[0].length;
    const slug = isMain ? "main" : `sub-${subIndex++}`;
    lines.push(
      StorylineSchema.parse({
        id: storylineId(bookId, slug),
        bookId,
        name: isMain ? "主线" : `支线 ${subIndex - 1}`,
        type: isMain ? "main" : "sub",
        promise: members[0]?.summary ?? "（待人工确认）",
        phases: [],
        eventIds: members.map((e) => e.id),
        startEventId: members[0]?.id ?? null,
        payoffEventId: null,
        status: "active",
        maxSilenceWindow: isMain ? 2 : null,
        confidence: Math.min(1, 0.3 + members.length * 0.02),
        reviewStatus: "candidate",
      }),
    );
  }
  return lines;
}

function mostFrequentParticipant(events: ReadonlyArray<StoryEvent>): string | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const p of event.participants) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** MAINLINE_STALL detection: consecutive chapters without main-line progress. */
export function detectMainlineStalls(
  main: Storyline,
  events: ReadonlyArray<StoryEvent>,
  chapters: ReadonlyArray<number>,
  maxSilence = main.maxSilenceWindow ?? 2,
): ReadonlyArray<{ fromChapter: number; toChapter: number; reason: string }> {
  const mainEventIds = new Set(main.eventIds);
  const progressChapters = new Set(
    events.filter((e) => mainEventIds.has(e.id) && (e.informationDelta > 0.2 || e.conflictDelta > 0.2 || e.stateChanges.length > 0)).map((e) => e.chapter),
  );
  const sorted = [...chapters].sort((a, b) => a - b);
  const stalls: Array<{ fromChapter: number; toChapter: number; reason: string }> = [];
  let runStart: number | null = null;
  for (const chapter of sorted) {
    if (progressChapters.has(chapter)) {
      if (runStart !== null && chapter - runStart > maxSilence) {
        stalls.push({
          fromChapter: runStart,
          toChapter: chapter - 1,
          reason: `主线连续 ${chapter - runStart} 章无新信息/冲突/状态变化（阈值 ${maxSilence}）`,
        });
      }
      runStart = null;
    } else if (runStart === null) {
      runStart = chapter;
    }
  }
  if (runStart !== null && sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    if (last - runStart + 1 > maxSilence) {
      stalls.push({
        fromChapter: runStart,
        toChapter: last,
        reason: `主线结尾连续 ${last - runStart + 1} 章停滞（阈值 ${maxSilence}）`,
      });
    }
  }
  return stalls;
}
