import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";

/**
 * 裸工具调用标记的兜底渲染（规格书 §11/§12）。
 *
 * 模型在某些代理端点下会把工具调用以文本形式吐进正文：
 *   <<<INKOS_TOOL_CALLS>>> [ { "name": ..., "arguments": ... } ] <<<END_INKOS_TOOL_CALLS>>>
 * 产品界面禁止直接展示这种原始 JSON——这里把它解析成 Tool Card，
 * 原始内容折叠进「查看详情」。
 */

export interface RawToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "tools"; calls: RawToolCall[]; raw: string; incomplete: boolean };

const BLOCK_START = /<<<\s*(?:INKOS_)?TOOL_CALLS\s*>>>/g;
const BLOCK_END = /<<<\s*END_(?:INKOS_)?TOOL_CALLS\s*>>>/;

/** 是否包含裸工具调用标记（快速判断，避免无谓的分段开销）。 */
export function hasRawToolCallMarker(content: string): boolean {
  return /<<<\s*(?:INKOS_|END_INKOS_)?TOOL_CALLS\s*>>>/.test(content);
}

function parseCalls(body: string): RawToolCall[] | null {
  const cleaned = body.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const calls: RawToolCall[] = [];
    for (const item of list) {
      if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
        const args = (item as { arguments?: unknown }).arguments;
        calls.push({
          name: (item as { name: string }).name,
          arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        });
      }
    }
    return calls.length > 0 ? calls : null;
  } catch {
    return null;
  }
}

/** 把消息文本切成「正文段 / 工具调用段」。没有标记时返回单一正文段。 */
export function splitRawToolCallSegments(content: string): MessageSegment[] {
  if (!hasRawToolCallMarker(content)) return [{ type: "text", text: content }];
  const segments: MessageSegment[] = [];
  let cursor = 0;
  BLOCK_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_START.exec(content)) !== null) {
    if (match.index > cursor) segments.push({ type: "text", text: content.slice(cursor, match.index) });
    const bodyStart = match.index + match[0].length;
    const rest = content.slice(bodyStart);
    const endMatch = BLOCK_END.exec(rest);
    const body = endMatch ? rest.slice(0, endMatch.index) : rest;
    const incomplete = !endMatch;
    const calls = parseCalls(body);
    segments.push({ type: "tools", calls: calls ?? [], raw: body.trim(), incomplete: incomplete && !calls });
    cursor = endMatch ? bodyStart + endMatch.index + endMatch[0].length : content.length;
    BLOCK_START.lastIndex = cursor;
  }
  if (cursor < content.length) segments.push({ type: "text", text: content.slice(cursor) });
  return segments;
}

/** 工具名 → 面向用户的中文标签。 */
const TOOL_LABEL: Record<string, string> = {
  import_chapters: "导入章节",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "搜索内容",
  ls: "列出目录",
  sub_agent: "子任务",
  propose_action: "提议操作",
  research_web: "联网检索",
  ingest_material: "入库素材",
  retrieve_material: "检索素材",
  generate_cover: "生成封面",
  patch_chapter_text: "修补章节",
  replace_chapter_text: "替换章节",
  rename_entity: "重命名实体",
  write_truth_file: "写入设定",
  short_fiction_run: "短篇生成",
  translation_create: "创建翻译",
  script_create: "创建剧本",
  storyboard_create: "创建分镜",
  interactive_film_create: "创建互动影视",
  audit_chapter: "审计章节",
  revise_chapter: "修订章节",
};

/** 参数摘要：挑人能读懂的常见键，最多 4 行；其余进「查看详情」。 */
const SUMMARY_KEYS = [
  "file", "path", "book_id", "bookId", "subdir", "mode", "start_chapter", "startChapter",
  "chapter", "chapters", "query", "pattern", "url", "title", "task", "name",
] as const;

function summarizeArgs(args: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const key of SUMMARY_KEYS) {
    if (rows.length >= 4) break;
    const value = args[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    rows.push([key, text.length > 80 ? `${text.slice(0, 80)}…` : text]);
  }
  if (rows.length === 0) {
    for (const [key, value] of Object.entries(args)) {
      if (rows.length >= 3) break;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      rows.push([key, text.length > 80 ? `${text.slice(0, 80)}…` : text]);
    }
  }
  return rows;
}

function ToolCallCard({ call }: { call: RawToolCall }) {
  const [open, setOpen] = useState(false);
  const rows = summarizeArgs(call.arguments);
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <Wrench size={13} className="shrink-0 text-primary" />
        <span className="text-[13px] font-medium text-foreground">{TOOL_LABEL[call.name] ?? call.name}</span>
        <CheckCircle2 size={13} className="shrink-0 text-muted-foreground/50" />
        <button
          onClick={() => setOpen(!open)}
          className="ml-auto inline-flex items-center gap-0.5 text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 查看详情
        </button>
      </div>
      {rows.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {rows.map(([key, value]) => (
            <div key={key} className="flex gap-1.5 text-[12px] leading-5">
              <span className="shrink-0 text-muted-foreground">{key}：</span>
              <span className="min-w-0 truncate text-foreground/80" title={value}>{value}</span>
            </div>
          ))}
        </div>
      )}
      {open && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-background/80 p-2 text-[11px] leading-4 text-muted-foreground">
          {JSON.stringify(call.arguments, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function RawToolCallBlock({ segment }: { segment: Extract<MessageSegment, { type: "tools" }> }) {
  const [showRaw, setShowRaw] = useState(false);
  if (segment.incomplete) {
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-[13px] text-muted-foreground">
        <Loader2 size={13} className="animate-spin text-primary" /> 正在准备工具调用…
      </div>
    );
  }
  if (segment.calls.length === 0) {
    return (
      <div className="my-1.5 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Wrench size={13} className="shrink-0 text-primary" /> 工具调用
          <button onClick={() => setShowRaw(!showRaw)} className="ml-auto inline-flex items-center gap-0.5 text-[11.5px] hover:text-foreground">
            {showRaw ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 查看详情
          </button>
        </div>
        {showRaw && <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-background/80 p-2 text-[11px] leading-4 text-muted-foreground">{segment.raw}</pre>}
      </div>
    );
  }
  return (
    <div className="my-1.5 space-y-1.5">
      {segment.calls.map((call, i) => <ToolCallCard key={`${call.name}-${i}`} call={call} />)}
    </div>
  );
}
