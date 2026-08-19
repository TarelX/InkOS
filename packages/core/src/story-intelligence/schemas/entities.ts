/**
 * Entity resolution schemas: characters, locations, factions, items.
 *
 * Aliases carry evidence and confidence; ambiguous merges go to a human
 * queue instead of being auto-collapsed by substring heuristics (the V1
 * failure mode that produced 龙门/龙门试/龙野手 ghost roles).
 */

import { z } from "zod";
import { ConfidenceStatusSchema, SourceRefSchema } from "./source-ref.js";

export const EntityKindSchema = z.enum(["character", "location", "faction", "item", "concept"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityAliasSchema = z.object({
  name: z.string().min(1),
  evidence: z.array(SourceRefSchema).min(1),
  confidence: z.number().min(0).max(1),
  status: ConfidenceStatusSchema.default("candidate"),
});
export type EntityAlias = z.infer<typeof EntityAliasSchema>;

export const EntitySchema = z.object({
  id: z.string().regex(/^ent_[0-9a-f]{12}$/),
  bookId: z.string().min(1),
  kind: EntityKindSchema,
  canonicalName: z.string().min(1),
  aliases: z.array(EntityAliasSchema).default([]),
  firstChapter: z.number().int().positive().nullable().default(null),
  /** Document frequency: number of chapters that mention this entity. */
  chapterCount: z.number().int().nonnegative().default(0),
  summary: z.string().default(""),
  status: ConfidenceStatusSchema.default("candidate"),
  /** Set when a human approved merging this entity into another. ID survives. */
  mergedInto: z.string().nullable().default(null),
});
export type Entity = z.infer<typeof EntitySchema>;

/** A pending ambiguous merge that needs human review ("老周" = "周掌柜"?). */
export const EntityMergeProposalSchema = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  leftEntityId: z.string(),
  rightEntityId: z.string(),
  reason: z.string().min(1),
  evidence: z.array(SourceRefSchema).default([]),
  confidence: z.number().min(0).max(1),
  resolution: z.enum(["pending", "merged", "rejected"]).default("pending"),
  resolvedBy: z.enum(["human", "rule"]).nullable().default(null),
});
export type EntityMergeProposal = z.infer<typeof EntityMergeProposalSchema>;

export const CharacterStateSnapshotSchema = z.object({
  entityId: z.string(),
  chapter: z.number().int().positive(),
  goal: z.string().nullable().default(null),
  want: z.string().nullable().default(null),
  fear: z.string().nullable().default(null),
  knows: z.array(z.string()).default([]),
  doesNotKnow: z.array(z.string()).default([]),
  arcStage: z.string().nullable().default(null),
  evidence: z.array(SourceRefSchema).default([]),
  status: ConfidenceStatusSchema.default("candidate"),
});
export type CharacterStateSnapshot = z.infer<typeof CharacterStateSnapshotSchema>;

export const RelationshipStateSchema = z.object({
  fromEntityId: z.string(),
  toEntityId: z.string(),
  chapter: z.number().int().positive(),
  /** Free-form dynamic label, e.g. "表面合作/真实怀疑". */
  label: z.string().min(1),
  /** -1 hostile .. +1 allied; heuristic ranking signal only. */
  polarity: z.number().min(-1).max(1).default(0),
  trust: z.number().min(0).max(1).nullable().default(null),
  triggerEventId: z.string().nullable().default(null),
  evidence: z.array(SourceRefSchema).default([]),
  status: ConfidenceStatusSchema.default("candidate"),
});
export type RelationshipState = z.infer<typeof RelationshipStateSchema>;
