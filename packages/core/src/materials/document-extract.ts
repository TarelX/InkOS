/**
 * Unified host-side document extractor for chat attachments and material
 * ingestion（V1 patch-rich-attachments 移植）。
 *
 * Office/表格解析依赖（xlsx / officeparser）为真实依赖、懒加载：
 * 不解析文档的进程不付启动成本。
 */
import { extname } from "node:path";

const MAX_EXTRACT_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_EXTRACT_CHARS = 2_000_000;
const MAX_FORMULAS_PER_SHEET = 200;

export type AttachmentKind = "image" | "spreadsheet" | "word" | "slides" | "pdf" | "text" | "unknown";

export interface ExtractSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly truncated?: boolean;
}

export interface ExtractSuccess {
  readonly ok: true;
  readonly kind: AttachmentKind;
  readonly sections: ReadonlyArray<ExtractSection>;
  readonly warnings: ReadonlyArray<string>;
  readonly meta: Record<string, unknown>;
  readonly totalChars: number;
  readonly truncated: boolean;
}

export interface ExtractFailure {
  readonly ok: false;
  readonly kind: AttachmentKind;
  readonly error: string;
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

interface RawExtraction {
  kind: AttachmentKind;
  sections: ExtractSection[];
  warnings: string[];
  meta: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let cachedXlsx: any = null;
async function loadXlsx(): Promise<any> {
  if (cachedXlsx) return cachedXlsx;
  const mod: any = await import("xlsx");
  cachedXlsx = mod?.default?.read ? mod.default : mod;
  return cachedXlsx;
}

let officeparserPromise: Promise<any> | null = null;
function loadOfficeparser(): Promise<any> {
  officeparserPromise ??= import("officeparser");
  return officeparserPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SPREADSHEET_EXTS = new Set([".xlsx", ".xls", ".xlsm", ".xlsb", ".csv", ".tsv", ".ods"]);
const WORD_EXTS = new Set([".docx", ".odt", ".rtf"]);
const SLIDES_EXTS = new Set([".pptx", ".odp"]);
const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".log", ".xml", ".html", ".htm",
  ".js", ".ts", ".py", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".sql", ".ini", ".toml", ".css",
]);

export function classifyAttachmentKind(filename: string | undefined, mimeType: string | undefined): AttachmentKind {
  const ext = extname(String(filename ?? "")).toLowerCase();
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (SPREADSHEET_EXTS.has(ext) || mime.includes("spreadsheet") || mime.includes("ms-excel") || mime === "text/csv" || mime === "text/tab-separated-values") return "spreadsheet";
  if (WORD_EXTS.has(ext) || mime.includes("wordprocessingml") || mime.includes("msword") || mime.includes("opendocument.text") || mime === "application/rtf" || mime === "text/rtf") return "word";
  if (SLIDES_EXTS.has(ext) || mime.includes("presentationml") || mime.includes("ms-powerpoint") || mime.includes("opendocument.presentation")) return "slides";
  if (ext === ".pdf" || mime.includes("pdf")) return "pdf";
  if (TEXT_EXTS.has(ext) || mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || mime.includes("yaml")) return "text";
  return "unknown";
}

export interface DecodedText {
  readonly text: string;
  readonly encoding: string;
  readonly warnings: string[];
  readonly binary: boolean;
}

/** Decode a text buffer with BOM handling, binary detection, and GBK fallback. */
export function decodeTextSmart(buffer: Buffer): DecodedText {
  const warnings: string[] = [];
  let buf = buffer;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  const probe = buf.subarray(0, 8192);
  let nulls = 0;
  for (const byte of probe) if (byte === 0) nulls += 1;
  if (probe.length > 0 && nulls / probe.length > 0.02) {
    return { text: "", encoding: "binary", warnings: ["文件包含大量二进制内容，不是可读文本"], binary: true };
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const utf8Bad = countReplacementChars(utf8);
  if (utf8Bad === 0) return { text: utf8, encoding: "utf-8", warnings, binary: false };
  let gbkText: string | null = null;
  let gbkBad = Number.POSITIVE_INFINITY;
  try {
    gbkText = new TextDecoder("gbk", { fatal: false }).decode(buf);
    gbkBad = countReplacementChars(gbkText);
  } catch { /* ICU without gbk — keep utf-8 */ }
  if (gbkText !== null && gbkBad < utf8Bad) {
    warnings.push("文件不是 UTF-8 编码，已按 GBK 解码");
    return { text: gbkText, encoding: "gbk", warnings, binary: false };
  }
  if (utf8Bad > 0) warnings.push(`文本包含 ${utf8Bad} 处无法解码的字节，已用替换符表示`);
  return { text: utf8, encoding: "utf-8", warnings, binary: false };
}

function countReplacementChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) count += 1;
  return count;
}

