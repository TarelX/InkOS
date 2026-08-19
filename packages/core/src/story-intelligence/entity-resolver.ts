/**
 * Cross-chapter entity resolution (Pass B).
 *
 * Exact-name groups become entities with evidence; suspicious containment
 * pairs ("蒋文明" ⊇ "文明", "老周" vs "周掌柜") become merge PROPOSALS for a
 * human or a high-confidence rule — never silent auto-merges. This replaces
 * the V1 substring heuristics that fabricated or dropped roles.
 */

import { entityId } from "./ids.js";
import type { SourceRef } from "./schemas/source-ref.js";
import type { StoryEvent } from "./schemas/scene-event.js";
import { EntitySchema, EntityMergeProposalSchema, type Entity, type EntityMergeProposal } from "./schemas/entities.js";

export interface EntityResolutionResult {
  readonly entities: ReadonlyArray<Entity>;
  readonly proposals: ReadonlyArray<EntityMergeProposal>;
}

export function resolveEntities(bookId: string, events: ReadonlyArray<StoryEvent>): EntityResolutionResult {
  interface Group {
    name: string;
    chapters: Set<number>;
    firstChapter: number;
    evidence: SourceRef[];
  }
  const groups = new Map<string, Group>();

  for (const event of events) {
    for (const rawName of event.participants) {
      const name = rawName.normalize("NFKC").trim();
      if (name.length < 2) continue;
      let group = groups.get(name);
      if (!group) {
        group = { name, chapters: new Set(), firstChapter: event.chapter, evidence: [] };
        groups.set(name, group);
      }
      group.chapters.add(event.chapter);
      group.firstChapter = Math.min(group.firstChapter, event.chapter);
      if (group.evidence.length < 5) group.evidence.push(event.source);
    }
  }

  const entities: Entity[] = [];
  for (const group of groups.values()) {
    entities.push(
      EntitySchema.parse({
        id: entityId(bookId, "character", group.name),
        bookId,
        kind: "character",
        canonicalName: group.name,
        aliases: [
          {
            name: group.name,
            evidence: group.evidence,
            confidence: Math.min(1, 0.4 + group.chapters.size * 0.1),
            status: "candidate",
          },
        ],
        firstChapter: group.firstChapter,
        chapterCount: group.chapters.size,
        summary: "",
        status: group.chapters.size >= 2 ? "accepted" : "candidate",
        mergedInto: null,
      }),
    );
  }
  entities.sort((a, b) => b.chapterCount - a.chapterCount || (a.firstChapter ?? 0) - (b.firstChapter ?? 0));

  // Containment pairs → merge proposals (human queue), never auto-merge.
  const proposals: EntityMergeProposal[] = [];
  for (const shorter of entities) {
    for (const longer of entities) {
      if (shorter === longer) continue;
      if (longer.canonicalName.length <= shorter.canonicalName.length) continue;
      if (!longer.canonicalName.includes(shorter.canonicalName)) continue;
      proposals.push(
        EntityMergeProposalSchema.parse({
          id: `merge_${shorter.id.slice(4)}_${longer.id.slice(4)}`,
          bookId,
          leftEntityId: shorter.id,
          rightEntityId: longer.id,
          reason: `“${shorter.canonicalName}” 是 “${longer.canonicalName}” 的子串，疑似同一角色的简称/别名`,
          evidence: [...shorter.aliases[0].evidence.slice(0, 2), ...longer.aliases[0].evidence.slice(0, 2)],
          confidence: shorter.chapterCount <= longer.chapterCount ? 0.6 : 0.4,
          resolution: "pending",
          resolvedBy: null,
        }),
      );
    }
  }
  return { entities, proposals };
}
