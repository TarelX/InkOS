/**
 * Checkpointed deep-deconstruction pipeline (Map → Reduce → Verify).
 *
 * Per-chapter results are checkpointed under `.inkos/analysis/` so a killed
 * process resumes from the last completed chapter and produces the same
 * output as an uninterrupted run (evaluation case A6). Consolidated results
 * are published as versioned artifacts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { ArtifactManifest } from "../artifacts/manifest.js";
import { analyzeScene, deterministicAnalyzer, type ChapterAnalysisModel } from "./chapter-analyzer.js";
import { heuristicJudge, linkCausally, type CausalJudge } from "./causal-linker.js";
import { resolveEntities } from "./entity-resolver.js";
import { buildPacingReport } from "./pacing-analyzer.js";
import type { Scene, StoryEvent } from "./schemas/scene-event.js";
import { buildSceneRecords, loadChapters, segmentScenes, type ParsedChapter } from "./source-parser.js";
import { buildStorylines } from "./storyline-builder.js";

export const ANALYSIS_ARTIFACTS = {
  scenes: "analysis.scenes",
  events: "analysis.events",
  entities: "analysis.entities",
  mergeProposals: "analysis.entity-merge-proposals",
  causalGraph: "analysis.causal-graph",
  storylines: "analysis.storylines",
  pacing: "analysis.pacing",
} as const;

interface ChapterCheckpoint {
  readonly chapter: number;
  readonly contentSha256: string;
  readonly scenes: Scene[];
  readonly events: StoryEvent[];
  readonly droppedQuotes: string[];
}

interface AnalysisProgress {
  completedChapters: number[];
  totalChapters: number;
  updatedAt: string;
}

export interface ChapterAnalysisOptions {
  readonly bookId: string;
  readonly bookDir: string;
  readonly store: ArtifactStore;
  readonly model?: ChapterAnalysisModel;
  readonly judge?: CausalJudge;
  readonly maxChapters?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { chapter: number; completed: number; total: number }) => void;
  readonly createdBy?: string;
  readonly runId?: string | null;
  readonly nodeId?: string | null;
  /**
   * true (default): publish accepted artifacts directly (standalone usage).
   * false: return payloads only — the workflow engine stages/publishes them
   * itself so gate + approval control artifact status (ADR-005).
   */
  readonly publish?: boolean;
  /**
   * Where per-chapter checkpoints live. Defaults to `bookDir` — adaptation
   * runs point this at the TARGET book so analyzing a source book leaves no
   * side effects in it (Source Freeze).
   */
  readonly checkpointDir?: string;
}

export interface AnalysisPayloads {
  readonly scenes: ReadonlyArray<Scene>;
  readonly events: ReadonlyArray<StoryEvent>;
  readonly entities: unknown;
  readonly mergeProposals: unknown;
  readonly causalGraph: unknown;
  readonly storylines: unknown;
  readonly pacing: unknown;
}

export interface ChapterAnalysisResult {
  readonly completedChapters: number;
  readonly totalChapters: number;
  readonly finished: boolean;
  readonly published: ReadonlyArray<ArtifactManifest>;
  readonly payloads: AnalysisPayloads | null;
}

function analysisDir(bookDir: string): string {
  return join(bookDir, ".inkos", "analysis");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}

async function loadCheckpoint(checkpointRoot: string, chapter: ParsedChapter): Promise<ChapterCheckpoint | null> {
  const checkpoint = await readJson<ChapterCheckpoint>(
    join(analysisDir(checkpointRoot), "chapters", `${String(chapter.number).padStart(4, "0")}.json`),
  );
  // Invalidate checkpoints when the chapter file changed since analysis.
  if (checkpoint && checkpoint.contentSha256 === chapter.contentSha256) return checkpoint;
  return null;
}

