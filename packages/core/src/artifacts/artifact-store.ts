/**
 * Versioned, append-only artifact store under `books/<bookId>/.inkos/artifacts`.
 *
 * Layout:
 *   .inkos/artifacts/<artifactId>/v000001/manifest.json
 *   .inkos/artifacts/<artifactId>/v000001/<content files>
 *
 * Publishing is atomic: content is staged into a temp dir and renamed into
 * place; manifest.json is written last, so a version without a manifest is
 * garbage by definition and ignored by readers.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../story-intelligence/ids.js";
import {
  ArtifactManifestSchema,
  type ArtifactInput,
  type ArtifactManifest,
  type ArtifactStatus,
} from "./manifest.js";

const VERSION_DIR_RE = /^v(\d{6})$/;

function versionDirName(version: number): string {
  return `v${String(version).padStart(6, "0")}`;
}

export interface PublishInput {
  readonly artifactId: string;
  readonly createdBy: string;
  /** File name → UTF-8 content. Must contain at least one file. */
  readonly content: Readonly<Record<string, string>>;
  readonly inputs?: ReadonlyArray<ArtifactInput>;
  readonly runId?: string | null;
  readonly nodeId?: string | null;
  readonly schemaId?: string | null;
  /**
   * Human-readable projections, written relative to the book dir
   * (e.g. `story/analysis/story-spine.md`). Overwritten on each publish.
   */
  readonly projections?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly status?: ArtifactStatus;
  readonly note?: string;
}

export class ArtifactStore {
  private readonly root: string;

  constructor(private readonly bookDir: string, private readonly bookId: string) {
    this.root = join(bookDir, ".inkos", "artifacts");
  }

  get rootDir(): string {
    return this.root;
  }

  private artifactDir(artifactId: string): string {
    return join(this.root, artifactId);
  }

  versionDir(artifactId: string, version: number): string {
    return join(this.artifactDir(artifactId), versionDirName(version));
  }

  async listVersions(artifactId: string): Promise<ReadonlyArray<number>> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.artifactDir(artifactId));
    } catch {
      return [];
    }
    const versions: number[] = [];
    for (const entry of entries) {
      const m = VERSION_DIR_RE.exec(entry);
      if (!m) continue;
      // A version only counts once its manifest landed (publish order guarantee).
      try {
        await readFile(join(this.artifactDir(artifactId), entry, "manifest.json"), "utf-8");
        versions.push(Number(m[1]));
      } catch {
        // staging leftovers / crashed publish — invisible to readers
      }
    }
    return versions.sort((a, b) => a - b);
  }

  async listArtifactIds(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  async getManifest(artifactId: string, version: number): Promise<ArtifactManifest | null> {
    try {
      const raw = await readFile(join(this.versionDir(artifactId, version), "manifest.json"), "utf-8");
      return ArtifactManifestSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async latest(
    artifactId: string,
    options: { readonly status?: ArtifactStatus | "any" } = {},
  ): Promise<ArtifactManifest | null> {
    const wanted = options.status ?? "any";
    const versions = await this.listVersions(artifactId);
    for (let i = versions.length - 1; i >= 0; i--) {
      const manifest = await this.getManifest(artifactId, versions[i]);
      if (!manifest) continue;
      if (wanted === "any" || manifest.status === wanted) return manifest;
    }
    return null;
  }

  async readContent(artifactId: string, version: number, fileName: string): Promise<string> {
    const manifest = await this.getManifest(artifactId, version);
    if (!manifest) throw new Error(`artifact ${artifactId} v${version} not found`);
    const expected = manifest.files[fileName];
    if (!expected) throw new Error(`artifact ${artifactId} v${version} has no file ${fileName}`);
    const content = await readFile(join(this.versionDir(artifactId, version), fileName), "utf-8");
    if (sha256Hex(content) !== expected) {
      throw new Error(`artifact ${artifactId} v${version}/${fileName} content hash mismatch`);
    }
    return content;
  }

  async publish(input: PublishInput): Promise<ArtifactManifest> {
    const fileNames = Object.keys(input.content);
    if (fileNames.length === 0) throw new Error("publish requires at least one content file");
    if (fileNames.includes("manifest.json")) throw new Error("manifest.json is a reserved file name");

    await mkdir(this.artifactDir(input.artifactId), { recursive: true });

    // Allocate the next version; retry on rename collision (concurrent publish).
    for (let attempt = 0; attempt < 5; attempt++) {
      const versions = await this.listVersions(input.artifactId);
      const version = (versions[versions.length - 1] ?? 0) + 1 + attempt;
      const finalDir = this.versionDir(input.artifactId, version);
      const stagingDir = `${finalDir}.staging-${process.pid}-${Date.now()}`;

      await mkdir(stagingDir, { recursive: true });
      const files: Record<string, string> = {};
      for (const name of fileNames) {
        const body = input.content[name];
        await writeFile(join(stagingDir, name), body, "utf-8");
        files[name] = sha256Hex(body);
      }

      try {
        await rename(stagingDir, finalDir);
      } catch {
        await rm(stagingDir, { recursive: true, force: true });
        continue; // someone else took this version number
      }

      const now = new Date().toISOString();
      const status = input.status ?? "draft";
      const manifest = ArtifactManifestSchema.parse({
        manifestVersion: 1,
        artifactId: input.artifactId,
        version,
        bookId: this.bookId,
        createdAt: now,
        createdBy: input.createdBy,
        runId: input.runId ?? null,
        nodeId: input.nodeId ?? null,
        inputs: [...(input.inputs ?? [])],
        files,
        schemaId: input.schemaId ?? null,
        projections: (input.projections ?? []).map((p) => p.relPath),
        status,
        statusHistory: [{ status, at: now, by: input.createdBy, note: input.note ?? "" }],
      });

      for (const projection of input.projections ?? []) {
        const target = join(this.bookDir, projection.relPath);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, projection.content, "utf-8");
      }

      // Manifest lands last: readers never observe a manifest-less "published" version.
      await writeFile(join(finalDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
      return manifest;
    }
    throw new Error(`publish contention on artifact ${input.artifactId}: exhausted retries`);
  }

  async setStatus(
    artifactId: string,
    version: number,
    status: ArtifactStatus,
    by: string,
    note = "",
  ): Promise<ArtifactManifest> {
    const manifest = await this.getManifest(artifactId, version);
    if (!manifest) throw new Error(`artifact ${artifactId} v${version} not found`);
    const updated: ArtifactManifest = {
      ...manifest,
      status,
      statusHistory: [...manifest.statusHistory, { status, at: new Date().toISOString(), by, note }],
    };
    await writeFile(
      join(this.versionDir(artifactId, version), "manifest.json"),
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf-8",
    );
    return updated;
  }

  /**
   * A manifest is stale when any pinned input has a newer *accepted* version.
   * (Draft/rejected upstream versions do not invalidate downstream outputs.)
   */
  async isStale(manifest: ArtifactManifest): Promise<boolean> {
    for (const input of manifest.inputs) {
      const latestAccepted = await this.latest(input.artifactId, { status: "accepted" });
      if (latestAccepted && latestAccepted.version > input.version) return true;
    }
    return false;
  }
}
