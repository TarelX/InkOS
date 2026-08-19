/**
 * InkOS V2 API router 鈥?mounted under /api/v2 by createStudioServer.
 *
 * State truth lives in the project SQLite + artifact manifests (ADR-003):
 * every response here is derived from those, never from in-memory maps, so
 * browser refresh and server restart cannot lose run state.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { join } from "node:path";

import {
  buildRelationEvidence,
  deterministicRelations,
  extractCharacterRelations,
  type ChapterRecordLike,
} from "./relations.js";

import { createLLMClient, loadProjectConfig } from "@actalk/inkos-core";
import {
  ArtifactIndex,
  ArtifactStore,
  NEW_NOVEL_TEMPLATE,
  NOVEL_ADAPTATION_TEMPLATE,
  NOVEL_ANALYSIS_TEMPLATE,
  ProjectDB,
  RunRepository,
  WorkflowEngine,
  buildAdaptationRuntime,
  buildCreationRuntime,
  completionFromClient,
  createLLMAdaptationModels,
  loadProjectTemplates,
  mergeTemplates,
  type AdaptationModels,
  type CompletionFn,
} from "@actalk/inkos-core/v2";

export interface V2Runtime {
  readonly db: ProjectDB;
  readonly repo: RunRepository;
  readonly engine: WorkflowEngine;
  readonly storeForBook: (bookId: string) => ArtifactStore;
  readonly index: ArtifactIndex;
  /** 项目 LLM 可用时的补全函数（人物羁绊提取等轻量分析直接用）。 */
  readonly complete?: CompletionFn;
}

export async function createV2Runtime(root: string): Promise<V2Runtime> {
  const db = new ProjectDB(root);
  const repo = new RunRepository(db);
  const bookDirForId = (bookId: string) => join(root, "books", bookId);
  const storeForBook = (bookId: string) => new ArtifactStore(bookDirForId(bookId), bookId);

  // LLM hooks: use the project's configured model when available; otherwise
  // (or with INKOS_V2_LLM=0) the deterministic baselines keep the DAG usable.
  let models: AdaptationModels | undefined;
  let complete: CompletionFn | undefined;
  if (process.env.INKOS_V2_LLM !== "0") {
    try {
      const config = await loadProjectConfig(root);
      if (config?.llm?.model) {
        const client = createLLMClient(config.llm);
        complete = completionFromClient({ client, model: config.llm.model });
        models = createLLMAdaptationModels(complete);
      }
    } catch (err) {
      console.warn("[v2] LLM config unavailable, using deterministic executors:", err instanceof Error ? err.message : err);
    }
  }

  // 改编与原创两条管线共用一台引擎：executor 名字空间不重叠（adapt.* / novel.*）。
  const adaptation = buildAdaptationRuntime({ bookDirForId, models });
  const creation = buildCreationRuntime({ bookDirForId, models: { complete } });
  const executors = new Map([...adaptation.executors, ...creation.executors]);
  const gates = new Map([...adaptation.gates, ...creation.gates]);
  const engine = new WorkflowEngine({ repo, storeForBook, executors, gates });

  const overrides = await loadProjectTemplates(root).catch(() => []);
  for (const template of mergeTemplates([NOVEL_ADAPTATION_TEMPLATE, NEW_NOVEL_TEMPLATE, NOVEL_ANALYSIS_TEMPLATE], overrides)) {
    try {
      engine.registerTemplate(template);
    } catch (err) {
      // A broken user override must not take the server down.
      console.error(`[v2] skipping invalid workflow template ${template.id}:`, err);
    }
  }
  // Crash recovery: running 鈫?interrupted, idempotent nodes requeued.
  engine.recover();
  return { db, repo, engine, storeForBook, index: new ArtifactIndex(db), complete };
}

