/**
 * Native-PDF capability probing（V1 patch-rich-attachments 移植）：生成一个带
 * 验证码的极小 PDF，通过端点的原生文件协议发送一次真实推理请求，记录该模型
 * 能否读到。结论按 provider|baseUrl|model 持久化，每个端点只付一次探测成本。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";

import { capabilityKeyForModel, resolveFileInputCapability, writeFileCapabilityEntry, type ModelLike } from "./capability.js";
import { encodeNativeFileMarker, withNativeFilePayloads } from "./payload-hook.js";

const PROBE_TOKEN = "INKOS42";
const PROBE_REL_DIR = join(".inkos", "uploads", "capability-probe");
const PROBE_TIMEOUT_MS = 45_000;
const inFlightProbes = new Set<string>();

export interface ProbeResult {
  readonly supported: boolean;
  readonly key: string;
  readonly transient?: boolean;
  readonly detail: string;
}

/** Build a minimal valid single-page PDF with correct xref offsets. */
export function buildMinimalPdf(text: string): Buffer {
  const safe = String(text).replace(/[\\()]/g, " ");
  const header = "%PDF-1.4\n";
  const objects: Array<string | null> = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    null, // content stream placeholder
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${safe}) Tj ET`;
  objects[3] = `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`;
  let body = "";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(header) + Buffer.byteLength(body));
    body += object!;
  }
  const xrefStart = Buffer.byteLength(header) + Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}

async function ensureProbeFile(projectRoot: string): Promise<string> {
  const dir = join(projectRoot, PROBE_REL_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "probe.pdf");
  await writeFile(filePath, buildMinimalPdf(`验证码 ${PROBE_TOKEN}`));
  return relative(projectRoot, filePath).replace(/\\/g, "/");
}

/**
 * Probe whether this endpoint can read a natively-attached PDF.
 * Writes the verdict into the capability profile（瞬态失败不写结论）。
 */
export async function probeNativePdfCapability({ projectRoot, model, apiKey }: {
  projectRoot: string;
  model: ModelLike;
  apiKey?: string;
}): Promise<ProbeResult> {
  const key = capabilityKeyForModel(model);
  const capability = await resolveFileInputCapability(projectRoot, model);
  if (!capability.protocol) {
    await writeFileCapabilityEntry(projectRoot, key, { pdfNative: false, probe: "no-protocol" });
    return { supported: false, key, detail: "该 API 协议没有可用的原生文件通道，将使用宿主解析" };
  }
  const relPath = await ensureProbeFile(projectRoot);
  const marker = encodeNativeFileMarker({ p: relPath, m: "application/pdf", n: "probe.pdf" });
  const context = {
    messages: [{
      role: "user" as const,
      content: `附件 PDF 中有一个验证码（格式：INKOS+数字）。请只回复该验证码，不要任何其他文字。${marker}`,
      timestamp: Date.now(),
    }],
  };
  const options = withNativeFilePayloads({
    apiKey,
    maxTokens: 4096,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, { projectRoot });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await completeSimple(model as any, context as any, options);
    if (response.stopReason === "error") {
      const message = response.errorMessage ?? "unknown error";
      if (isFormatRejection(message)) {
        await writeFileCapabilityEntry(projectRoot, key, { pdfNative: false, probe: `rejected: ${truncate(message)}` });
        return { supported: false, key, detail: `端点拒绝原生文件块：${truncate(message)}` };
      }
      return { supported: false, key, transient: true, detail: `探测请求失败（未写入结论）：${truncate(message)}` };
    }
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const supported = text.includes(PROBE_TOKEN);
    await writeFileCapabilityEntry(projectRoot, key, {
      pdfNative: supported,
      probe: supported ? "ok" : `wrong-answer: ${truncate(text)}`,
    });
    return {
      supported,
      key,
      detail: supported ? "模型成功读取了原生 PDF" : `模型未读到 PDF 内容（回复：${truncate(text) || "空"}）`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isFormatRejection(message)) {
      await writeFileCapabilityEntry(projectRoot, key, { pdfNative: false, probe: `rejected: ${truncate(message)}` });
      return { supported: false, key, detail: `端点拒绝原生文件块：${truncate(message)}` };
    }
    // Auth/quota/network failures must not be recorded as capability facts.
    return { supported: false, key, transient: true, detail: `探测失败（未写入结论）：${truncate(message)}` };
  }
}

function isFormatRejection(message: string): boolean {
  return /content|part|type|file|document|mime|unsupported|invalid.*(block|format)|无效|不支持/i.test(message)
    && !/api.?key|auth|401|403|429|quota|rate|billing|insufficient/i.test(message);
}

function truncate(text: string): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
}

/** Fire-and-forget probe on first PDF for an endpoint with unknown capability. */
export function scheduleLazyPdfProbe({ projectRoot, model, apiKey }: {
  projectRoot: string;
  model: ModelLike;
  apiKey?: string;
}): void {
  const key = capabilityKeyForModel(model);
  if (inFlightProbes.has(key)) return;
  inFlightProbes.add(key);
  probeNativePdfCapability({ projectRoot, model, apiKey })
    .then((result) => {
      console.warn(`[inkos] PDF 原生能力探测 ${key}: ${result.supported ? "支持" : "不支持"} — ${result.detail}`);
    })
    .catch((error) => {
      console.warn(`[inkos] PDF 原生能力探测异常 ${key}: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      inFlightProbes.delete(key);
    });
}