export async function runDeepAnalysis(options: ChapterAnalysisOptions): Promise<ChapterAnalysisResult> {
  const model = options.model ?? deterministicAnalyzer;
  const judge = options.judge ?? heuristicJudge;
  const checkpointRoot = options.checkpointDir ?? options.bookDir;
  const chapters = await loadChapters(options.bookDir);
  const limit = options.maxChapters ?? chapters.length;
  const progressPath = join(analysisDir(checkpointRoot), "progress.json");

  const checkpoints: ChapterCheckpoint[] = [];
  let processed = 0;
  for (const chapter of chapters) {
    if (options.signal?.aborted) break;

    let checkpoint = await loadCheckpoint(checkpointRoot, chapter);
    if (!checkpoint) {
      if (processed >= limit) break;
      const spans = segmentScenes(chapter.content);
      const scenes = buildSceneRecords(options.bookId, chapter, spans);
      const analyzedScenes: Scene[] = [];
      const events: StoryEvent[] = [];
      const droppedQuotes: string[] = [];
      for (const scene of scenes) {
        const result = await analyzeScene(options.bookId, chapter, scene, model);
        analyzedScenes.push(result.scene);
        events.push(...result.events);
        droppedQuotes.push(...result.droppedQuotes);
      }
      checkpoint = {
        chapter: chapter.number,
        contentSha256: chapter.contentSha256,
        scenes: analyzedScenes,
        events,
        droppedQuotes,
      };
      await writeJson(
        join(analysisDir(checkpointRoot), "chapters", `${String(chapter.number).padStart(4, "0")}.json`),
        checkpoint,
      );
      processed++;
    }
    checkpoints.push(checkpoint);
    const progress: AnalysisProgress = {
      completedChapters: checkpoints.map((c) => c.chapter),
      totalChapters: chapters.length,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(progressPath, progress);
    options.onProgress?.({ chapter: chapter.number, completed: checkpoints.length, total: chapters.length });
  }

  const finished = checkpoints.length === chapters.length && chapters.length > 0;
  const published: ArtifactManifest[] = [];
  let payloads: AnalysisPayloads | null = null;

  if (finished) {
    const scenes = checkpoints.flatMap((c) => c.scenes);
    const events = checkpoints.flatMap((c) => c.events);
    const { entities, proposals } = resolveEntities(options.bookId, events);
    const edges = await linkCausally(options.bookId, events, judge);
    const storylines = buildStorylines(options.bookId, events, edges);
    const pacing = buildPacingReport(options.bookId, scenes, events, storylines);
    payloads = {
      scenes,
      events,
      entities,
      mergeProposals: proposals,
      causalGraph: edges,
      storylines,
      pacing,
    };

    if (options.publish !== false) {
      const meta = {
        createdBy: options.createdBy ?? "deep-analysis",
        runId: options.runId ?? null,
        nodeId: options.nodeId ?? null,
      };
      const publishJson = async (artifactId: string, payload: unknown, projection?: { relPath: string; content: string }) => {
        published.push(
          await options.store.publish({
            artifactId,
            content: { "data.json": JSON.stringify(payload, null, 2) },
            projections: projection ? [projection] : [],
            status: "accepted",
            ...meta,
          }),
        );
      };

      await publishJson(ANALYSIS_ARTIFACTS.scenes, scenes);
      await publishJson(ANALYSIS_ARTIFACTS.events, events);
      await publishJson(ANALYSIS_ARTIFACTS.entities, entities, {
        relPath: join("story", "analysis", "entities.md"),
        content: projectEntitiesMarkdown(entities),
      });
      await publishJson(ANALYSIS_ARTIFACTS.mergeProposals, proposals);
      await publishJson(ANALYSIS_ARTIFACTS.causalGraph, edges);
      await publishJson(ANALYSIS_ARTIFACTS.storylines, storylines, {
        relPath: join("story", "analysis", "storylines.md"),
        content: projectStorylinesMarkdown(storylines),
      });
      await publishJson(ANALYSIS_ARTIFACTS.pacing, pacing);
    }
  }

  return {
    completedChapters: checkpoints.length,
    totalChapters: chapters.length,
    finished,
    published,
    payloads,
  };
}

function projectEntitiesMarkdown(entities: ReadonlyArray<{ canonicalName: string; chapterCount: number; firstChapter: number | null; status: string }>): string {
  const lines = ["# 实体表（V2 深度拆文）", ""];
  for (const entity of entities) {
    lines.push(`- ${entity.canonicalName} ｜ 出现 ${entity.chapterCount} 章 ｜ 首出场 第${entity.firstChapter ?? "?"}章 ｜ ${entity.status}`);
  }
  return `${lines.join("\n")}\n`;
}

function projectStorylinesMarkdown(storylines: ReadonlyArray<{ name: string; type: string; promise: string; eventIds: ReadonlyArray<string> }>): string {
  const lines = ["# 故事线（V2 深度拆文）", ""];
  for (const line of storylines) {
    lines.push(`## ${line.name}（${line.type}）`, "", `- Promise：${line.promise}`, `- 事件数：${line.eventIds.length}`, "");
  }
  return `${lines.join("\n")}\n`;
}
