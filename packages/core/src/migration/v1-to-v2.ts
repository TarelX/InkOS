/**
 * V1 → V2 migration: scan → dry-run → migrate → verify（只增不改）.
 *
 * Hard rules (docs/v2/08-v1-to-v2-migration.md):
 * - NEVER modifies V1 truth: chapters, story/outline, story/roles,
 *   story/state, story/deconstruct, story/workflow.json stay byte-identical;
 * - V2 writes only into `books/<id>/.inkos/artifacts` (+ project SQLite);
 * - V1 拆文库 imports as a candidate artifact tagged `provenance: v1-import`
 *   — it lacks verifiable SourceRefs, so V2 re-analysis stays the truth path;
 * - the ORIGINAL library refuses to migrate until a sandbox run verified OK.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactStore } from "../artifacts/artifact-store.js";
import { sha256Hex } from "../story-intelligence/ids.js";

export const V1_IMPORT_ARTIFACT = "v1-import.deconstruct";
const SANDBOX_MARKER = join(".inkos", "migration-sandbox-ok.json");

export interface BookScan {
  readonly bookId: string;
  readonly chapterFiles: ReadonlyArray<string>;
  /** relPath → sha256 — the invariant that must survive migration (D1). */
  readonly chapterHashes: Readonly<Record<string, string>>;
  readonly deconstructChapterCount: number;
  readonly hasDeconstruct: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export async function scanV1Book(booksRoot: string, bookId: string): Promise<BookScan> {
  const bookDir = join(booksRoot, bookId);
  const warnings: string[] = [];
  const chapterHashes: Record<string, string> = {};
  const chapterFiles: string[] = [];
  try {
    for (const file of (await readdir(join(bookDir, "chapters"))).sort()) {
      if (!/\.md$/i.test(file)) continue;
      const rel = `chapters/${file}`;
      chapterFiles.push(rel);
      chapterHashes[rel] = sha256Hex(await readFile(join(bookDir, rel)));
    }
  } catch {
    warnings.push("没有 chapters 目录");
  }

  let deconstructChapterCount = 0;
  let hasDeconstruct = false;
  try {
    const files = await readdir(join(bookDir, "story", "deconstruct", "chapters"));
    deconstructChapterCount = files.filter((f) => /^\d{4}\.json$/.test(f)).length;
    hasDeconstruct = deconstructChapterCount > 0;
  } catch {
    // no V1 deconstruct library
  }

  return { bookId, chapterFiles, chapterHashes, deconstructChapterCount, hasDeconstruct, warnings };
}

export interface DryRunReport {
  readonly projectRoot: string;
  readonly books: ReadonlyArray<BookScan>;
  readonly sandboxVerified: boolean;
}

export async function dryRun(projectRoot: string): Promise<DryRunReport> {
  const booksRoot = join(projectRoot, "books");
  let ids: string[] = [];
  try {
    ids = (await readdir(booksRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // empty project
  }
  const books = [];
  for (const id of ids) books.push(await scanV1Book(booksRoot, id));
  return { projectRoot, books, sandboxVerified: await isSandboxVerified(projectRoot) };
}

export async function isSandboxVerified(projectRoot: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(projectRoot, SANDBOX_MARKER), "utf-8"));
    return Boolean(marker?.verifiedAt);
  } catch {
    return false;
  }
}

export interface MigrateBookResult {
  readonly bookId: string;
  readonly imported: boolean;
  readonly skippedReason: string | null;
  readonly artifactVersion: number | null;
  /** D1: every chapter hash must equal its pre-migration value. */
  readonly chapterHashesIntact: boolean;
}

export interface MigrateProjectOptions {
  readonly projectRoot: string;
  /**
   * "sandbox": run on a copy; success writes the sandbox-ok marker.
   * "original": refuses to run unless a sandbox run verified OK (D3).
   */
  readonly mode: "sandbox" | "original";
}

