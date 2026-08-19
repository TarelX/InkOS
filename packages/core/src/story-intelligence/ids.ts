/**
 * Stable ID derivation for Story Intelligence artifacts.
 *
 * IDs are content-addressed: bookId + source content hash + structural
 * coordinates (chapter / scene index / event order). Re-running analysis on
 * unchanged source text yields identical IDs; changed source text yields new
 * IDs so stale references are detectable instead of silently rebound.
 *
 * Human-driven merges never rewrite IDs — they add alias/redirect records
 * (see entity schema `mergedInto`).
 */

import { createHash } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function shortHash(parts: ReadonlyArray<string | number>): string {
  return sha256Hex(parts.join("\u0000")).slice(0, 12);
}

export function sceneId(bookId: string, sourceSha256: string, chapter: number, sceneIndex: number): string {
  return `scn_${shortHash([bookId, sourceSha256, chapter, sceneIndex])}`;
}

export function eventId(
  bookId: string,
  sourceSha256: string,
  chapter: number,
  sceneIndex: number,
  order: number,
): string {
  return `evt_${shortHash([bookId, sourceSha256, chapter, sceneIndex, order])}`;
}

/** Entities are keyed by canonical name discovery, not text position. */
export function entityId(bookId: string, kind: string, canonicalName: string): string {
  return `ent_${shortHash([bookId, kind, canonicalName.normalize("NFKC")])}`;
}

export function storylineId(bookId: string, slug: string): string {
  return `line_${shortHash([bookId, slug.normalize("NFKC")])}`;
}

export function foreshadowId(bookId: string, setupEventId: string, slug: string): string {
  return `hook_${shortHash([bookId, setupEventId, slug.normalize("NFKC")])}`;
}

export function causalEdgeId(fromEventId: string, toEventId: string, type: string): string {
  return `edge_${shortHash([fromEventId, toEventId, type])}`;
}

const ID_PATTERNS: Record<string, RegExp> = {
  scene: /^scn_[0-9a-f]{12}$/,
  event: /^evt_[0-9a-f]{12}$/,
  entity: /^ent_[0-9a-f]{12}$/,
  storyline: /^line_[0-9a-f]{12}$/,
  foreshadow: /^hook_[0-9a-f]{12}$/,
  causalEdge: /^edge_[0-9a-f]{12}$/,
};

export function isValidId(kind: keyof typeof ID_PATTERNS, id: string): boolean {
  return ID_PATTERNS[kind]?.test(id) ?? false;
}
