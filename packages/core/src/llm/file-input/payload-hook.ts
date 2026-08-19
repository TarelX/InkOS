/**
 * Native file injection via pi-ai's onPayload hook（V1 patch-rich-attachments 移植）。
 *
 * 走「原生」通道的附件在用户消息文本里留下一个 marker token。因为 provider
 * payload 每轮都会从完整消息历史重建，marker（而非某轮的注册表）才是持久
 * 事实源：这个 hook 在每次发送前重扫最终 payload，剥掉 marker，并按目标 API
 * 的形状追加真实文件块。恢复的会话也照常工作，因为 marker 携带项目相对路径。
 */
import { readFile, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { ModelLike } from "./capability.js";

export const NATIVE_FILE_MARKER_RE = /\u27e6INKOS_FILE:([A-Za-z0-9+/=]+)\u27e7/g;

export interface NativeFileMeta {
  /** project-relative path */
  p: string;
  /** mime type */
  m: string;
  /** display filename */
  n?: string;
}

export interface PayloadHookCtx {
  readonly projectRoot: string;
  readonly cursorMode?: string;
  readonly service?: string;
  readonly baseUrl?: string;
}

export function encodeNativeFileMarker(meta: NativeFileMeta): string {
  const payload = Buffer.from(JSON.stringify(meta), "utf-8").toString("base64");
  return `\u27e6INKOS_FILE:${payload}\u27e7`;
}

function decodeNativeFileMarker(encoded: string): NativeFileMeta | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as NativeFileMeta | null;
    if (parsed && typeof parsed.p === "string" && typeof parsed.m === "string") return parsed;
  } catch { /* malformed marker */ }
  return null;
}

interface CachedFile { base64: string; buffer: Buffer; size: number }
const fileCache = new Map<string, CachedFile>();
const FILE_CACHE_MAX = 8;

async function loadNativeFile(projectRoot: string, meta: NativeFileMeta): Promise<CachedFile> {
  const abs = resolve(projectRoot, meta.p);
  const rootAbs = resolve(projectRoot);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`附件路径越界: ${meta.p}`);
  }
  const info = await stat(abs);
  const cacheKey = `${abs}|${info.mtimeMs}|${info.size}`;
  const cached = fileCache.get(cacheKey);
  if (cached) return cached;
  const buffer = await readFile(abs);
  const entry: CachedFile = { base64: buffer.toString("base64"), buffer, size: info.size };
  fileCache.set(cacheKey, entry);
  if (fileCache.size > FILE_CACHE_MAX) {
    const firstKey = fileCache.keys().next().value;
    if (firstKey !== undefined) fileCache.delete(firstKey);
  }
  return entry;
}

function scanMarkers(text: string): { stripped: string; files: NativeFileMeta[] } {
  const files: NativeFileMeta[] = [];
  const stripped = String(text).replace(NATIVE_FILE_MARKER_RE, (_match, encoded: string) => {
    const meta = decodeNativeFileMarker(encoded);
    if (meta) {
      files.push(meta);
      return `[原生附件已随本条消息发送: ${meta.n ?? meta.p}]`;
    }
    return "";
  });
  return { stripped, files };
}

