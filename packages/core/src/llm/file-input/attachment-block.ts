/**
 * Rich attachment block builder（V1 patch-rich-attachments 移植）：逐附件决定
 * 内容以哪种方式给模型 —— 原生文件（marker）、按预算注入的相关性排序文本、
 * 或仅存储说明 —— 并明确告知模型它实际能看到文件的哪些部分。
 */
import { estimateTextTokens } from "../provider.js";
import { resolveFileInputCapability, type ModelLike } from "./capability.js";
import { encodeNativeFileMarker } from "./payload-hook.js";
import { scheduleLazyPdfProbe } from "./probe.js";
import type { ExtractSection } from "../../materials/document-extract.js";

const ABS_TOKEN_BUDGET_CAP = 48_000;
const CONTEXT_BUDGET_RATIO = 0.35;
const NATIVE_INLINE_MAX_BYTES = 15 * 1024 * 1024;
const PLAIN_TEXT_CHUNK_CHARS = 4_000;

/** 结构兼容 AgentSessionAttachment：image 只做真值判断（多模态另走通道）。 */
export interface RichAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly storedPath?: string;
  readonly text?: string;
  readonly image?: unknown;
  readonly extractError?: string;
  readonly extracted?: {
    readonly kind: string;
    readonly sections: ReadonlyArray<ExtractSection>;
    readonly totalChars?: number;
    readonly truncated?: boolean;
    readonly warnings?: ReadonlyArray<string>;
    readonly meta?: Record<string, unknown>;
  };
}

export interface RichAttachmentCtx {
  readonly model?: ModelLike;
  readonly projectRoot?: string;
  readonly userMessage?: string;
  readonly apiKey?: string;
}

function contextWindowOf(model: ModelLike | undefined): number {
  const win = Number(model?.contextWindow);
  return Number.isFinite(win) && win > 0 ? win : 131_072;
}

function extractQueryTerms(userMessage: string | undefined): string[] {
  const raw = String(userMessage ?? "").normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const match of raw.matchAll(/[a-z0-9_]{2,}/g)) terms.add(match[0]);
  for (const match of raw.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0];
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return [...terms].slice(0, 64);
}

function scoreSection(section: ExtractSection, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = String(section.title ?? "").toLowerCase();
  const body = String(section.text ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 6;
    let idx = body.indexOf(term);
    let hits = 0;
    while (idx >= 0 && hits < 20) {
      hits += 1;
      idx = body.indexOf(term, idx + term.length);
    }
    score += hits;
  }
  return score;
}

function splitPlainText(text: string): ExtractSection[] {
  const sections: ExtractSection[] = [];
  for (let offset = 0, index = 1; offset < text.length; offset += PLAIN_TEXT_CHUNK_CHARS, index += 1) {
    sections.push({
      id: `chunk:${index}`,
      title: `第 ${index} 段（字符 ${offset + 1}-${Math.min(text.length, offset + PLAIN_TEXT_CHUNK_CHARS)}）`,
      text: text.slice(offset, offset + PLAIN_TEXT_CHUNK_CHARS),
    });
  }
  return sections;
}

