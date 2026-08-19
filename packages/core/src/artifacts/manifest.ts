/**
 * Artifact manifest — the unit of "what a workflow node actually produced".
 *
 * ADR-003: artifact content (JSON canonical + Markdown projection) is the
 * content source of truth; the SQLite index is rebuildable from manifests.
 * Versions are immutable — status transitions append to statusHistory and
 * rewrite manifest.json only (content files are never mutated).
 */

import { z } from "zod";

export const ArtifactStatusSchema = z.enum(["draft", "accepted", "rejected", "superseded"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactInputSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
});
export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;

export const ArtifactManifestSchema = z.object({
  manifestVersion: z.literal(1),
  artifactId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, "artifactId must be filesystem-safe (alnum . _ -)"),
  version: z.number().int().positive(),
  bookId: z.string().min(1),
  createdAt: z.string(),
  createdBy: z.string().min(1),
  runId: z.string().nullable().default(null),
  nodeId: z.string().nullable().default(null),
  /** Pinned upstream artifact versions this output was derived from. */
  inputs: z.array(ArtifactInputSchema).default([]),
  /** Content files inside the version dir, name → sha256. */
  files: z.record(z.string().regex(/^[0-9a-f]{64}$/)),
  /** Optional schema identifier for the primary JSON payload. */
  schemaId: z.string().nullable().default(null),
  /** Human-readable projections written under the book dir (relative paths). */
  projections: z.array(z.string()).default([]),
  status: ArtifactStatusSchema.default("draft"),
  statusHistory: z
    .array(
      z.object({
        status: ArtifactStatusSchema,
        at: z.string(),
        by: z.string().min(1),
        note: z.string().default(""),
      }),
    )
    .default([]),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export interface ArtifactRef {
  readonly artifactId: string;
  readonly version: number;
}