function sanitizeDocName(name: string | undefined): string {
  const cleaned = String(name ?? "document")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9\u4e00-\u9fff \-()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "document";
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- per-protocol block builders -----------------------------------------

async function buildParts(
  projectRoot: string,
  files: NativeFileMeta[],
  notes: string[],
  build: (meta: NativeFileMeta, file: CachedFile) => any,
): Promise<any[]> {
  const parts: any[] = [];
  for (const meta of files) {
    try {
      const file = await loadNativeFile(projectRoot, meta);
      parts.push(build(meta, file));
    } catch (error) {
      notes.push(`[附件 ${meta.n ?? meta.p} 原生发送失败: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return parts;
}

const buildGoogleParts = (root: string, files: NativeFileMeta[], notes: string[]) =>
  buildParts(root, files, notes, (meta, file) => ({ inlineData: { mimeType: meta.m, data: file.base64 } }));

const buildResponsesParts = (root: string, files: NativeFileMeta[], notes: string[]) =>
  buildParts(root, files, notes, (meta, file) => ({
    type: "input_file",
    filename: meta.n ?? basename(meta.p),
    file_data: `data:${meta.m};base64,${file.base64}`,
  }));

const buildAnthropicParts = (root: string, files: NativeFileMeta[], notes: string[]) =>
  buildParts(root, files, notes, (meta, file) => ({
    type: "document",
    source: { type: "base64", media_type: meta.m, data: file.base64 },
  }));

const buildBedrockParts = (root: string, files: NativeFileMeta[], notes: string[]) =>
  buildParts(root, files, notes, (meta, file) => ({
    document: {
      format: meta.m.includes("pdf") ? "pdf" : (meta.n ?? "").split(".").pop() || "pdf",
      name: sanitizeDocName(meta.n),
      source: { bytes: new Uint8Array(file.buffer) },
    },
  }));

const buildCompletionsFileParts = (root: string, files: NativeFileMeta[], notes: string[]) =>
  buildParts(root, files, notes, (meta, file) => ({
    type: "file",
    file: {
      filename: meta.n ?? basename(meta.p),
      file_data: `data:${meta.m};base64,${file.base64}`,
    },
  }));

// --- per-API payload rewriters --------------------------------------------

type PartsBuilder = (root: string, files: NativeFileMeta[], notes: string[]) => Promise<any[]>;

async function rewriteTextParts(
  items: any[] | undefined,
  projectRoot: string,
  opts: {
    roleOf?: (item: any) => string | undefined;
    partsOf: (item: any) => any[] | undefined;
    normalizeContent?: (item: any) => void;
    isTextPart: (part: any) => boolean;
    textOf: (part: any) => string;
    setText: (part: any, text: string) => void;
    appendTo: (item: any, extra: any[]) => void;
    builder: PartsBuilder;
  },
): Promise<boolean> {
  if (!Array.isArray(items)) return false;
  let changed = false;
  for (const item of items) {
    if (!item || (opts.roleOf ? opts.roleOf(item) !== "user" : false)) continue;
    opts.normalizeContent?.(item);
    const parts = opts.partsOf(item);
    if (!Array.isArray(parts)) continue;
    const extra: any[] = [];
    for (const part of parts) {
      if (!opts.isTextPart(part)) continue;
      const text = opts.textOf(part);
      if (typeof text !== "string" || !text.includes("\u27e6INKOS_FILE:")) continue;
      const notes: string[] = [];
      const { stripped, files } = scanMarkers(text);
      const fileParts = await opts.builder(projectRoot, files, notes);
      opts.setText(part, notes.length ? `${stripped}\n${notes.join("\n")}` : stripped);
      extra.push(...fileParts);
      changed = true;
    }
    if (extra.length) opts.appendTo(item, extra);
  }
  return changed;
}

function stripMarkersDeep(value: any): any {
  if (typeof value === "string") return value.replace(NATIVE_FILE_MARKER_RE, "[附件未能原生发送，已由宿主解析处理]");
  if (Array.isArray(value)) return value.map((item) => stripMarkersDeep(item));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = stripMarkersDeep(value[key]);
    return value;
  }
  return value;
}

export async function rewritePayloadWithNativeFiles(payload: any, model: ModelLike | undefined, ctx: PayloadHookCtx): Promise<any> {
  if (!payload || typeof payload !== "object") return payload;
  const projectRoot = ctx.projectRoot;
  const api = String(model?.api ?? "");
  const textPart = {
    isTextPart: (part: any) => typeof part?.text === "string",
    textOf: (part: any) => part.text as string,
    setText: (part: any, text: string) => { part.text = text; },
  };
  if (api === "google-generative-ai" || api === "google-vertex" || api === "google-gemini-cli") {
    const contents = api === "google-gemini-cli" ? (payload.request?.contents ?? payload.contents) : payload.contents;
    await rewriteTextParts(contents, projectRoot, {
      roleOf: (item) => item.role,
      partsOf: (item) => item.parts,
      appendTo: (item, extra) => item.parts.push(...extra),
      builder: buildGoogleParts,
      ...textPart,
    });
    return payload;
  }
  if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
    await rewriteTextParts(payload.input, projectRoot, {
      roleOf: (item) => item.role,
      normalizeContent: (item) => {
        if (typeof item.content === "string" && item.content.includes("\u27e6INKOS_FILE:")) {
          item.content = [{ type: "input_text", text: item.content }];
        }
      },
      partsOf: (item) => item.content,
      appendTo: (item, extra) => item.content.push(...extra),
      builder: buildResponsesParts,
      isTextPart: (part: any) => part?.type === "input_text" && typeof part.text === "string",
      textOf: (part: any) => part.text as string,
      setText: (part: any, text: string) => { part.text = text; },
    });
    return payload;
  }
  if (api === "anthropic-messages") {
    await rewriteTextParts(payload.messages, projectRoot, {
      roleOf: (item) => item.role,
      normalizeContent: (item) => {
        if (typeof item.content === "string" && item.content.includes("\u27e6INKOS_FILE:")) {
          item.content = [{ type: "text", text: item.content }];
        }
      },
      partsOf: (item) => item.content,
      appendTo: (item, extra) => item.content.push(...extra),
      builder: buildAnthropicParts,
      isTextPart: (part: any) => part?.type === "text" && typeof part.text === "string",
      textOf: (part: any) => part.text as string,
      setText: (part: any, text: string) => { part.text = text; },
    });
    return payload;
  }
  if (api === "bedrock-converse-stream") {
    await rewriteTextParts(payload.messages, projectRoot, {
      roleOf: (item) => item.role,
      partsOf: (item) => item.content,
      appendTo: (item, extra) => item.content.push(...extra),
      builder: buildBedrockParts,
      ...textPart,
    });
    return payload;
  }
  if (api === "openai-completions") {
    await rewriteTextParts(payload.messages, projectRoot, {
      roleOf: (item) => item.role,
      normalizeContent: (item) => {
        if (typeof item.content === "string" && item.content.includes("\u27e6INKOS_FILE:")) {
          item.content = [{ type: "text", text: item.content }];
        }
      },
      partsOf: (item) => item.content,
      appendTo: (item, extra) => item.content.push(...extra),
      builder: buildCompletionsFileParts,
      isTextPart: (part: any) => part?.type === "text" && typeof part.text === "string",
      textOf: (part: any) => part.text as string,
      setText: (part: any, text: string) => { part.text = text; },
    });
    return payload;
  }
  // Unknown API: never leak raw markers upstream.
  return stripMarkersDeep(payload);
}

/**
 * Merge the native-file onPayload hook into pi-ai stream options, chaining any
 * caller-provided onPayload first.
 */
export function withNativeFilePayloads<T extends { onPayload?: (payload: any, model: any) => any }>(
  options: T | undefined,
  ctx: PayloadHookCtx,
): T {
  const previous = options?.onPayload;
  return {
    ...(options ?? {}),
    onPayload: async (payload: any, model: any) => {
      let current = payload;
      if (previous) {
        const replaced = await previous(payload, model);
        if (replaced !== undefined) current = replaced;
      }
      try {
        const rewritten = await rewritePayloadWithNativeFiles(current, model, ctx);
        current = rewritten ?? current;
      } catch (error) {
        console.warn(`[inkos] 原生附件注入失败，按原样发送: ${error instanceof Error ? error.message : String(error)}`);
        current = stripMarkersDeep(current);
      }
      return current;
    },
  } as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
