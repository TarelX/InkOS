/**
 * File-input capability negotiation（V1 patch-rich-attachments 移植）：判定一个
 * 模型端点支持哪种原生文件协议。结论来源：内置 API 知识 → 端点探测结果 →
 * 用户覆盖，按 provider|baseUrl|model 三元组独立存储（同一模型走不同端点
 * 能力可能不同）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROFILE_REL_PATH = join(".inkos", "file-capabilities.json");
const PROFILE_CACHE_TTL_MS = 5_000;

export type FileInputMode = "auto" | "native" | "extract";
export type FileProtocol = "google" | "anthropic" | "openai-responses" | "bedrock" | "openai-file-part";

export interface ModelLike {
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly id?: string;
  readonly api?: string;
  readonly contextWindow?: number;
}

export interface CapabilityEntry {
  mode?: string;
  protocol?: string;
  pdfNative?: boolean;
  probe?: string;
  updatedAt?: string;
}

export interface CapabilityProfile {
  defaults: { mode?: string };
  entries: Record<string, CapabilityEntry>;
}

export interface ResolvedFileCapability {
  readonly key: string;
  readonly mode: FileInputMode;
  readonly protocol: FileProtocol | null;
  readonly pdfNative: boolean | "unknown";
}

const profileCache = new Map<string, { at: number; data: CapabilityProfile }>();

export function capabilityKeyForModel(model: ModelLike | undefined): string {
  const provider = String(model?.provider ?? "unknown").toLowerCase();
  const baseUrl = String(model?.baseUrl ?? "").toLowerCase().replace(/\/+$/, "");
  const id = String(model?.id ?? "").toLowerCase();
  return `${provider}|${baseUrl}|${id}`;
}

// pdf: true = native supported by protocol; false = never; "unknown" = depends
// on the concrete endpoint (probe or override decides).
const BUILTIN_API_CAPABILITY: Record<string, { protocol: FileProtocol | null; pdf: boolean | "unknown" }> = {
  "google-generative-ai": { protocol: "google", pdf: true },
  "google-gemini-cli": { protocol: "google", pdf: true },
  "google-vertex": { protocol: "google", pdf: true },
  "anthropic-messages": { protocol: "anthropic", pdf: true },
  "openai-responses": { protocol: "openai-responses", pdf: true },
  "azure-openai-responses": { protocol: "openai-responses", pdf: true },
  "openai-codex-responses": { protocol: "openai-responses", pdf: true },
  "bedrock-converse-stream": { protocol: "bedrock", pdf: true },
  "openai-completions": { protocol: "openai-file-part", pdf: "unknown" },
  "mistral-conversations": { protocol: null, pdf: false },
};

// Chat-completions hosts known to accept {type:"file"} content parts.
const KNOWN_FILE_PART_HOSTS = [
  /(^|\.)api\.openai\.com$/i,
  /(^|\.)openrouter\.ai$/i,
];

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

export async function readFileCapabilityProfile(projectRoot: string): Promise<CapabilityProfile> {
  const cached = profileCache.get(projectRoot);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) return cached.data;
  let data: CapabilityProfile = { defaults: {}, entries: {} };
  try {
    const raw = await readFile(join(projectRoot, PROFILE_REL_PATH), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CapabilityProfile> | null;
    if (parsed && typeof parsed === "object") {
      data = {
        defaults: parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : {},
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
      };
    }
  } catch { /* missing/corrupt profile file falls back to defaults */ }
  profileCache.set(projectRoot, { at: Date.now(), data });
  return data;
}

export async function writeFileCapabilityEntry(
  projectRoot: string,
  key: string,
  patch: CapabilityEntry,
): Promise<CapabilityEntry> {
  const profile = await readFileCapabilityProfile(projectRoot);
  const next: CapabilityProfile = {
    defaults: profile.defaults,
    entries: {
      ...profile.entries,
      [key]: { ...(profile.entries[key] ?? {}), ...patch, updatedAt: new Date().toISOString() },
    },
  };
  const filePath = join(projectRoot, PROFILE_REL_PATH);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), "utf-8");
  profileCache.set(projectRoot, { at: Date.now(), data: next });
  return next.entries[key]!;
}

/** Resolve effective file-input capability for a pi-ai model. */
export async function resolveFileInputCapability(
  projectRoot: string,
  model: ModelLike | undefined,
): Promise<ResolvedFileCapability> {
  const profile = await readFileCapabilityProfile(projectRoot);
  const key = capabilityKeyForModel(model);
  const entry = profile.entries[key] ?? {};
  const envMode = process.env.INKOS_FILE_INPUT_MODE;
  const mode = normalizeMode(envMode) ?? normalizeMode(entry.mode) ?? normalizeMode(profile.defaults.mode) ?? "auto";
  const builtin = BUILTIN_API_CAPABILITY[String(model?.api ?? "")] ?? { protocol: null, pdf: false };
  const protocol = normalizeProtocol(entry.protocol) ?? builtin.protocol;
  if (mode === "extract" || !protocol) return { key, mode, protocol: protocol ?? null, pdfNative: false };
  if (mode === "native") return { key, mode, protocol, pdfNative: true };
  // auto mode
  if (typeof entry.pdfNative === "boolean") return { key, mode, protocol, pdfNative: entry.pdfNative };
  if (builtin.pdf === true) return { key, mode, protocol, pdfNative: true };
  if (builtin.pdf === "unknown") {
    const host = hostOf(String(model?.baseUrl ?? ""));
    if (KNOWN_FILE_PART_HOSTS.some((re) => re.test(host))) return { key, mode, protocol, pdfNative: true };
    return { key, mode, protocol, pdfNative: "unknown" };
  }
  return { key, mode, protocol, pdfNative: false };
}

function normalizeMode(value: unknown): FileInputMode | undefined {
  return value === "auto" || value === "native" || value === "extract" ? value : undefined;
}

function normalizeProtocol(value: unknown): FileProtocol | null | undefined {
  if (value === "none") return null;
  return value === "google" || value === "anthropic" || value === "openai-responses"
    || value === "bedrock" || value === "openai-file-part"
    ? value
    : undefined;
}