function pushSectionsWithBudget(
  lines: string[],
  sections: ReadonlyArray<ExtractSection>,
  terms: string[],
  budget: { remainingTokens: number },
  isEn: boolean,
): { injected: number; omitted: number } {
  const scored = sections.map((section, index) => ({ section, index, score: scoreSection(section, terms) }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof scored = [];
  let remaining = budget.remainingTokens;
  for (const item of scored) {
    const cost = estimateTextTokens(item.section.text) + 16;
    if (cost > remaining) continue;
    remaining -= cost;
    chosen.push(item);
  }
  chosen.sort((a, b) => a.index - b.index);
  budget.remainingTokens = remaining;
  const chosenIds = new Set(chosen.map((item) => item.section.id));
  const omitted = sections.filter((section) => !chosenIds.has(section.id));
  for (const item of chosen) {
    lines.push(`\n#### ${item.section.title}${item.section.truncated ? (isEn ? " (truncated)" : "（已截断）") : ""}`);
    lines.push("```");
    lines.push(item.section.text);
    lines.push("```");
  }
  if (omitted.length > 0) {
    const names = omitted.slice(0, 20).map((section) => `${section.title}（${section.text.length}字符）`).join("、");
    lines.push(isEn
      ? `\n[Context budget] ${omitted.length} section(s) were NOT injected: ${names}. Do not pretend to have read them; ask the user to narrow the question if needed.`
      : `\n【上下文预算】以下 ${omitted.length} 个部分未注入：${names}。不得假装已读这些部分；如需查看请让用户缩小提问范围。`);
  }
  return { injected: chosen.length, omitted: omitted.length };
}

/** Build the attachment block appended to the user prompt. */
export async function buildRichAttachmentBlock(
  attachments: ReadonlyArray<RichAttachment> | undefined,
  language: string,
  ctx: RichAttachmentCtx = {},
): Promise<string> {
  if (!attachments?.length) return "";
  const isEn = language === "en";
  const { model, projectRoot, userMessage } = ctx;
  const capability = model && projectRoot
    ? await resolveFileInputCapability(projectRoot, model).catch(() => ({ pdfNative: false as const, protocol: null, mode: "auto" as const, key: "" }))
    : { pdfNative: false as const, protocol: null, mode: "auto" as const, key: "" };
  const terms = extractQueryTerms(userMessage);
  const budget = {
    remainingTokens: Math.min(Math.floor(contextWindowOf(model) * CONTEXT_BUDGET_RATIO), ABS_TOKEN_BUDGET_CAP),
  };
  const lines: string[] = [
    isEn
      ? "\n\n## Uploaded Files (host-provided, user-authorized)"
      : "\n\n## 用户上传文件（宿主已接收，用户授权本轮使用）",
  ];
  for (const attachment of attachments) {
    lines.push(`\n### ${attachment.filename}`);
    lines.push(`- id: ${attachment.id}`);
    lines.push(`- mime: ${attachment.mimeType || "application/octet-stream"}`);
    lines.push(`- size: ${attachment.size}`);
    if (attachment.storedPath) lines.push(`- stored_path: ${attachment.storedPath}`);
    if (attachment.image) {
      lines.push(isEn ? "- image: attached as multimodal input" : "- 图片：已作为多模态输入附加");
      continue;
    }
    if (attachment.extractError) {
      lines.push(isEn
        ? `- error: ${attachment.extractError}. Tell the user exactly this; do not guess the file content.`
        : `- 错误：${attachment.extractError}。请如实告知用户，不得猜测文件内容。`);
      continue;
    }
    const extracted = attachment.extracted;
    const isPdf = extracted?.kind === "pdf" || String(attachment.mimeType ?? "").includes("pdf");
    const nativeEligible = isPdf
      && attachment.storedPath
      && attachment.size <= NATIVE_INLINE_MAX_BYTES
      && capability.protocol;
    if (nativeEligible && capability.pdfNative === true) {
      const marker = encodeNativeFileMarker({
        p: attachment.storedPath!,
        m: "application/pdf",
        n: attachment.filename,
      });
      const pages = extracted?.meta?.totalPages;
      lines.push(isEn
        ? `- delivery: native file input (the original PDF is attached to this message; read it directly)${pages ? ` — ${pages} pages` : ""}`
        : `- 读取方式：模型原生文件输入（原始 PDF 已随本条消息发送，可直接阅读全文）${pages ? `，共 ${pages} 页` : ""}`);
      lines.push(marker);
      continue;
    }
    if (nativeEligible && capability.pdfNative === "unknown" && projectRoot && model) {
      // First encounter on an unprobed endpoint: extract now, probe in background.
      scheduleLazyPdfProbe({ projectRoot, model, apiKey: ctx.apiKey });
    }
    if (extracted?.sections?.length) {
      const total = extracted.totalChars ?? extracted.sections.reduce((sum, section) => sum + section.text.length, 0);
      const overview = extracted.sections.map((section) => `${section.title}（${section.text.length}字符）`).slice(0, 40).join("、");
      lines.push(isEn
        ? `- delivery: host-extracted content (${extracted.kind}, ${total} chars${extracted.truncated ? ", truncated" : ""})`
        : `- 读取方式：宿主解析注入（${extracted.kind}，共 ${total} 字符${extracted.truncated ? "，源文件超限已截断" : ""}）`);
      lines.push(isEn ? `- structure: ${overview}` : `- 结构：${overview}`);
      for (const warning of extracted.warnings ?? []) lines.push(`- warning: ${warning}`);
      pushSectionsWithBudget(lines, extracted.sections, terms, budget, isEn);
      continue;
    }
    if (attachment.text) {
      const tokens = estimateTextTokens(attachment.text);
      if (tokens <= budget.remainingTokens) {
        budget.remainingTokens -= tokens;
        lines.push(isEn ? "\nContent:" : "\n内容：");
        lines.push("```");
        lines.push(attachment.text);
        lines.push("```");
      } else {
        pushSectionsWithBudget(lines, splitPlainText(attachment.text), terms, budget, isEn);
      }
      continue;
    }
    lines.push(isEn
      ? "- content: stored only; no extractor produced text for this MIME type"
      : "- 内容：已保存，但该类型未能提取文本；请如实告知用户无法读取内容");
  }
  return lines.join("\n");
}