/** Fire-and-forget DAG pump; errors land in workflow_events, not the process. */
function pump(runtime: V2Runtime, runId: string): void {
  void runtime.engine.runToCompletion(runId).catch((err) => {
    runtime.repo.appendEvent(runId, null, "workflow.pump.error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function createV2Router(root: string, runtimePromise?: Promise<V2Runtime>): Hono {
  // LAZY init: the SQLite handle opens on the first /api/v2 request, not at
  // server construction 鈥?otherwise every studio test that tears down a temp
  // project dir hits Windows EBUSY on the open WAL files.
  let readyPromise: Promise<V2Runtime> | null = runtimePromise ?? null;
  const ready = (): Promise<V2Runtime> => (readyPromise ??= createV2Runtime(root));
  const app = new Hono();

  app.get("/health", async (c) => {
    const runtime = await ready();
    return c.json({ ok: true, dbPath: runtime.db.path, templates: runtime.engine.listTemplates().map((t) => t.template.id) });
  });

  app.get("/templates", async (c) => {
    const runtime = await ready();
    return c.json(
      runtime.engine.listTemplates().map(({ template, order }) => ({
        id: template.id,
        version: template.version,
        label: template.label,
        order,
        nodes: template.nodes.map((n) => ({
          id: n.id,
          label: n.label || n.id,
          executor: n.executor,
          dependsOn: n.dependsOn,
          approvalRequired: n.approval.required,
          gate: n.gate?.evaluator ?? null,
        })),
      })),
    );
  });

  app.post("/books/:bookId/runs", async (c) => {
    const runtime = await ready();
    const bookId = c.req.param("bookId");
    const body = (await c.req.json().catch(() => ({}))) as { templateId?: string; params?: Record<string, unknown> };
    const templateId = body.templateId ?? "novel-adaptation";
    try {
      const run = runtime.engine.createRun(templateId, bookId, body.params ?? {});
      pump(runtime, run.runId);
      return c.json(run, 201);
    } catch (err) {
      return c.json({ error: { code: "run_create_failed", message: err instanceof Error ? err.message : String(err) } }, 400);
    }
  });

  app.get("/runs", async (c) => {
    const runtime = await ready();
    const bookId = c.req.query("bookId") ?? undefined;
    return c.json(runtime.repo.listRuns(bookId));
  });

  app.get("/runs/:runId", async (c) => {
    const runtime = await ready();
    const runId = c.req.param("runId");
    const run = runtime.repo.getRun(runId);
    if (!run) return c.json({ error: { code: "not_found", message: runId } }, 404);
    const nodes = runtime.repo.listNodes(runId);
    const approvals = nodes
      .filter((n) => n.status === "waiting_approval")
      .map((n) => runtime.repo.pendingApprovalFor(runId, n.nodeId))
      .filter(Boolean);
    return c.json({ run, nodes, approvals });
  });

  app.post("/runs/:runId/nodes/:nodeId/retry", async (c) => {
    const runtime = await ready();
    const { runId, nodeId } = c.req.param();
    try {
      runtime.engine.retryNode(runId, nodeId);
      pump(runtime, runId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { code: "retry_failed", message: err instanceof Error ? err.message : String(err) } }, 400);
    }
  });

  app.post("/runs/:runId/cancel", async (c) => {
    const runtime = await ready();
    runtime.engine.cancelRun(c.req.param("runId"));
    return c.json({ ok: true });
  });

  app.post("/runs/:runId/stale-sweep", async (c) => {
    const runtime = await ready();
    const stale = await runtime.engine.markStale(c.req.param("runId"));
    return c.json({ stale });
  });

  app.post("/approvals/:approvalId/approve", async (c) => {
    const runtime = await ready();
    const body = (await c.req.json().catch(() => ({}))) as { by?: string; note?: string };
    const approval = runtime.repo.getApproval(c.req.param("approvalId"));
    try {
      await runtime.engine.approve(c.req.param("approvalId"), body.by ?? "creator", body.note ?? "");
      if (approval) pump(runtime, approval.runId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { code: "approve_failed", message: err instanceof Error ? err.message : String(err) } }, 400);
    }
  });

  app.post("/approvals/:approvalId/reject", async (c) => {
    const runtime = await ready();
    const body = (await c.req.json().catch(() => ({}))) as { by?: string; note?: string };
    try {
      await runtime.engine.reject(c.req.param("approvalId"), body.by ?? "creator", body.note ?? "");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { code: "reject_failed", message: err instanceof Error ? err.message : String(err) } }, 400);
    }
  });

  // Reliable SSE: replays persisted events after Last-Event-ID, then polls.
  app.get("/runs/:runId/events", async (c) => {
    const runtime = await ready();
    const runId = c.req.param("runId");
    const fromHeader = Number(c.req.header("Last-Event-ID") ?? NaN);
    const fromQuery = Number(c.req.query("after") ?? NaN);
    let cursor = Number.isFinite(fromHeader) ? fromHeader : Number.isFinite(fromQuery) ? fromQuery : 0;

    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      while (open) {
        const events = runtime.repo.listEvents(runId, cursor);
        for (const event of events) {
          cursor = event.seq;
          await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
        }
        const run = runtime.repo.getRun(runId);
        if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) {
          await stream.writeSSE({ event: "workflow.stream.end", data: JSON.stringify({ status: run?.status ?? "gone" }) });
          break;
        }
        await stream.sleep(700);
      }
    });
  });

  app.get("/books/:bookId/artifacts", async (c) => {
    const runtime = await ready();
    const store = runtime.storeForBook(c.req.param("bookId"));
    const rows = [];
    for (const artifactId of await store.listArtifactIds()) {
      for (const version of await store.listVersions(artifactId)) {
        const manifest = await store.getManifest(artifactId, version);
        if (manifest) {
          rows.push({
            artifactId,
            version,
            status: manifest.status,
            createdAt: manifest.createdAt,
            createdBy: manifest.createdBy,
            runId: manifest.runId,
            nodeId: manifest.nodeId,
            schemaId: manifest.schemaId,
            files: Object.keys(manifest.files),
          });
        }
      }
    }
    return c.json(rows);
  });

  app.get("/books/:bookId/artifacts/:artifactId/latest", async (c) => {
    const runtime = await ready();
    const store = runtime.storeForBook(c.req.param("bookId"));
    const status = c.req.query("status") as "accepted" | "draft" | undefined;
    const manifest = await store.latest(c.req.param("artifactId"), { status: status ?? "any" });
    if (!manifest) return c.json({ error: { code: "not_found", message: c.req.param("artifactId") } }, 404);
    return c.json(manifest);
  });

  app.get("/books/:bookId/artifacts/:artifactId/:version/content", async (c) => {
    const runtime = await ready();
    const store = runtime.storeForBook(c.req.param("bookId"));
    const file = c.req.query("file") ?? "data.json";
    try {
      const content = await store.readContent(c.req.param("artifactId"), Number(c.req.param("version")), file);
      return file.endsWith(".json") ? c.json(JSON.parse(content)) : c.text(content);
    } catch (err) {
      return c.json({ error: { code: "not_found", message: err instanceof Error ? err.message : String(err) } }, 404);
    }
  });

  // 人物羁绊提取：拆解记录 → 人物对证据 → LLM 关系分类 → analysis.character-relations。
  // 数据源优先 V1 全书拆解（356 章级证据）；将来 V2 深度拆文的事件参与者同样适用。
  app.post("/books/:bookId/relations/extract", async (c) => {
    const runtime = await ready();
    const bookId = c.req.param("bookId");
    const store = runtime.storeForBook(bookId);
    const latest = await store.latest("v1-import.deconstruct");
    if (!latest) {
      return c.json({
        error: { code: "no_source", message: "本书没有拆解数据（v1-import.deconstruct）。先导入 V1 拆解或跑深度拆文。" },
      }, 400);
    }
    let records: ChapterRecordLike[] = [];
    try {
      const doc = JSON.parse(await store.readContent("v1-import.deconstruct", latest.version, "data.json")) as {
        chapterRecords?: ChapterRecordLike[];
      };
      records = Array.isArray(doc.chapterRecords) ? doc.chapterRecords : [];
    } catch (err) {
      return c.json({ error: { code: "bad_source", message: err instanceof Error ? err.message : String(err) } }, 500);
    }
    const pairs = buildRelationEvidence(records);
    if (pairs.length === 0) {
      return c.json({ error: { code: "no_pairs", message: "拆解记录里没有可配对的人物共现。" } }, 400);
    }
    let relations;
    let source: "llm" | "deterministic" = "llm";
    let llmError: string | undefined;
    if (runtime.complete) {
      try {
        relations = await extractCharacterRelations({ complete: runtime.complete, pairs });
      } catch (err) {
        source = "deterministic";
        llmError = err instanceof Error ? err.message : String(err);
        relations = deterministicRelations(pairs);
      }
    } else {
      source = "deterministic";
      relations = deterministicRelations(pairs);
    }
    const manifest = await store.publish({
      artifactId: "analysis.character-relations",
      createdBy: source === "llm" ? "relations.extract.llm" : "relations.extract.deterministic",
      content: {
        "data.json": JSON.stringify({
          source,
          ...(llmError ? { llmError } : {}),
          extractedAt: new Date().toISOString(),
          relations,
        }, null, 2),
      },
      schemaId: "character-relations.v1",
      status: "draft",
      note: `人物羁绊提取（${source}${llmError ? "，LLM 失败已退化" : ""}）`,
    });
    return c.json({ ok: true, version: manifest.version, count: relations.length, source, ...(llmError ? { llmError } : {}) });
  });

  return app;
}