export async function migrateProject(options: MigrateProjectOptions): Promise<ReadonlyArray<MigrateBookResult>> {
  const { projectRoot, mode } = options;
  if (mode === "original" && !(await isSandboxVerified(projectRoot))) {
    throw new Error("拒绝迁移原书库：尚未通过沙箱验证。先在书库副本上运行 mode=sandbox 并确认结果。");
  }

  const report = await dryRun(projectRoot);
  const results: MigrateBookResult[] = [];
  for (const scan of report.books) {
    results.push(await migrateBook(projectRoot, scan));
  }

  const allIntact = results.every((r) => r.chapterHashesIntact);
  if (!allIntact) {
    throw new Error(
      `迁移校验失败：正文哈希发生变化 —— ${results.filter((r) => !r.chapterHashesIntact).map((r) => r.bookId).join(", ")}`,
    );
  }
  if (mode === "sandbox") {
    await mkdir(join(projectRoot, ".inkos"), { recursive: true });
    await writeFile(
      join(projectRoot, SANDBOX_MARKER),
      `${JSON.stringify({ verifiedAt: new Date().toISOString(), books: results.length }, null, 2)}\n`,
      "utf-8",
    );
  }
  return results;
}

async function migrateBook(projectRoot: string, scan: BookScan): Promise<MigrateBookResult> {
  const booksRoot = join(projectRoot, "books");
  const bookDir = join(booksRoot, scan.bookId);

  if (!scan.hasDeconstruct) {
    return {
      bookId: scan.bookId,
      imported: false,
      skippedReason: "无 V1 拆文库",
      artifactVersion: null,
      chapterHashesIntact: await verifyChapterHashes(bookDir, scan),
    };
  }

  // Collect the V1 deconstruct library into one candidate payload.
  const deconstructDir = join(bookDir, "story", "deconstruct");
  const chapters: unknown[] = [];
  for (const file of (await readdir(join(deconstructDir, "chapters"))).sort()) {
    if (!/^\d{4}\.json$/.test(file)) continue;
    try {
      chapters.push(JSON.parse(await readFile(join(deconstructDir, "chapters", file), "utf-8")));
    } catch {
      // skip corrupt chapter records; the report notes count differences
    }
  }
  const characters: Record<string, string> = {};
  try {
    for (const file of (await readdir(join(deconstructDir, "characters"))).sort()) {
      if (!file.endsWith(".md")) continue;
      characters[file] = await readFile(join(deconstructDir, "characters", file), "utf-8");
    }
  } catch {
    // no character cards
  }

  const payload = {
    provenance: "v1-import",
    note: "V1 拆文库导入：无可校验 SourceRef，仅作参考；V2 深度拆文才是真源。",
    importedAt: new Date().toISOString(),
    chapterRecords: chapters,
    characterCards: characters,
  };
  const payloadChecksum = sha256Hex(JSON.stringify({ chapters, characters }));

  const store = new ArtifactStore(bookDir, scan.bookId);
  // Idempotency: same V1 content → no new version.
  const latest = await store.latest(V1_IMPORT_ARTIFACT);
  if (latest) {
    try {
      const existing = JSON.parse(await store.readContent(V1_IMPORT_ARTIFACT, latest.version, "data.json"));
      const existingChecksum = sha256Hex(
        JSON.stringify({ chapters: existing.chapterRecords, characters: existing.characterCards }),
      );
      if (existingChecksum === payloadChecksum) {
        return {
          bookId: scan.bookId,
          imported: false,
          skippedReason: "已导入且内容未变化",
          artifactVersion: latest.version,
          chapterHashesIntact: await verifyChapterHashes(bookDir, scan),
        };
      }
    } catch {
      // unreadable previous import → publish a fresh version
    }
  }

  const manifest = await store.publish({
    artifactId: V1_IMPORT_ARTIFACT,
    createdBy: "migration.v1-to-v2",
    content: { "data.json": JSON.stringify(payload, null, 2) },
    schemaId: "v1-deconstruct.v1",
    status: "draft", // candidate-grade: never auto-accepted
    note: "provenance: v1-import",
  });

  return {
    bookId: scan.bookId,
    imported: true,
    skippedReason: null,
    artifactVersion: manifest.version,
    chapterHashesIntact: await verifyChapterHashes(bookDir, scan),
  };
}

async function verifyChapterHashes(bookDir: string, scan: BookScan): Promise<boolean> {
  for (const rel of scan.chapterFiles) {
    try {
      if (sha256Hex(await readFile(join(bookDir, rel))) !== scan.chapterHashes[rel]) return false;
    } catch {
      return false;
    }
  }
  return true;
}