async function extractSpreadsheet(buffer: Buffer, filename: string): Promise<RawExtraction> {
  const XLSX = await loadXlsx();
  const ext = extname(filename).toLowerCase();
  const warnings: string[] = [];
  let workbook;
  if (ext === ".csv" || ext === ".tsv") {
    // SheetJS decodes raw CSV buffers as latin1; decode text ourselves so
    // UTF-8/GBK Chinese survives.
    const decoded = decodeTextSmart(buffer);
    if (decoded.binary) throw new Error(decoded.warnings[0] ?? "文件不是可读文本");
    warnings.push(...decoded.warnings);
    workbook = XLSX.read(decoded.text, { type: "string", FS: ext === ".tsv" ? "\t" : undefined });
  } else {
    workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellDates: true });
  }
  const sections: ExtractSection[] = [];
  for (const sheetName of workbook.SheetNames as string[]) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const formulas: string[] = [];
    if (sheet["!ref"]) {
      for (const [addr, cell] of Object.entries(sheet)) {
        if (addr.startsWith("!")) continue;
        if (cell && typeof cell === "object" && typeof (cell as { f?: unknown }).f === "string") {
          formulas.push(`${addr} = ${(cell as { f: string }).f}`);
          if (formulas.length >= MAX_FORMULAS_PER_SHEET) {
            warnings.push(`工作表 ${sheetName} 公式超过 ${MAX_FORMULAS_PER_SHEET} 条，已截断公式列表`);
            break;
          }
        }
      }
    }
    const text = formulas.length > 0 ? `${csv}\n\n[公式]\n${formulas.join("\n")}` : csv;
    sections.push({ id: `sheet:${sheetName}`, title: `工作表「${sheetName}」`, text });
  }
  if (sections.length === 0) warnings.push("工作簿中没有可读取的工作表");
  return {
    kind: "spreadsheet",
    sections,
    warnings,
    meta: { sheetNames: workbook.SheetNames, sheetCount: workbook.SheetNames.length, filename },
  };
}

