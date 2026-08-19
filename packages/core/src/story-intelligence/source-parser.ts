/**
 * Deterministic source parsing: chapter loading, normalization, hashing and
 * rule-based scene segmentation. LLMs may refine scene boundaries later, but
 * offsets/hashes always come from this parser so SourceRefs stay verifiable.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex, sceneId } from "./ids.js";
import type { Scene } from "./schemas/scene-event.js";

export interface ParsedChapter {
  readonly number: number;
  readonly title: string;
  /** Path relative to the book dir (used in SourceRef.chapterFile). */
  readonly relPath: string;
  /** Raw file content — the hash domain for every SourceRef offset. */
  readonly content: string;
  readonly contentSha256: string;
}

const CHAPTER_FILE_RE = /^(\d{4})_(.+)\.md$/i;

/** V1-compatible chapter listing: `chapters/NNNN_title.md`. */
export async function loadChapters(bookDir: string): Promise<ReadonlyArray<ParsedChapter>> {
  const chaptersDir = join(bookDir, "chapters");
  let files: string[] = [];
  try {
    files = await readdir(chaptersDir);
  } catch {
    return [];
  }
  const parsed: ParsedChapter[] = [];
  for (const file of files.sort()) {
    const m = CHAPTER_FILE_RE.exec(file);
    if (!m) continue;
    const content = await readFile(join(chaptersDir, file), "utf-8");
    parsed.push({
      number: Number(m[1]),
      title: m[2],
      relPath: `chapters/${file}`,
      content,
      contentSha256: sha256Hex(content),
    });
  }
  return parsed;
}

export interface SceneSpan {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Rule-based scene segmentation:
 * - explicit separators (blank line runs, `***`, `———`) are hard boundaries;
 * - a soft boundary is inserted when a span exceeds maxLen at the nearest
 *   paragraph break, so downstream analysis never sees unbounded spans.
 */
export function segmentScenes(content: string, options: { maxLen?: number } = {}): ReadonlyArray<SceneSpan> {
  const maxLen = options.maxLen ?? 3200;
  if (content.trim().length === 0) return [];

  const hardBoundary = /\n\s*(?:\*{3,}|—{3,}|-{3,}|＊{3,})\s*\n|\n{3,}/g;
  const hardCuts: number[] = [0];
  let m: RegExpExecArray | null;
  while ((m = hardBoundary.exec(content))) {
    hardCuts.push(m.index + m[0].length);
  }
  hardCuts.push(content.length);

  const spans: SceneSpan[] = [];
  for (let i = 0; i < hardCuts.length - 1; i++) {
    let start = hardCuts[i];
    const end = hardCuts[i + 1];
    if (content.slice(start, end).trim().length === 0) continue;
    while (end - start > maxLen) {
      // Prefer the last paragraph break inside the budget window.
      const window = content.slice(start, start + maxLen);
      const breakAt = window.lastIndexOf("\n");
      const cut = breakAt > maxLen * 0.3 ? start + breakAt + 1 : start + maxLen;
      spans.push({ index: spans.length, start, end: cut });
      start = cut;
    }
    spans.push({ index: spans.length, start, end });
  }
  return spans;
}

export function buildSceneRecords(bookId: string, chapter: ParsedChapter, spans: ReadonlyArray<SceneSpan>): Scene[] {
  return spans.map((span) => ({
    id: sceneId(bookId, chapter.contentSha256, chapter.number, span.index),
    bookId,
    chapter: chapter.number,
    index: span.index,
    start: span.start,
    end: span.end,
    contentSha256: chapter.contentSha256,
    purpose: [],
    dramaticQuestion: null,
    turningPoint: null,
    entryState: {},
    exitState: {},
    eventIds: [],
    pace: { density: 0, repetition: 0, exposition: 0 },
    status: "candidate" as const,
  }));
}
