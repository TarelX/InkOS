/**
 * SourceRef — verifiable provenance for every accepted story fact.
 *
 * ADR-004: accepted-level conclusions MUST carry a SourceRef that can be
 * re-verified against chapter content (content hash + offset range + quote
 * hash). Anything that cannot be traced stays `candidate`.
 */

import { z } from "zod";
import { sha256Hex } from "../ids.js";

export const ConfidenceStatusSchema = z.enum(["candidate", "accepted", "rejected"]);
export type ConfidenceStatus = z.infer<typeof ConfidenceStatusSchema>;

export const SourceRefSchema = z.object({
  /** Path relative to the book dir, e.g. "chapters/0023_错名.md". */
  chapterFile: z.string().min(1),
  chapter: z.number().int().positive(),
  /** SHA-256 of the exact chapter file content the offsets were computed on. */
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Unicode code-unit offsets into the chapter content. */
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  /** Verbatim quote (may be trimmed to a budget, but must be a substring). */
  quote: z.string().min(1).max(600),
  /** SHA-256 of `quote`, guards against silent quote edits. */
  quoteSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).refine((r) => r.end > r.start, { message: "SourceRef end must be greater than start" });

export type SourceRef = z.infer<typeof SourceRefSchema>;

export function buildSourceRef(input: {
  chapterFile: string;
  chapter: number;
  content: string;
  start: number;
  end: number;
}): SourceRef {
  const quote = input.content.slice(input.start, input.end);
  if (!quote) {
    throw new Error(`buildSourceRef: empty quote for ${input.chapterFile} [${input.start},${input.end})`);
  }
  const trimmed = quote.length > 600 ? quote.slice(0, 600) : quote;
  return SourceRefSchema.parse({
    chapterFile: input.chapterFile,
    chapter: input.chapter,
    contentSha256: sha256Hex(input.content),
    start: input.start,
    end: input.start + trimmed.length,
    quote: trimmed,
    quoteSha256: sha256Hex(trimmed),
  });
}

export type SourceRefVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "content-hash-mismatch" | "quote-hash-mismatch" | "quote-offset-mismatch" };

/** Re-verify a SourceRef against current chapter content. */
export function verifySourceRef(ref: SourceRef, content: string): SourceRefVerification {
  if (sha256Hex(content) !== ref.contentSha256) {
    return { ok: false, reason: "content-hash-mismatch" };
  }
  if (sha256Hex(ref.quote) !== ref.quoteSha256) {
    return { ok: false, reason: "quote-hash-mismatch" };
  }
  if (content.slice(ref.start, ref.end) !== ref.quote) {
    return { ok: false, reason: "quote-offset-mismatch" };
  }
  return { ok: true };
}
