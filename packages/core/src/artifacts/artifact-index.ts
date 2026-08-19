/**
 * SQLite acceleration index over artifact manifests.
 * Fully rebuildable: `rebuildForBook` rescans manifests on disk and replaces
 * every row for that book, so a lost/corrupt DB never loses content truth.
 */

import type { ProjectDB } from "../v2/project-db.js";
import type { ArtifactManifest, ArtifactStatus } from "./manifest.js";
import type { ArtifactStore } from "./artifact-store.js";

export interface ArtifactIndexRow {
  readonly bookId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly status: ArtifactStatus;
  readonly schemaId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly runId: string | null;
  readonly nodeId: string | null;
}

export class ArtifactIndex {
  constructor(private readonly projectDb: ProjectDB) {}

  upsert(manifest: ArtifactManifest): void {
    this.projectDb.db
      .prepare(
        `INSERT INTO artifact_index
           (book_id, artifact_id, version, status, schema_id, created_at, created_by, run_id, node_id, inputs_json, files_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (book_id, artifact_id, version) DO UPDATE SET
           status = excluded.status,
           schema_id = excluded.schema_id,
           inputs_json = excluded.inputs_json,
           files_json = excluded.files_json`,
      )
      .run(
        manifest.bookId,
        manifest.artifactId,
        manifest.version,
        manifest.status,
        manifest.schemaId,
        manifest.createdAt,
        manifest.createdBy,
        manifest.runId,
        manifest.nodeId,
        JSON.stringify(manifest.inputs),
        JSON.stringify(manifest.files),
      );
  }

  latest(bookId: string, artifactId: string, status?: ArtifactStatus): ArtifactIndexRow | null {
    const sql = status
      ? `SELECT * FROM artifact_index WHERE book_id = ? AND artifact_id = ? AND status = ? ORDER BY version DESC LIMIT 1`
      : `SELECT * FROM artifact_index WHERE book_id = ? AND artifact_id = ? ORDER BY version DESC LIMIT 1`;
    const args = status ? [bookId, artifactId, status] : [bookId, artifactId];
    const row = this.projectDb.db.prepare(sql).get(...args);
    return row ? mapRow(row) : null;
  }

  listForBook(bookId: string): ReadonlyArray<ArtifactIndexRow> {
    return this.projectDb.db
      .prepare(`SELECT * FROM artifact_index WHERE book_id = ? ORDER BY artifact_id, version`)
      .all(bookId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((row: any) => mapRow(row));
  }

  /** Rescan disk manifests and replace all rows for the book. */
  async rebuildForBook(bookId: string, store: ArtifactStore): Promise<number> {
    const manifests: ArtifactManifest[] = [];
    for (const artifactId of await store.listArtifactIds()) {
      for (const version of await store.listVersions(artifactId)) {
        const manifest = await store.getManifest(artifactId, version);
        if (manifest) manifests.push(manifest);
      }
    }
    const db = this.projectDb.db;
    db.exec("BEGIN");
    try {
      db.prepare(`DELETE FROM artifact_index WHERE book_id = ?`).run(bookId);
      for (const manifest of manifests) this.upsert(manifest);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return manifests.length;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): ArtifactIndexRow {
  return {
    bookId: String(row.book_id),
    artifactId: String(row.artifact_id),
    version: Number(row.version),
    status: String(row.status) as ArtifactStatus,
    schemaId: row.schema_id == null ? null : String(row.schema_id),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    runId: row.run_id == null ? null : String(row.run_id),
    nodeId: row.node_id == null ? null : String(row.node_id),
  };
}