async function extractOfficeText(buffer: Buffer, filename: string, kind: AttachmentKind, ext: string): Promise<RawExtraction> {
  const op = await loadOfficeparser();
  let text = "";
  let warnings: string[] = [];
  try {
    if (typeof op.parseOffice === "function") {
      const result = await op.parseOffice(buffer, { fileType: ext.replace(/^\./, ""), outputErrorToConsole: false });
      text = String(await result.toText());
      warnings = Array.isArray(result.warnings)
        ? result.warnings.map((w: unknown) => String((w as { message?: unknown })?.message ?? w)).slice(0, 8)
        : [];
    } else if (typeof op.parseOfficeAsync === "function") {
      text = String(await op.parseOfficeAsync(buffer));
    } else {
      throw new Error("officeparser 接口不可用");
    }
  } catch (error) {
    throw new Error(`文档文本提取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!text.trim()) throw new Error("文档没有可提取的文本内容（可能为空或纯图片内容）");
  return {
    kind,
    sections: [{ id: "document", title: filename, text: text.trim() }],
    warnings,
    meta: { filename },
  };
}

async function extractPdf(buffer: Buffer, filename: string): Promise<RawExtraction> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const extracted = await extractText(pdf, { mergePages: true });
  const text = String(extracted.text ?? "").trim();
  if (!text) {
    throw new Error("PDF 没有文本层（可能是扫描件），当前不支持 OCR；请提供带文本层的 PDF 或先转文字");
  }
  return {
    kind: "pdf",
    sections: [{ id: "pdf", title: filename, text }],
    warnings: [],
    meta: { totalPages: extracted.totalPages, filename },
  };
}

function extractPlainText(buffer: Buffer, filename: string): RawExtraction {
  const decoded = decodeTextSmart(buffer);
  if (decoded.binary) throw new Error(decoded.warnings[0] ?? "文件不是可读文本");
  return {
    kind: "text",
    sections: [{ id: "text", title: filename, text: decoded.text }],
    warnings: decoded.warnings,
    meta: { encoding: decoded.encoding, filename },
  };
}

function applyTotalCap(result: RawExtraction): Omit<ExtractSuccess, "ok"> {
  let total = 0;
  let truncated = false;
  const sections: ExtractSection[] = [];
  for (const section of result.sections) {
    if (total >= MAX_TOTAL_EXTRACT_CHARS) {
      truncated = true;
      break;
    }
    const remaining = MAX_TOTAL_EXTRACT_CHARS - total;
    if (section.text.length > remaining) {
      sections.push({ ...section, text: section.text.slice(0, remaining), truncated: true });
      total += remaining;
      truncated = true;
    } else {
      sections.push(section);
      total += section.text.length;
    }
  }
  return { ...result, sections, totalChars: total, truncated };
}

/**
 * Extract a document buffer into LLM-ready sections.
 * Never throws for expected content problems; returns { ok: false, error } instead.
 */
export async function extractDocument({ buffer, filename, mimeType }: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
}): Promise<ExtractResult> {
  const name = String(filename ?? "document");
  const ext = extname(name).toLowerCase();
  const kind = classifyAttachmentKind(name, mimeType);
  if (kind === "image") {
    return { ok: false, kind, error: "图片不走文本抽取，请作为视觉输入发送" };
  }
  if (buffer.byteLength > MAX_EXTRACT_INPUT_BYTES) {
    return { ok: false, kind, error: `文件超过抽取上限 ${Math.floor(MAX_EXTRACT_INPUT_BYTES / 1024 / 1024)}MB，无法解析内容` };
  }
  try {
    let result: RawExtraction;
    if (kind === "spreadsheet") result = await extractSpreadsheet(buffer, name);
    else if (kind === "word") result = await extractOfficeText(buffer, name, "word", ext || ".docx");
    else if (kind === "slides") result = await extractOfficeText(buffer, name, "slides", ext || ".pptx");
    else if (kind === "pdf") result = await extractPdf(buffer, name);
    else if (kind === "text") result = extractPlainText(buffer, name);
    else return { ok: false, kind, error: `暂不支持解析该格式（${ext || mimeType || "未知类型"}）` };
    const capped = applyTotalCap(result);
    return { ok: true, ...capped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const encrypted = /encrypt|password|加密/i.test(message);
    return {
      ok: false,
      kind,
      error: encrypted ? `文件已加密或受密码保护，无法解析：${message}` : `解析失败：${message}`,
    };
  }
}

/** Render extraction result as a markdown file for persistence next to the upload. */
export function renderExtractedMarkdown(filename: string, extraction: Omit<ExtractSuccess, "ok">): string {
  const lines = [`# ${filename}`, "", "## 抽取信息", `- kind: ${extraction.kind}`, `- total_chars: ${extraction.totalChars ?? 0}`];
  if (extraction.truncated) lines.push("- truncated: true");
  for (const warning of extraction.warnings ?? []) lines.push(`- warning: ${warning}`);
  lines.push("");
  for (const section of extraction.sections ?? []) {
    lines.push(`## ${section.title}`, "", section.text, "");
  }
  return lines.join("\n");
}
