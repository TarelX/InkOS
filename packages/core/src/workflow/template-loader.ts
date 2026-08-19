/**
 * Template loading: built-ins + project-level YAML overrides in
 * `.agents/workflows/*.yaml` (same id wins over built-in).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

import { WorkflowTemplateSchema, type WorkflowTemplate } from "./template.js";

export async function loadProjectTemplates(projectRoot: string): Promise<ReadonlyArray<WorkflowTemplate>> {
  const dir = join(projectRoot, ".agents", "workflows");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /\.(ya?ml|json)$/i.test(f));
  } catch {
    return [];
  }
  const templates: WorkflowTemplate[] = [];
  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), "utf-8");
    const parsed = /\.json$/i.test(file) ? JSON.parse(raw) : loadYaml(raw);
    templates.push(WorkflowTemplateSchema.parse(parsed));
  }
  return templates;
}

export function mergeTemplates(
  builtIns: ReadonlyArray<WorkflowTemplate>,
  overrides: ReadonlyArray<WorkflowTemplate>,
): ReadonlyArray<WorkflowTemplate> {
  const byId = new Map<string, WorkflowTemplate>();
  for (const template of builtIns) byId.set(template.id, template);
  for (const template of overrides) byId.set(template.id, template);
  return [...byId.values()];
}
