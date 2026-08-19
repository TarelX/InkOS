/**
 * Asset Registry V2 — Skill / Rule / Schema / Template / Evaluator are five
 * distinct asset kinds with independent manifests (设计方案 §19/§22).
 *
 * Invariants:
 * - the registry is METADATA ONLY: it never executes asset scripts;
 * - every asset carries source, license, trust level and a content checksum;
 * - external assets default to `untrusted` until a human flips them;
 * - tampering is detectable: verify() recomputes the checksum.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { sha256Hex } from "../story-intelligence/ids.js";

export const AssetKindSchema = z.enum(["skill", "rule", "schema", "template", "evaluator"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetTrustSchema = z.enum(["builtin", "reviewed", "untrusted"]);
export type AssetTrust = z.infer<typeof AssetTrustSchema>;

export const AssetManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  kind: AssetKindSchema,
  version: z.string().default("0.0.0"),
  description: z.string().default(""),
  /** "local" or an upstream URL (+ optional commit/tag after '#'). */
  source: z.string().default("local"),
  license: z.string().default("UNKNOWN"),
  trust: AssetTrustSchema.default("untrusted"),
  capabilities: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  requiresTools: z.array(z.string()).default([]),
  /** sha256 over the asset's file contents (sorted, name-prefixed). */
  checksum: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export interface RegisteredAsset {
  readonly manifest: AssetManifest;
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
  /** Problems found during scan (bad manifest, checksum mismatch, license flag). */
  readonly issues: ReadonlyArray<string>;
}

const KIND_DIRS: ReadonlyArray<{ kind: AssetKind; dir: string }> = [
  { kind: "skill", dir: "skills" },
  { kind: "rule", dir: "rules" },
  { kind: "schema", dir: "schemas" },
  { kind: "template", dir: "workflows" },
  { kind: "evaluator", dir: "evaluators" },
];

/** Licenses that must not be silently mixed into incompatible distributions. */
const COPYLEFT_RE = /^(GPL|AGPL|LGPL)/i;

async function listFilesRecursive(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

export async function computeAssetChecksum(dir: string): Promise<{ checksum: string; files: string[] }> {
  const files = (await listFilesRecursive(dir)).filter((f) => f !== "manifest.json");
  const parts: string[] = [];
  for (const file of files) {
    const body = await readFile(join(dir, file));
    parts.push(`${file}\u0000${sha256Hex(body)}`);
  }
  return { checksum: sha256Hex(parts.join("\n")), files };
}

/** Minimal frontmatter reader for legacy SKILL.md-only skills. */
function parseSkillFrontmatter(markdown: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.+)$/.exec(line.trim());
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { name: out.name, description: out.description };
}

async function loadAsset(kind: AssetKind, dir: string): Promise<RegisteredAsset | null> {
  const issues: string[] = [];
  let manifest: AssetManifest | null = null;

  const manifestPath = join(dir, "manifest.json");
  try {
    manifest = AssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf-8")));
    if (manifest.kind !== kind) issues.push(`manifest kind=${manifest.kind} 与目录类别 ${kind} 不符`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      issues.push(`manifest.json 无效：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  // Legacy skill: SKILL.md frontmatter → auto manifest, trust=untrusted.
  if (!manifest && kind === "skill") {
    try {
      const markdown = await readFile(join(dir, "SKILL.md"), "utf-8");
      const fm = parseSkillFrontmatter(markdown);
      if (fm.name) {
        manifest = AssetManifestSchema.parse({
          id: fm.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
          kind: "skill",
          description: fm.description ?? "",
          source: "local",
          license: "UNKNOWN",
          trust: "untrusted",
        });
        issues.push("无 manifest.json：由 SKILL.md frontmatter 生成临时清单（trust=untrusted）");
      }
    } catch {
      // not a skill dir
    }
  }
  if (!manifest) return null;

  const { checksum, files } = await computeAssetChecksum(dir);
  if (manifest.checksum && manifest.checksum !== checksum) {
    issues.push(`checksum 不匹配：清单 ${manifest.checksum.slice(0, 12)}… 实际 ${checksum.slice(0, 12)}… —— 资产内容被修改`);
  }
  if (COPYLEFT_RE.test(manifest.license)) {
    issues.push(`license=${manifest.license}：copyleft 资产，混入不兼容发行物前必须复核（ADR-002）`);
  }
  if (manifest.trust === "untrusted") {
    issues.push("trust=untrusted：启用前需人工复核（外部资产默认不信任）");
  }

  return { manifest: { ...manifest, checksum: manifest.checksum ?? checksum }, dir, files, issues };
}

export interface AssetScanResult {
  readonly assets: ReadonlyArray<RegisteredAsset>;
  readonly byKind: ReadonlyMap<AssetKind, ReadonlyArray<RegisteredAsset>>;
}

/**
 * Scan `.agents/{skills,rules,schemas,workflows,evaluators}` under a root.
 * Legacy V1 `skills/` (project root) is scanned too for compatibility.
 */
export async function scanAssets(projectRoot: string): Promise<AssetScanResult> {
  const assets: RegisteredAsset[] = [];
  const roots = [join(projectRoot, ".agents")];

  for (const root of roots) {
    for (const { kind, dir } of KIND_DIRS) {
      const kindDir = join(root, dir);
      let entries: string[] = [];
      try {
        entries = await readdir(kindDir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const assetDir = join(kindDir, entry);
        try {
          if (!(await stat(assetDir)).isDirectory()) continue;
        } catch {
          continue;
        }
        const asset = await loadAsset(kind, assetDir);
        if (asset) assets.push(asset);
      }
    }
  }

  // V1 compatibility: top-level skills/<name>/SKILL.md
  const legacySkillsDir = join(projectRoot, "skills");
  let legacyEntries: string[] = [];
  try {
    legacyEntries = await readdir(legacySkillsDir);
  } catch {
    // none
  }
  const seen = new Set(assets.map((a) => `${a.manifest.kind}:${a.manifest.id}`));
  for (const entry of legacyEntries.sort()) {
    const assetDir = join(legacySkillsDir, entry);
    try {
      if (!(await stat(assetDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const asset = await loadAsset("skill", assetDir);
    if (asset && !seen.has(`skill:${asset.manifest.id}`)) {
      assets.push(asset);
      seen.add(`skill:${asset.manifest.id}`);
    }
  }

  const byKind = new Map<AssetKind, RegisteredAsset[]>();
  for (const asset of assets) {
    const list = byKind.get(asset.manifest.kind) ?? [];
    list.push(asset);
    byKind.set(asset.manifest.kind, list);
  }
  return { assets, byKind };
}

/** Re-verify one asset's checksum against disk (tamper detection). */
export async function verifyAsset(asset: RegisteredAsset): Promise<{ ok: boolean; reason?: string }> {
  const { checksum } = await computeAssetChecksum(asset.dir);
  if (asset.manifest.checksum && checksum !== asset.manifest.checksum) {
    return { ok: false, reason: `checksum mismatch: expected ${asset.manifest.checksum}, got ${checksum}` };
  }
  return { ok: true };
}
