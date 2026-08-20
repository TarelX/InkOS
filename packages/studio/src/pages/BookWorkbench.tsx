/**
 * InkOS V2 书籍工作台 —— 所有书籍（原创 / 改编）的统一四栏工作界面。
 *
 *   ① 文件管理：项目资产树（按模式分组）+ 搜索 + 章节 + 书签 + 进度
 *   ② Story Architect：Agent 对话
 *   ③ 工作流·实时监控：DAG 节点 + 进度条 + 审批 + 任务日志
 *   ④ Story Intelligence：总览 / 主线结构 / 正文 / 人物关系 / 世界观 / 伏笔
 *
 * 模式（creation | adaptation）由已有产物自动判定，也可在顶栏切换；两种模式
 * 共用同一套栏位与控件，只是数据源与工作流模板不同：
 *   creation  → new-novel        产物 creation.*
 *   adaptation → novel-adaptation 产物 analysis.* + adaptation.*
 *
 * 视觉语言按设计稿固定（深海军蓝顶栏 + 浅灰蓝页面 + 白卡片 + 蓝色主按钮），
 * 不随全局明暗主题漂移。所有状态来自 /api/v2 与 /api/v1，无假数据。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Background, ReactFlow, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Download,
  FileText,
  Film,
  Folder,
  GitBranch,
  Globe2,
  History,
  Import,
  Layers,
  Lightbulb,
  ListTree,
  Loader2,
  Map as MapIcon,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  Star,
  Users,
  XCircle,
} from "lucide-react";

import { ChatPage, type ChatPageProps } from "./ChatPage";

// ---------- API helpers -------------------------------------------------

const V2 = "/api/v2";

async function getV2<T>(path: string): Promise<T> {
  const res = await fetch(`${V2}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return (await res.json()) as T;
}

async function postV2<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${V2}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(data?.error?.message ?? `${res.status} ${path}`);
  return data;
}

// ---------- Types --------------------------------------------------------

/**
 * 书籍角色：决定顶栏动作与默认工作流，但**不再决定第四栏显示什么数据**
 * （画布是数据驱动的，书里有什么就展示什么）。
 *   source     原著/素材：导入的小说，跑「深度拆文」，可发起改编
 *   original   原创作品：new-novel 创作管线
 *   adaptation 改编作品：novel-adaptation 保真管线（需选源书）
 */
type BookRole = "source" | "original" | "adaptation";

const ROLE_LABEL: Record<BookRole, string> = { source: "原著", original: "原创", adaptation: "改编" };
const ROLE_TEMPLATE: Record<BookRole, string> = {
  source: "novel-analysis",
  original: "new-novel",
  adaptation: "novel-adaptation",
};

interface RunRecord {
  runId: string;
  bookId: string;
  templateId: string;
  status: string;
  createdAt: string;
}

interface NodeRecord {
  nodeId: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  outputArtifacts: Array<{ artifactId: string; version: number }>;
  inputVersions: Array<{ artifactId: string; version: number }>;
  gateResult: { pass?: boolean; hardViolations?: string[] } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface ApprovalRecord {
  approvalId: string;
  nodeId: string;
  status: string;
}

interface TemplateInfo {
  id: string;
  label: string;
  order: string[];
  nodes: Array<{ id: string; label: string; executor: string; dependsOn: string[]; approvalRequired: boolean; gate: string | null }>;
}

/** 章节行（/api/v1/books/:id 的 chapters）：状态与审计用于树里的状态徽章。 */
interface ChapterRow {
  number: number;
  title: string;
  status?: string;
  auditIssues?: string[];
}

/** V1 story ledger 的伏笔行（/story-ledger）：总览「当前问题」的数据源之一。 */
interface HookRow {
  hookId: string;
  startChapter?: number;
  type?: string;
  status?: string;
  lastAdvancedChapter?: number;
  expectedPayoff?: string;
  notes?: string;
}

interface ArtifactRow {
  artifactId: string;
  version: number;
  status: string;
  createdBy: string;
  nodeId: string | null;
}

interface RunEvent {
  seq: number;
  type: string;
  nodeId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface DraftRow {
  chapter: number;
  title: string;
  content: string;
}

/** 改编侧 */
interface StoryEventRow {
  id: string;
  chapter: number;
  summary: string;
  participants: string[];
  informationDelta: number;
  conflictDelta: number;
  emotionDelta: number;
  outcome: string | null;
  stateChanges: string[];
}
interface SpineBeat {
  id: string;
  order: number;
  label: string;
  sourceEventIds: string[];
  stateChanges: string[];
  newQuestion: string | null;
  chapterRange: { from: number; to: number } | null;
}
interface ContractDoc {
  sourceBookId: string;
  format: string;
  mustPreserve: Array<{ kind: string; refId: string; note: string }>;
  canChange: string[];
  forbidden: string[];
  target: { genre: string; chapterCount: number | null; pace: string; notes: string };
}
interface StorylineRow { id: string; name: string; type: string; promise: string; eventIds: string[] }
interface PacingDoc {
  scenes: Array<{ sceneId: string; chapter: number; informationDelta: number; conflictDelta: number; emotionDelta: number; stateDelta: number; hookDelta: number; narrativeDelta: number; flags: string[] }>;
  mainlineStalls: Array<{ fromChapter: number; toChapter: number; reason: string }>;
}
interface CharacterMapRow { sourceName: string; targetName: string; strategy: string; tier: string }
interface AdaptChapterContract { chapter: number; chapterGoal: string; conflict: string; exitState: string[]; sourceEventIds: string[]; endHook: string | null }

/** 人物羁绊（relations/extract 产出：LLM 关系分类或共现统计退化）。 */
interface CharacterRelationsDoc {
  source: string;
  llmError?: string;
  extractedAt?: string;
  relations: Array<{
    a: string;
    b: string;
    type: string;
    label: string;
    note: string;
    chapters: number[];
    coChapters: number;
  }>;
}

const RELATION_TYPE_COLORS: Record<string, string> = {
  "盟友": "#059669", "敌对": "#dc2626", "师徒": "#2563eb", "亲属": "#d97706",
  "恋慕": "#db2777", "对手": "#ea580c", "从属": "#7c3aed", "交易": "#0891b2",
  "其他": "#64748b", "同场": "#94a3b8",
};

/** V1 拆解库迁移导入（migration.v1-to-v2 产出，参考级，无可校验 SourceRef）。 */
interface V1ImportDoc {
  importedAt: string;
  note: string;
  chapterRecords: Array<{
    chapterNumber: number;
    title: string;
    characters: Array<{ name: string; count: number }>;
    plot: string;
  }>;
  characterCards: Record<string, string>;
}

/** 原创侧 */
interface CreativeBriefDoc {
  genre: string[];
  targetAudience: string;
  targetChapters: number | null;
  chapterWordTarget: number;
  coreFantasy: string;
  readerPromise: string[];
  tone: string[];
  mustHave: string[];
  mustAvoid: string[];
  pov: string;
  assumptions: string[];
}
interface ConceptDoc {
  candidates: Array<{ id: string; premise: string; coreConflict: string; uniqueMechanism: string; risks: string[]; totalScore: number; scores: Record<string, number> }>;
  lockedConceptId: string | null;
}
interface CanonDoc {
  storyPromise: string;
  themeTensions: Array<[string, string]>;
  centralQuestion: string;
  endingDirection: string;
  rules: Array<{ id: string; statement: string; hardness: string; cost: string }>;
  factions: Array<{ name: string; goal: string }>;
  locations: Array<{ name: string; note: string }>;
  characters: Array<{ id: string; name: string; role: string; want: string; need: string; fear: string; lie: string; boundary: string; arcStart: string; arcEnd: string }>;
  conflictEngine: { protagonistLongGoal: string; systemicObstacle: string; antagonistGoal: string; escalationMechanism: string; victoryCost: string[]; failureCost: string[] };
}
interface CreationSpineDoc {
  beats: Array<{ id: string; order: number; stage: string; label: string; causedBy: string[]; stateChange: string[]; newQuestion: string | null; chapterRange: { from: number; to: number } | null }>;
}
interface ArcPlanDoc {
  arcs: Array<{ id: string; index: number; title: string; promise: string; coreConflict: string; midTurn: string; climax: string; exitState: string[]; beatIds: string[]; chapterRange: { from: number; to: number } | null }>;
}
interface CreationChapterContract { chapter: number; chapterGoal: string; conflict: string; exitState: string[]; beatIds: string[]; mustNot: string[]; endHook: string | null }
interface CreationAuditDoc {
  chapters: Array<{ chapter: number; issues: Array<{ severity: string; category: string; description: string; suggestion: string }>; scores: Record<string, number> }>;
}
interface StateDoc { throughChapter: number; worldState: string[]; openQuestions: string[]; hookLedger: Array<{ id: string; status: string; note: string }> }

// ---------- Design tokens（固定浅色设计稿配色） ----------------------------

const C = {
  page: "bg-[#e8eef6]",
  pane: "bg-[#f3f6fb]",
  card: "rounded-xl border border-[#e2e8f2] bg-white shadow-[0_1px_3px_rgba(15,30,60,0.06)]",
  textMain: "text-slate-800",
  blueBtn: "bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm shadow-[#2563eb]/20",
  ghostBtn: "border border-white/30 bg-white/5 text-white/90 hover:bg-white/10",
  border: "border-[#e2e8f2]",
} as const;

const STATUS_LABEL: Record<string, string> = {
  pending: "等待中", ready: "就绪", running: "进行中", waiting_approval: "待审核",
  succeeded: "已完成", failed: "失败", blocked: "被阻塞", cancelled: "已取消",
  stale: "已过期", interrupted: "被中断",
};

/** 执行器 → 面向用户的 Agent 名（规格书 §21：任务卡必须能回答"谁在干"）。 */
function agentForExecutor(executor: string | undefined): string {
  if (!executor) return "Story Architect";
  if (/draft/.test(executor)) return "Chapter Writer";
  if (/audit|settle/.test(executor)) return "Continuity Reviewer";
  if (executor.startsWith("si.")) return "Story Analyst";
  if (executor.startsWith("adapt.")) return "Story Architect";
  if (executor.startsWith("novel.")) return "Story Architect";
  return "Story Architect";
}

/** 章节状态 → 徽章样式（规格书 §8）。 */
const CHAPTER_STATUS_BADGE: Record<string, { dot: string; label: string; text: string }> = {
  approved: { dot: "bg-emerald-500", label: "已审校", text: "text-emerald-600" },
  "ready-for-review": { dot: "bg-amber-400", label: "待审校", text: "text-amber-600" },
  draft: { dot: "bg-[#2563eb]", label: "草稿", text: "text-[#2563eb]" },
  generating: { dot: "bg-[#2563eb] animate-pulse", label: "生成中", text: "text-[#2563eb]" },
  imported: { dot: "bg-slate-300", label: "已导入", text: "text-slate-400" },
};

function ChapterStatusDot({ chapter }: { chapter: ChapterRow }) {
  const warnings = (chapter.auditIssues ?? []).filter((s) => s.startsWith("[warning]")).length;
  if (warnings > 0) {
    return (
      <span title={`${warnings} 条审计警告`} className="flex shrink-0 items-center gap-0.5 text-[10.5px] text-orange-500">
        <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />警
      </span>
    );
  }
  const badge = chapter.status ? CHAPTER_STATUS_BADGE[chapter.status] : undefined;
  if (!badge) return null;
  return <span title={badge.label} className={`h-1.5 w-1.5 shrink-0 rounded-full ${badge.dot}`} />;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "succeeded": return <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />;
    case "running": return <Loader2 size={15} className="text-[#2563eb] animate-spin shrink-0" />;
    case "waiting_approval": return <ShieldAlert size={15} className="text-amber-500 shrink-0" />;
    case "failed": return <XCircle size={15} className="text-red-500 shrink-0" />;
    case "stale": return <RefreshCw size={15} className="text-orange-400 shrink-0" />;
    case "blocked": case "cancelled": return <Square size={15} className="text-slate-400 shrink-0" />;
    default: return <CircleDashed size={15} className="text-slate-300 shrink-0" />;
  }
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = Math.floor(s / 3600);
  return hh > 0 ? `${pad(hh)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function Card({ title, extra, children, className = "" }: { title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`${C.card} ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
          <span className={`text-[13.5px] font-semibold ${C.textMain}`}>{title}</span>
          {extra}
        </div>
      )}
      <div className={title ? "px-4 pb-4" : "p-4"}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12.5px] leading-6 text-slate-400">{children}</p>;
}

// ---------- Canvas config ---------------------------------------------------

/**
 * 每个 Tab 需要的产物（懒加载、按版本缓存）。数据驱动：不区分书籍角色，
 * 书里存在哪个产物就加载哪个，画布按数据有无渲染分区。
 */
const TAB_ARTIFACTS: Record<CanvasTab, ReadonlyArray<string>> = {
  overview: [
    "creation.brief", "creation.concepts", "creation.canon", "creation.spine", "creation.arcs",
    "creation.chapter-contracts", "creation.audit-report",
    "adaptation.contract", "adaptation.target-spine", "adaptation.chapter-contracts", "adaptation.character-map",
    "analysis.storylines", "analysis.pacing", "analysis.events", "analysis.character-relations",
    "v1-import.deconstruct",
  ],
  spine: ["creation.spine", "creation.arcs", "adaptation.target-spine", "analysis.storylines", "v1-import.deconstruct"],
  drafts: ["creation.drafts", "adaptation.drafts"],
  characters: ["creation.canon", "adaptation.character-map", "analysis.events", "v1-import.deconstruct", "analysis.character-relations"],
  world: ["creation.canon", "adaptation.contract"],
  hooks: ["creation.state", "creation.audit-report", "analysis.pacing"],
};

const CANVAS_TABS = [
  { id: "overview", label: "总览" },
  { id: "spine", label: "主线结构" },
  { id: "drafts", label: "正文" },
  { id: "characters", label: "人物关系" },
  { id: "world", label: "世界观" },
  { id: "hooks", label: "伏笔" },
] as const;
type CanvasTab = (typeof CANVAS_TABS)[number]["id"];

/** 第一列的资产分组：数据驱动，四组全列出，空组自动隐藏。 */
const EXPLORER_GROUPS: ReadonlyArray<{ label: string; prefix: string; icon: React.ReactNode }> = [
  { label: "创作方案", prefix: "creation.", icon: <Lightbulb size={13} className="text-amber-500" /> },
  { label: "改编方案", prefix: "adaptation.", icon: <MapIcon size={13} className="text-[#2563eb]" /> },
  { label: "拆文库", prefix: "analysis.", icon: <Layers size={13} className="text-violet-500" /> },
  { label: "拆解导入（V1）", prefix: "v1-import.", icon: <Import size={13} className="text-slate-500" /> },
];

/** 产物 id → 中文短名，第一列树里显示给人看。 */
const ARTIFACT_LABEL: Record<string, string> = {
  "creation.brief": "创作简报",
  "creation.concepts": "故事方案",
  "creation.canon": "世界观 Canon",
  "creation.spine": "主线骨架",
  "creation.arcs": "卷纲",
  "creation.chapter-contracts": "章级契约",
  "creation.drafts": "章节正文",
  "creation.audit-report": "审计报告",
  "creation.state": "当前状态",
  "adaptation.contract": "改编契约",
  "adaptation.event-map": "事件映射",
  "adaptation.character-map": "人物映射",
  "adaptation.target-spine": "目标骨架",
  "adaptation.chapter-contracts": "章级契约",
  "adaptation.drafts": "改编正文",
  "adaptation.audit-report": "保真审计",
  "analysis.scenes": "场景",
  "analysis.events": "事件",
  "analysis.entities": "实体",
  "analysis.entity-merge-proposals": "实体合并提案",
  "analysis.causal-graph": "因果图",
  "analysis.storylines": "故事线",
  "analysis.pacing": "节奏报告",
  "analysis.character-relations": "人物羁绊",
  "v1-import.deconstruct": "V1 全书拆解",
};

function artifactLabel(id: string): string {
  return ARTIFACT_LABEL[id] ?? id.replace(/^(creation|adaptation|analysis)\./, "");
}

// ---------- Main -----------------------------------------------------------

/** 工作台用的导航：ChatPage 的 nav 加上章节/设置跳转（宿主 App 提供）。 */
type WorkbenchNav = ChatPageProps["nav"] & {
  toChapter?: (bookId: string, chapterNumber: number) => void;
  toBookSettings?: (bookId: string) => void;
};

export interface BookWorkbenchProps {
  readonly bookId: string;
  readonly nav: WorkbenchNav;
  readonly theme: ChatPageProps["theme"];
  readonly t: ChatPageProps["t"];
  readonly sse: ChatPageProps["sse"];
}

export function BookWorkbench({ bookId, nav, theme, t, sse }: BookWorkbenchProps) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [runStatus, setRunStatus] = useState<string>("");
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [logs, setLogs] = useState<RunEvent[]>([]);
  const [nodeProgress, setNodeProgress] = useState<Record<string, { completed: number; total: number }>>({});
  const [books, setBooks] = useState<Array<{ id: string; title: string; genre?: string }>>([]);
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [sourceChapters, setSourceChapters] = useState<ChapterRow[]>([]);
  const [hooks, setHooks] = useState<HookRow[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "error">("all");
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description?: string; source?: string }>>([]);
  const [targetChapters, setTargetChapters] = useState<number | null>(null);
  const [sourceBookId, setSourceBookId] = useState<string>(() => {
    // 「发起改编」从原著页跳转过来时的源书交接
    try {
      const pending = localStorage.getItem(`inkos-v2-pending-source-${bookId}`);
      if (pending) { localStorage.removeItem(`inkos-v2-pending-source-${bookId}`); return pending; }
    } catch { /* ignore */ }
    return "";
  });
  const [ideaInput, setIdeaInput] = useState<string>("");
  const [roleOverride, setRoleOverride] = useState<BookRole | null>(() => {
    const stored = localStorage.getItem(`inkos-v2-role-${bookId}`);
    return stored === "source" || stored === "original" || stored === "adaptation" ? stored : null;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<CanvasTab>("overview");
  const [docs, setDocs] = useState<Record<string, unknown>>({});
  const [search, setSearch] = useState("");
  const [wfCollapsed, setWfCollapsed] = useState(false);
  const [wfView, setWfView] = useState<"list" | "graph">(() =>
    localStorage.getItem("inkos-v2-wf-view") === "graph" ? "graph" : "list");
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selChar, setSelChar] = useState<string | null>(null);
  const [reader, setReader] = useState<{ bookId: string; number: number } | null>(null);
  const [adaptTargetPick, setAdaptTargetPick] = useState<string>("");
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`inkos-v2-bookmarks-${bookId}`) ?? "[]"); } catch { return []; }
  });
  const [now, setNow] = useState(() => Date.now());
  const esRef = useRef<EventSource | null>(null);

  // ---- 书籍角色判定：产物 > 运行 > 章节形态；用户可覆盖（持久化） ----
  const detectedRole: BookRole = useMemo(() => {
    if (artifacts.some((a) => a.artifactId.startsWith("adaptation."))) return "adaptation";
    if (artifacts.some((a) => a.artifactId.startsWith("creation."))) return "original";
    if (runs.some((r) => r.templateId === "novel-adaptation")) return "adaptation";
    if (runs.some((r) => r.templateId === "new-novel")) return "original";
    // 有拆解数据（V1 导入或 V2 拆文）但没有改编/创作产物 = 被分析的原著素材
    if (artifacts.some((a) => a.artifactId.startsWith("v1-import.") || a.artifactId.startsWith("analysis."))) return "source";
    if (runs.some((r) => r.templateId === "novel-analysis")) return "source";
    // 空产物：章节多半是导入的 → 原著；否则按原创新书对待
    return chapters.length >= 10 ? "source" : "original";
  }, [artifacts, runs, chapters.length]);
  const role: BookRole = roleOverride ?? detectedRole;
  const setRole = (next: BookRole) => {
    setRoleOverride(next);
    try { localStorage.setItem(`inkos-v2-role-${bookId}`, next); } catch { /* ignore */ }
  };

  // 第三列展示的模板跟随选中的运行；没有运行时用角色默认模板
  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? null;
  const template = useMemo(
    () => templates.find((x) => x.id === (selectedRun?.templateId ?? ROLE_TEMPLATE[role])) ?? null,
    [templates, selectedRun, role],
  );

  const toggleBookmark = (key: string) => {
    setBookmarks((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      localStorage.setItem(`inkos-v2-bookmarks-${bookId}`, JSON.stringify(next));
      return next;
    });
  };

  // ---- loading ----
  const refreshRuns = useCallback(async () => {
    const list = await getV2<RunRecord[]>(`/runs?bookId=${encodeURIComponent(bookId)}`).catch(() => []);
    setRuns(list);
    setSelectedRunId((current) => current ?? list[0]?.runId ?? null);
  }, [bookId]);

  const refreshRunDetail = useCallback(async () => {
    if (!selectedRunId) return;
    const detail = await getV2<{ run: RunRecord; nodes: NodeRecord[]; approvals: ApprovalRecord[] }>(`/runs/${selectedRunId}`).catch(() => null);
    if (!detail) return;
    setRunStatus(detail.run.status);
    setNodes(detail.nodes);
    setApprovals(detail.approvals.filter((a) => a && a.status === "pending"));
  }, [selectedRunId]);

  const refreshArtifacts = useCallback(async () => {
    setArtifacts(await getV2<ArtifactRow[]>(`/books/${encodeURIComponent(bookId)}/artifacts`).catch(() => []));
  }, [bookId]);

  useEffect(() => {
    void getV2<TemplateInfo[]>("/templates").then(setTemplates).catch(() => setTemplates([]));
    void fetch("/api/v1/books")
      .then((r) => r.json())
      .then((data: { books?: Array<{ id: string; title: string; genre?: string }> } | Array<{ id: string; title: string }>) => {
        const list = Array.isArray(data) ? data : data?.books;
        setBooks(Array.isArray(list) ? list : []);
      })
      .catch(() => setBooks([]));
    void fetch("/api/v1/skills")
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((data: { skills?: Array<{ id: string; name: string; description?: string; source?: string }> }) =>
        setSkills(Array.isArray(data?.skills) ? data.skills : []))
      .catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    void fetch(`/api/v1/books/${encodeURIComponent(bookId)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { book?: { targetChapters?: number }; chapters?: ChapterRow[] }) => {
        setChapters(Array.isArray(data?.chapters) ? data.chapters : []);
        setTargetChapters(typeof data?.book?.targetChapters === "number" ? data.book.targetChapters : null);
      })
      .catch(() => setChapters([]));
    // 伏笔台账（V1 story ledger）：总览「当前问题」的数据源，失败静默降级
    void fetch(`/api/v1/books/${encodeURIComponent(bookId)}/story-ledger`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { hooks?: HookRow[] }) => setHooks(Array.isArray(data?.hooks) ? data.hooks : []))
      .catch(() => setHooks([]));
  }, [bookId]);

  useEffect(() => { void refreshRuns(); void refreshArtifacts(); }, [refreshRuns, refreshArtifacts]);
  useEffect(() => { void refreshRunDetail(); }, [refreshRunDetail]);

  // 运行列表轮询：本页之外发起的任务（另一个窗口、CLI、桌面端）也要出现在
  // 第三列。节点级更新仍走 SSE，这里只做低频的列表对账。
  useEffect(() => {
    const timer = setInterval(() => { void refreshRuns(); }, 5000);
    const onFocus = () => { void refreshRuns(); void refreshArtifacts(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refreshRuns, refreshArtifacts]);

  // 新运行出现时自动跟随（用户没有手动选择别的运行时）。
  const latestRunId = runs[0]?.runId ?? null;
  useEffect(() => {
    setSelectedRunId((current) => {
      if (!latestRunId) return current;
      if (!current) return latestRunId;
      // 当前选中的运行已结束、且有更新的运行时切过去。
      const currentRun = runs.find((r) => r.runId === current);
      const currentDone = currentRun && ["succeeded", "failed", "cancelled"].includes(currentRun.status);
      return currentDone && current !== latestRunId ? latestRunId : current;
    });
  }, [latestRunId, runs]);

  const runActive = runStatus === "running" || runStatus === "waiting_approval" || runStatus === "created";
  useEffect(() => {
    if (!runActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runActive]);

  // ---- SSE ----
  useEffect(() => {
    esRef.current?.close();
    setLogs([]);
    setNodeProgress({});
    if (!selectedRunId) return;
    const es = new EventSource(`${V2}/runs/${selectedRunId}/events`);
    esRef.current = es;
    const onAny = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as RunEvent;
        if (typeof event.seq === "number") {
          setLogs((prev) => (prev.some((e) => e.seq === event.seq) ? prev : [...prev.slice(-299), event]));
          if (event.type === "workflow.node.progress" && event.nodeId) {
            const completed = Number(event.payload?.completed ?? NaN);
            const total = Number(event.payload?.total ?? NaN);
            if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
              setNodeProgress((prev) => ({ ...prev, [event.nodeId as string]: { completed, total } }));
            }
          }
        }
      } catch { /* heartbeat */ }
      void refreshRunDetail();
      void refreshArtifacts();
    };
    for (const type of [
      "workflow.run.created", "workflow.run.started", "workflow.run.completed", "workflow.run.failed",
      "workflow.run.cancelled", "workflow.node.started", "workflow.node.succeeded", "workflow.node.failed",
      "workflow.node.gate_failed", "workflow.node.waiting_approval", "workflow.node.artifact",
      "workflow.node.progress", "workflow.node.retry_scheduled", "workflow.node.retried",
      "workflow.node.blocked", "workflow.node.stale", "workflow.node.requeued", "workflow.node.cancelled",
      "workflow.node.interrupted", "workflow.pump.error",
    ]) {
      es.addEventListener(type, onAny as EventListener);
    }
    es.addEventListener("workflow.stream.end", () => es.close());
    return () => es.close();
  }, [selectedRunId, refreshRunDetail, refreshArtifacts]);

  // ---- canvas docs ----
  const latestByArtifact = useMemo(() => {
    const map = new Map<string, ArtifactRow>();
    for (const row of artifacts) {
      if (row.status === "rejected" || row.status === "superseded") continue;
      const existing = map.get(row.artifactId);
      if (!existing || row.version > existing.version) map.set(row.artifactId, row);
    }
    return map;
  }, [artifacts]);

  useEffect(() => {
    for (const artifactId of TAB_ARTIFACTS[tab]) {
      const row = latestByArtifact.get(artifactId);
      if (!row) continue;
      const key = `${artifactId}@${row.version}`;
      if (docs[key] !== undefined) continue;
      void getV2<unknown>(`/books/${encodeURIComponent(bookId)}/artifacts/${artifactId}/${row.version}/content`)
        .then((data) => setDocs((prev) => ({ ...prev, [key]: data })))
        .catch(() => setDocs((prev) => ({ ...prev, [key]: null })));
    }
  }, [tab, latestByArtifact, bookId, docs]);

  const doc = useCallback(<T,>(artifactId: string): T | null => {
    const row = latestByArtifact.get(artifactId);
    if (!row) return null;
    return (docs[`${artifactId}@${row.version}`] as T) ?? null;
  }, [latestByArtifact, docs]);

  // ---- 原著（源书）：用户顶栏选择优先，否则从已生成的改编契约里回读 ----
  const contractSourceId = doc<ContractDoc>("adaptation.contract")?.sourceBookId ?? "";
  const effectiveSourceId = role === "adaptation" ? (sourceBookId || contractSourceId) : "";
  useEffect(() => {
    if (!effectiveSourceId) { setSourceChapters([]); return; }
    void fetch(`/api/v1/books/${encodeURIComponent(effectiveSourceId)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { chapters?: Array<{ number: number; title: string }> }) =>
        setSourceChapters(Array.isArray(data?.chapters) ? data.chapters : []))
      .catch(() => setSourceChapters([]));
  }, [effectiveSourceId]);

  // ---- actions ----
  const startRun = async () => {
    if (role === "adaptation" && !effectiveSourceId) {
      setNotice("改编工作流需要先在顶栏选择原著（源书）");
      return;
    }
    setBusy("start");
    try {
      const params =
        role === "adaptation" ? { sourceBookId: effectiveSourceId }
        : role === "original" ? {
            idea: ideaInput.trim(),
            genre: books.find((b) => b.id === bookId)?.genre ?? "",
            targetChapters: targetChapters ?? undefined,
          }
        : {}; // source：深度拆文分析本书自身
      const run = await postV2<RunRecord>(`/books/${encodeURIComponent(bookId)}/runs`, {
        templateId: ROLE_TEMPLATE[role],
        params,
      });
      setSelectedRunId(run.runId);
      await refreshRuns();
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** 人物羁绊提取：LLM 分类关系（无 LLM 退化为共现统计并明示）。 */
  const extractRelations = async () => {
    setBusy("relations");
    try {
      const res = await postV2<{ ok: boolean; count: number; source: string; llmError?: string }>(
        `/books/${encodeURIComponent(bookId)}/relations/extract`,
      );
      await refreshArtifacts();
      setNotice(res.source === "llm"
        ? `人物羁绊已生成（LLM 分析，${res.count} 对关系）`
        : `人物羁绊已生成（仅共现统计${res.llmError ? `，LLM 失败：${res.llmError.slice(0, 120)}` : "，未配置 LLM"}）`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** 原著页「发起改编」：选定目标书后交接源书并跳转到目标书工作台。 */
  const startAdaptationTo = (targetId: string) => {
    if (!targetId) return;
    try {
      localStorage.setItem(`inkos-v2-pending-source-${targetId}`, bookId);
      localStorage.setItem(`inkos-v2-role-${targetId}`, "adaptation");
    } catch { /* ignore */ }
    nav.toBook(targetId);
  };

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await refreshRunDetail();
      await refreshRuns();
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // ---- derived ----
  const orderedNodes = useMemo(() => {
    if (!template) return nodes;
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    return template.order.map((id) => byId.get(id)).filter((n): n is NodeRecord => Boolean(n));
  }, [template, nodes]);

  const nodeLabel = useCallback(
    (nodeId: string) => templates.flatMap((tpl) => tpl.nodes).find((n) => n.id === nodeId)?.label ?? nodeId,
    [templates],
  );

  const wfStats = useMemo(() => {
    const total = orderedNodes.length;
    const done = orderedNodes.filter((n) => n.status === "succeeded").length;
    const selectedRun = runs.find((r) => r.runId === selectedRunId);
    const elapsed = selectedRun ? now - Date.parse(selectedRun.createdAt) : 0;
    const durations = orderedNodes
      .filter((n) => n.startedAt && n.finishedAt)
      .map((n) => Date.parse(n.finishedAt!) - Date.parse(n.startedAt!))
      .filter((d) => d > 0);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    return { total, done, elapsed, eta: avg > 0 ? avg * (total - done) : NaN };
  }, [orderedNodes, runs, selectedRunId, now]);

  // 每个节点最近一条带消息的事件 → 任务卡上的"当前动作"（规格书 §54：显示具体动作而不是"加载中"）
  const lastActionByNode = useMemo(() => {
    const map: Record<string, string> = {};
    for (const event of logs) {
      if (!event.nodeId) continue;
      const message = event.payload?.message;
      if (typeof message === "string" && message.trim()) map[event.nodeId] = message.trim();
    }
    return map;
  }, [logs]);

  const groupedArtifacts = useMemo(() => {
    const seen = new Set<string>();
    return EXPLORER_GROUPS.map((group) => ({
      ...group,
      rows: [...artifacts]
        .sort((a, b) => a.artifactId.localeCompare(b.artifactId) || b.version - a.version)
        .filter((row) => {
          if (!row.artifactId.startsWith(group.prefix) || seen.has(row.artifactId)) return false;
          seen.add(row.artifactId);
          return true;
        }),
    }));
  }, [artifacts]);

  const bookTitle = books.find((b) => b.id === bookId)?.title ?? bookId;
  const chapterPct = targetChapters ? Math.min(100, Math.round((chapters.length / targetChapters) * 100)) : null;

  // 项目树里的计数徽章：数据驱动，产物懒加载完成前显示为空
  const canonForTree = doc<CanonDoc>("creation.canon");
  const charMapForTree = doc<CharacterMapRow[]>("adaptation.character-map");
  const v1ForTree = doc<V1ImportDoc>("v1-import.deconstruct");

  /** 打开章节阅读器（第四栏正文 Tab 内联展示，不跳出工作台）。 */
  const openChapter = (targetBookId: string, number: number) => {
    setReader({ bookId: targetBookId, number });
    setTab("drafts");
  };

  /** Context 联动：按产物 id 跳到最合适的画布 Tab。 */
  const openArtifactInCanvas = (artifactId: string) => {
    const target: CanvasTab =
      /drafts$/.test(artifactId) ? "drafts"
      : /spine|storylines|arcs/.test(artifactId) ? "spine"
      : /character|entities/.test(artifactId) ? "characters"
      : /contract$|canon$/.test(artifactId) ? "world"
      : /pacing|audit|state|foreshadow/.test(artifactId) ? "hooks"
      : "overview";
    setTab(target);
  };

  return (
    <div className={`absolute inset-0 flex flex-col min-w-0 ${C.page}`}>
      {/* ======= 顶栏（规格书 §4：52px，左=项目 / 中=引擎状态+模式 / 右=主操作） ======= */}
      <div className="h-[52px] shrink-0 flex items-center justify-between gap-3 px-4 bg-[#0e1a30] text-white shadow-md">
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-2.5">
          <span className="flex items-center gap-1.5 rounded-lg bg-[#2563eb] px-2 py-1 text-[13px] font-bold">
            <Sparkles size={13} /> InkOS V2
          </span>
          <span className="min-w-0 truncate text-[15px] font-semibold">
            {bookTitle ? `《${bookTitle}》` : "未命名书籍"}
            <span className="ml-1.5 font-normal text-white/70">{ROLE_LABEL[role]}工作台</span>
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-[12px] font-medium text-emerald-300">
            <span className={`h-1.5 w-1.5 rounded-full bg-emerald-400 ${runActive ? "animate-pulse" : ""}`} /> Workflow Engine V2
          </span>
          {/* 书籍角色：只决定动作与默认工作流，画布数据不受影响 */}
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as BookRole)}
            title="书籍角色：原著=导入素材（跑拆文/发起改编）；原创=创作管线；改编=保真改编管线"
            className="shrink-0 rounded-lg border border-white/20 bg-white/10 px-2 py-1 text-[12px] font-medium text-white [&>option]:text-slate-800"
          >
            {(["source", "original", "adaptation"] as const).map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}模式{r === detectedRole ? "（自动）" : ""}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 basis-0 items-center justify-end gap-1.5">
          {role === "adaptation" && (
            <select
              value={sourceBookId || contractSourceId}
              onChange={(e) => setSourceBookId(e.target.value)}
              className="max-w-[170px] rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-[12.5px] text-white [&>option]:text-slate-800"
            >
              <option value="">选择原著（源书）…</option>
              {books.filter((b) => b.id !== bookId).map((b) => (
                <option key={b.id} value={b.id}>{b.title || b.id}</option>
              ))}
            </select>
          )}
          {role === "original" && (
            <input
              value={ideaInput}
              onChange={(e) => setIdeaInput(e.target.value)}
              placeholder="一句话创意（可留空）"
              title="创作简报的起点：一句话说清核心爽点"
              className="w-[190px] rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-[12.5px] text-white placeholder:text-white/40"
            />
          )}
          <button
            onClick={startRun}
            disabled={busy !== null}
            title={role === "source" ? "对本书跑 V2 深度拆文（事件/因果/故事线/节奏）" : role === "original" ? "创作管线：简报 → Canon → 主线 → 章契约 → 正文" : "保真改编管线：拆文 → 契约 → 映射 → 生成"}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-50 ${C.blueBtn}`}
          >
            {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {role === "source" ? "深度拆文" : "新建工作流"}
          </button>
          {role === "source" && (
            <select
              value={adaptTargetPick}
              onChange={(e) => { setAdaptTargetPick(e.target.value); startAdaptationTo(e.target.value); }}
              title="以本书为原著发起改编：选择改编目标书（改编产物与正文落在目标书）"
              className="max-w-[150px] rounded-lg border border-white/25 bg-white/10 px-2 py-1.5 text-[12.5px] text-white/90 [&>option]:text-slate-800"
            >
              <option value="">发起改编 → 选目标书…</option>
              {books.filter((b) => b.id !== bookId).map((b) => (
                <option key={b.id} value={b.id}>{b.title || b.id}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => selectedRunId && act("stale", () => postV2(`/runs/${selectedRunId}/stale-sweep`))}
            disabled={!selectedRunId || busy !== null}
            title="检查上游产物变更并标记过期节点"
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] disabled:opacity-40 ${C.ghostBtn}`}
          >
            <RefreshCw size={13} /> 运行分析
          </button>
          <button disabled title="由工作流「章级契约」节点产出" className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] opacity-50 ${C.ghostBtn}`}>
            <ListTree size={13} /> 生成章纲
          </button>
          <button disabled title="漫剧分镜产线在 V2.3 交付" className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] opacity-50 ${C.ghostBtn}`}>
            <Film size={13} /> 生成分镜
          </button>
          <button onClick={() => nav.toBook(bookId)} title="导出走书籍页（TXT/MD/EPUB）" className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] ${C.ghostBtn}`}>
            <Download size={13} /> 导出
          </button>
          <div className="mx-1 h-5 w-px bg-white/15" />
          <button disabled title="通知中心（规划中）" className="rounded-lg p-1.5 text-white/40"><Bell size={15} /></button>
          <button
            onClick={() => (nav.toBookSettings ? nav.toBookSettings(bookId) : nav.toBook(bookId))}
            title="书籍设置"
            className="rounded-lg p-1.5 text-white/70 hover:bg-white/10"
          >
            <Settings size={15} />
          </button>
          <span className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-[#2563eb] to-violet-500 text-[12px] font-bold">创</span>
        </div>
      </div>

      {notice && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-[13px] text-amber-700">{notice}</div>
      )}

      <div className="flex-1 min-h-0">
        <Group orientation="horizontal" className="h-full w-full">
          {/* ======= ① 文件管理 ======= */}
          <Panel defaultSize="15%" minSize="220px" maxSize="320px" className={`border-r ${C.border} ${C.pane}`}>
            <div className="flex h-full flex-col">
              <div className="px-3 pt-3 pb-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className={`text-[13.5px] font-semibold ${C.textMain}`}>文件管理</span>
                  <Star size={13} className="text-slate-400" />
                </div>
                <div className={`flex items-center gap-1.5 rounded-lg border ${C.border} bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(15,30,60,0.04)]`}>
                  <Search size={13} className="shrink-0 text-slate-400" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索章节或文件夹…"
                    className={`w-full bg-transparent text-[12.5px] outline-none placeholder:text-slate-400 ${C.textMain}`}
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                <ExplorerRow icon={<Folder size={13} className="text-amber-500" />} label="项目总览" onClick={() => setTab("overview")} />
                <ExplorerRow icon={<Bot size={13} className="text-[#2563eb]" />} label="书籍会话 / 设定" onClick={() => nav.toBook(bookId)} />

                {/* ---- 书稿（Manuscript）：按 50 章分组折叠（规格书 §7） ---- */}
                <ExplorerSection label={`书稿（${chapters.length}章）`} icon={<BookOpen size={13} className="text-emerald-600" />}>
                  <ChapterTree
                    chapters={chapters}
                    search={search}
                    current={reader?.bookId === bookId ? reader.number : null}
                    onOpen={(number) => openChapter(bookId, number)}
                    bookmarkKey={(number) => `chapter:${number}`}
                    bookmarks={bookmarks}
                    onToggleBookmark={toggleBookmark}
                  />
                  {chapters.length === 0 && <p className="px-2 py-1 text-[12px] text-slate-400">（暂无章节，正文由工作流「章节正文」节点产出）</p>}
                </ExplorerSection>

                {/* ---- 原著导入（仅改编书）：源书章节只读参照 ---- */}
                {role === "adaptation" && (
                  <ExplorerSection
                    label={`原著导入${sourceChapters.length ? `（${sourceChapters.length}章）` : ""}`}
                    icon={<Import size={13} className="text-cyan-600" />}
                    defaultOpen={false}
                  >
                    {effectiveSourceId ? (
                      <>
                        <div className="px-2 py-1 text-[12px] font-medium text-slate-600 truncate">
                          《{books.find((b) => b.id === effectiveSourceId)?.title ?? effectiveSourceId}》
                        </div>
                        <ChapterTree
                          chapters={sourceChapters}
                          search={search}
                          current={reader?.bookId === effectiveSourceId ? reader.number : null}
                          muted
                          onOpen={(number) => openChapter(effectiveSourceId, number)}
                        />
                      </>
                    ) : (
                      <p className="px-2 py-1 text-[12px] text-slate-400">顶栏选择原著后显示源书章节</p>
                    )}
                  </ExplorerSection>
                )}

                {/* ---- 设定集（Story Bible）：数据驱动 ---- */}
                <ExplorerSection label="设定集" icon={<Globe2 size={13} className="text-sky-600" />}>
                  <ExplorerRow
                    icon={<Globe2 size={12} className="text-sky-500" />}
                    label="世界观 / 契约"
                    meta={fmtCount(canonForTree?.rules.length)}
                    onClick={() => setTab("world")}
                  />
                  <ExplorerRow
                    icon={<Users size={12} className="text-violet-500" />}
                    label="人物卡 / 映射"
                    meta={fmtCount(
                      canonForTree?.characters.length
                        ?? charMapForTree?.length
                        ?? (v1ForTree ? Object.keys(v1ForTree.characterCards).length : undefined),
                    )}
                    onClick={() => setTab("characters")}
                  />
                  {canonForTree && (
                    <>
                      <ExplorerRow
                        icon={<Users size={12} className="text-orange-500" />}
                        label="阵营 / 势力"
                        meta={fmtCount(canonForTree.factions.length)}
                        onClick={() => setTab("world")}
                      />
                      <ExplorerRow
                        icon={<MapIcon size={12} className="text-emerald-500" />}
                        label="地点"
                        meta={fmtCount(canonForTree.locations.length)}
                        onClick={() => setTab("world")}
                      />
                    </>
                  )}
                </ExplorerSection>

                {/* ---- 主线脉络（Story Intelligence）：数据驱动 ---- */}
                <ExplorerSection label="主线脉络" icon={<GitBranch size={13} className="text-[#2563eb]" />}>
                  <ExplorerRow icon={<ListTree size={12} className="text-[#2563eb]" />} label="主线骨架" onClick={() => setTab("spine")} />
                  <ExplorerRow
                    icon={<GitBranch size={12} className="text-violet-500" />}
                    label="故事线 / 卷纲"
                    onClick={() => setTab("spine")}
                  />
                  <ExplorerRow icon={<Sparkles size={12} className="text-amber-500" />} label="伏笔线" onClick={() => setTab("hooks")} />
                  <ExplorerRow icon={<FileText size={12} className="text-rose-500" />} label="节奏 / 审计" onClick={() => setTab("hooks")} />
                </ExplorerSection>

                {/* ---- 方案产物（带版本徽章） ---- */}
                {groupedArtifacts.map((group) =>
                  group.rows.length === 0 ? null : (
                    <ExplorerSection key={group.label} label={group.label} icon={group.icon}>
                      {group.rows
                        .filter((row) => !search || artifactLabel(row.artifactId).includes(search) || row.artifactId.includes(search))
                        .map((row) => (
                          <div
                            key={row.artifactId}
                            className="group flex items-center justify-between gap-1 rounded-md px-2 py-1 text-[12.5px] text-slate-600 hover:bg-[#e8eefb]"
                            title={`${row.artifactId} · v${row.version} · ${row.status}`}
                          >
                            <span className="truncate">{artifactLabel(row.artifactId)}</span>
                            <span className="flex items-center gap-1">
                              <button onClick={() => toggleBookmark(`artifact:${row.artifactId}`)} className="opacity-0 group-hover:opacity-100">
                                <Star size={11} className={bookmarks.includes(`artifact:${row.artifactId}`) ? "fill-amber-400 text-amber-400" : "text-slate-300"} />
                              </button>
                              <span className={`rounded px-1 text-[11px] ${row.status === "accepted" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                                v{row.version}
                              </span>
                            </span>
                          </div>
                        ))}
                    </ExplorerSection>
                  ),
                )}

                {/* ---- 资源分镜（Visual Production，V2.3 交付） ---- */}
                <ExplorerSection label="资源分镜" icon={<Film size={13} className="text-slate-400" />} defaultOpen={false}>
                  {["改编剧本", "分镜表", "画面提示词", "质检报告"].map((label) => (
                    <ExplorerRow
                      key={label}
                      icon={<Film size={12} className="text-slate-300" />}
                      label={label}
                      meta="V2.3"
                      disabled
                      title="漫剧分镜产线在 V2.3 交付"
                    />
                  ))}
                </ExplorerSection>

                {/* ---- 资产库（Skills / Rules） ---- */}
                <ExplorerSection label={`资产库（${skills.length} 技能）`} icon={<Package size={13} className="text-teal-600" />} defaultOpen={false}>
                  {skills.slice(0, 8).map((skill) => (
                    <div
                      key={skill.id}
                      title={skill.description ?? skill.id}
                      className="flex items-center justify-between gap-1 rounded-md px-2 py-1 text-[12.5px] text-slate-600 hover:bg-[#e8eefb]"
                    >
                      <span className="truncate">{skill.name}</span>
                      <span className="shrink-0 rounded bg-slate-100 px-1 text-[10.5px] text-slate-500">
                        {skill.source === "project" ? "项目" : "内置"}
                      </span>
                    </div>
                  ))}
                  {skills.length > 8 && <p className="px-2 py-1 text-[11.5px] text-slate-400">…共 {skills.length} 个技能（书籍设置里管理）</p>}
                  {skills.length === 0 && <p className="px-2 py-1 text-[12px] text-slate-400">（未安装技能）</p>}
                </ExplorerSection>

                {/* ---- 运行记录（Runs） ---- */}
                <ExplorerSection label={`运行记录（${runs.length}）`} icon={<History size={13} className="text-slate-500" />} defaultOpen={false}>
                  {runs.slice(0, 12).map((run) => (
                    <button
                      key={run.runId}
                      onClick={() => { setSelectedRunId(run.runId); setWfCollapsed(false); }}
                      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] hover:bg-[#e8eefb] ${run.runId === selectedRunId ? "bg-[#e8eefb] font-medium text-[#1d4ed8]" : "text-slate-600"}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        run.status === "running" ? "animate-pulse bg-[#2563eb]"
                        : run.status === "succeeded" ? "bg-emerald-500"
                        : run.status === "failed" ? "bg-red-500"
                        : "bg-slate-300"}`}
                      />
                      <span className="truncate">
                        {run.templateId === "new-novel" ? "原创" : "改编"} · {run.createdAt.slice(5, 16).replace("T", " ")}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-slate-400">{STATUS_LABEL[run.status] ?? run.status}</span>
                    </button>
                  ))}
                  {runs.length === 0 && <p className="px-2 py-1 text-[12px] text-slate-400">（暂无运行）</p>}
                </ExplorerSection>

                {bookmarks.length > 0 && (
                  <ExplorerSection label="书签 / 收藏" icon={<Star size={13} className="fill-amber-400 text-amber-400" />}>
                    {bookmarks.map((key) => (
                      <div key={key} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-slate-600">
                        <Star size={11} className="fill-amber-400 text-amber-400 shrink-0" />
                        <span className="truncate">{key.startsWith("chapter:") ? `第${key.slice(8)}章` : artifactLabel(key.replace("artifact:", ""))}</span>
                      </div>
                    ))}
                  </ExplorerSection>
                )}
              </div>
              <div className={`shrink-0 border-t ${C.border} bg-white px-3 py-2.5`}>
                {chapterPct !== null && (
                  <div className="mb-1.5">
                    <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                      <span>存储 / 进度</span>
                      <span className="tabular-nums">{chapters.length}/{targetChapters} · {chapterPct}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-[#2563eb]" style={{ width: `${chapterPct}%` }} />
                    </div>
                  </div>
                )}
                <div className="text-[11.5px] text-slate-400">产物 {artifacts.length} · 运行 {runs.length} · 章节 {chapters.length}</div>
              </div>
            </div>
          </Panel>
          <Separator className="w-1 shrink-0 bg-[#e2e8f2] hover:bg-[#2563eb]/40 transition-colors cursor-col-resize" />

          {/* ======= ② Agent 对话 ======= */}
          <Panel defaultSize="22%" minSize="320px" maxSize="460px" className={`border-r ${C.border} bg-white`}>
            <div className="flex h-full flex-col">
              <div className={`flex shrink-0 items-center gap-2.5 border-b ${C.border} bg-white px-3.5 py-3`}>
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2563eb] text-white">
                  <Bot size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className={`text-[14px] font-semibold leading-tight ${C.textMain}`}>Story Architect</div>
                  <div className="mt-0.5 flex items-center gap-1 text-[12px] text-emerald-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 在线
                    <span className="text-slate-400">· {ROLE_LABEL[role]}会话</span>
                  </div>
                </div>
                <div className="hidden min-w-0 shrink text-right text-[11px] leading-4 text-slate-400 lg:block">
                  {reader && <div className="truncate">章节：第{reader.number}章{reader.bookId !== bookId ? "（原著）" : ""}</div>}
                  {selChar && <div className="truncate">人物：{selChar}</div>}
                </div>
              </div>
              <div className="relative min-h-0 flex-1 flex min-w-0">
                <ChatPage activeBookId={bookId} mode="book" nav={nav} theme={theme} t={t} sse={sse} />
              </div>
            </div>
          </Panel>
          <Separator className="w-1 shrink-0 bg-[#e2e8f2] hover:bg-[#2563eb]/40 transition-colors cursor-col-resize" />

          {/* ======= ③ 工作流 ======= */}
          <Panel defaultSize={wfCollapsed ? "48px" : "23%"} minSize={wfCollapsed ? "48px" : "340px"} maxSize={wfCollapsed ? "56px" : "500px"} className={`border-r ${C.border} ${C.pane}`}>
            {wfCollapsed ? (
              <div className="flex h-full flex-col items-center gap-3 pt-3">
                <button onClick={() => setWfCollapsed(false)} title="展开工作流" className="rounded-md p-1.5 hover:bg-[#e8eefb]">
                  <PanelRightOpen size={16} className="text-slate-500" />
                </button>
                <span className="text-[11px] text-slate-500 [writing-mode:vertical-rl]">工作流 {wfStats.done}/{wfStats.total}</span>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="shrink-0 px-3 pt-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[13.5px] font-semibold ${C.textMain}`}>工作流</span>
                      <span className="rounded bg-[#2563eb]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#2563eb]">实时监控</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {runs.length > 1 && (
                        <select
                          value={selectedRunId ?? ""}
                          onChange={(e) => setSelectedRunId(e.target.value || null)}
                          className={`max-w-[110px] rounded border ${C.border} bg-white px-1 py-0.5 text-[11.5px] text-slate-600`}
                        >
                          {runs.map((run) => (
                            <option key={run.runId} value={run.runId}>
                              {run.templateId === "new-novel" ? "原创" : run.templateId === "novel-analysis" ? "拆文" : "改编"} {run.runId.slice(4, 10)}
                            </option>
                          ))}
                        </select>
                      )}
                      <div className="flex rounded-md bg-slate-100 p-0.5 text-[11px]">
                        {(["list", "graph"] as const).map((v) => (
                          <button
                            key={v}
                            onClick={() => { setWfView(v); try { localStorage.setItem("inkos-v2-wf-view", v); } catch { /* ignore */ } }}
                            className={`rounded px-1.5 py-0.5 ${wfView === v ? "bg-white font-semibold text-[#2563eb] shadow-sm" : "text-slate-500"}`}
                          >
                            {v === "list" ? "列表" : "图"}
                          </button>
                        ))}
                      </div>
                      {selectedRunId && runActive && (
                        <button title="取消运行" onClick={() => act("cancel", () => postV2(`/runs/${selectedRunId}/cancel`))} className="rounded p-1 text-slate-400 hover:bg-[#e8eefb] hover:text-red-500">
                          <Square size={13} />
                        </button>
                      )}
                      <button onClick={() => setWfCollapsed(true)} className="inline-flex items-center gap-1 rounded-md bg-[#2563eb]/10 px-2 py-1 text-[11.5px] font-medium text-[#2563eb] hover:bg-[#2563eb]/15">
                        <PanelRightClose size={12} /> 收起
                      </button>
                    </div>
                  </div>
                  {selectedRunId && (
                    <div className={`mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border ${C.border} bg-white px-3 py-2 text-[12px] text-slate-500`}>
                      <span className={runActive ? "font-semibold text-[#2563eb]" : runStatus === "succeeded" ? "font-semibold text-emerald-600" : `font-semibold ${C.textMain}`}>
                        {runActive ? "运行中" : STATUS_LABEL[runStatus] ?? runStatus} {wfStats.done}/{wfStats.total}
                      </span>
                      <span>已用时 <span className="tabular-nums font-semibold text-slate-700">{fmtDuration(wfStats.elapsed)}</span></span>
                      {runActive && Number.isFinite(wfStats.eta) && (
                        <span>预计剩余 <span className="tabular-nums font-semibold text-slate-700">{fmtDuration(wfStats.eta)}</span></span>
                      )}
                    </div>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                  {/* 空态（规格书 §56）：不留空白，用当前角色模板的幽灵步骤预览流程 */}
                  {orderedNodes.length === 0 && (
                    <div className="px-1">
                      <div className={`mb-2 rounded-lg border border-dashed ${C.border} bg-white px-3 py-2 text-[12.5px] leading-5 text-slate-500`}>
                        {role === "original"
                          ? "尚无运行。顶栏输入一句话创意后点「新建工作流」，即按下方步骤执行："
                          : role === "source"
                          ? "尚无运行。点顶栏「深度拆文」对本书跑 V2 分析，即按下方步骤执行："
                          : "尚无运行。顶栏选择原著后点「新建工作流」，即按下方步骤执行："}
                      </div>
                      {(template?.order ?? []).map((id, index) => {
                        const tplNode = template?.nodes.find((n) => n.id === id);
                        return (
                          <div key={id} className={`mb-2 flex items-center gap-2.5 rounded-xl border ${C.border} bg-white px-3 py-2.5`}>
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-400">{index + 1}</span>
                            <span className="flex-1 truncate text-[13.5px] text-slate-600">{tplNode?.label ?? id}</span>
                            {tplNode?.approvalRequired && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-600">需审批</span>}
                            <span className="text-[11px] text-slate-400">等待</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {wfView === "graph" && orderedNodes.length > 0 && template ? (
                    <WorkflowDagView
                      template={template}
                      nodes={orderedNodes}
                      selected={selNode}
                      onSelect={setSelNode}
                    />
                  ) : (
                    orderedNodes.map((node, index) => (
                      <div key={node.nodeId} onClick={() => setSelNode(node.nodeId)} className="cursor-pointer">
                        <WorkflowNodeCard
                          node={node}
                          isFirst={index === 0}
                          label={nodeLabel(node.nodeId)}
                          executor={template?.nodes.find((n) => n.id === node.nodeId)?.executor}
                          currentAction={lastActionByNode[node.nodeId] ?? null}
                          approval={approvals.find((a) => a.nodeId === node.nodeId) ?? null}
                          progress={nodeProgress[node.nodeId] ?? null}
                          busy={busy !== null}
                          now={now}
                          onApprove={(id) => act("approve", () => postV2(`/approvals/${id}/approve`, { by: "creator" }))}
                          onReject={(id) => act("reject", () => postV2(`/approvals/${id}/reject`, { by: "creator" }))}
                          onRetry={() => selectedRunId && act("retry", () => postV2(`/runs/${selectedRunId}/nodes/${node.nodeId}/retry`))}
                        />
                      </div>
                    ))
                  )}
                </div>

                <div className={`max-h-[28%] shrink-0 overflow-y-auto border-t ${C.border} bg-white px-3 py-2.5`}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-slate-700">任务日志（最新）</span>
                    <span className="flex items-center gap-1.5">
                      <span className="flex rounded bg-slate-100 p-0.5 text-[10.5px]">
                        {(["all", "error"] as const).map((f) => (
                          <button
                            key={f}
                            onClick={() => setLogFilter(f)}
                            className={`rounded px-1.5 py-0.5 ${logFilter === f ? "bg-white font-semibold text-[#2563eb] shadow-sm" : "text-slate-500"}`}
                          >
                            {f === "all" ? "全部" : "仅错误"}
                          </button>
                        ))}
                      </span>
                      <span className="text-[11px] text-slate-400">{logs.length} 条</span>
                    </span>
                  </div>
                  {logs
                    .filter((event) => logFilter === "all" || /failed|error|gate_failed|blocked/.test(event.type))
                    .slice(-50)
                    .reverse()
                    .map((event) => (
                      <div key={event.seq} className={`flex gap-2 py-0.5 text-[12px] leading-5 ${/failed|error/.test(event.type) ? "text-red-500" : "text-slate-600"}`}>
                        <span className="shrink-0 tabular-nums text-slate-400">{(event.createdAt ?? "").slice(11, 19)}</span>
                        <span className="truncate">
                          {event.nodeId ? `${nodeLabel(event.nodeId)} · ` : ""}
                          {String(event.payload?.message ?? event.type.replace("workflow.", ""))}
                        </span>
                      </div>
                    ))}
                  {logs.length === 0 && <p className="text-[11.5px] text-slate-400">（暂无事件，运行开始后实时滚动）</p>}
                </div>
              </div>
            )}
          </Panel>
          <Separator className="w-1 shrink-0 bg-[#e2e8f2] hover:bg-[#2563eb]/40 transition-colors cursor-col-resize" />

          {/* ======= ④ Story Intelligence ======= */}
          {/* Story Workspace 必须是最大工作区（规格书 §3） */}
          <Panel defaultSize="40%" minSize="560px" className={C.pane}>
            <div className="flex h-full flex-col">
              <div className={`flex shrink-0 items-center gap-0.5 border-b ${C.border} bg-white px-3 pt-2`}>
                {CANVAS_TABS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    className={`relative px-3.5 py-2.5 text-[13.5px] transition-colors ${tab === item.id ? "font-semibold text-[#2563eb]" : "text-slate-500 hover:text-slate-700"}`}
                  >
                    {item.label}
                    {tab === item.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#2563eb]" />}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
                {tab === "drafts" ? (
                  <ChapterReaderCanvas
                    bookId={bookId}
                    bookTitle={bookTitle}
                    chapters={chapters}
                    sourceId={effectiveSourceId}
                    sourceTitle={books.find((b) => b.id === effectiveSourceId)?.title ?? effectiveSourceId}
                    sourceChapters={sourceChapters}
                    reader={reader}
                    onOpen={(target) => setReader(target)}
                    onOpenExternal={(target) => (nav.toChapter ? nav.toChapter(target.bookId, target.number) : nav.toBook(target.bookId))}
                    drafts={doc<DraftRow[]>("creation.drafts") ?? doc<DraftRow[]>("adaptation.drafts") ?? []}
                  />
                ) : (
                  <StoryCanvas
                    tab={tab}
                    doc={doc}
                    selChar={selChar}
                    setSelChar={setSelChar}
                    onExtractRelations={extractRelations}
                    relationsBusy={busy === "relations"}
                    env={{
                      hooks,
                      chapters,
                      focusChapter: (reader?.bookId === bookId ? reader.number : null) ?? (chapters.length ? chapters[chapters.length - 1].number : null),
                      bookTitle,
                      genre: books.find((b) => b.id === bookId)?.genre,
                      onOpenChapter: (number) => openChapter(bookId, number),
                      onStartAnalysis: role === "source" ? startRun : undefined,
                      startBusy: busy === "start",
                    }}
                  />
                )}
              </div>
            </div>
          </Panel>
        </Group>
      </div>

      {/* ======= 工作流节点详情抽屉 ======= */}
      {selNode && (
        <NodeDetailDrawer
          nodeId={selNode}
          record={nodes.find((n) => n.nodeId === selNode) ?? null}
          label={nodeLabel(selNode)}
          templateNode={template?.nodes.find((n) => n.id === selNode) ?? null}
          logs={logs.filter((e) => e.nodeId === selNode)}
          approval={approvals.find((a) => a.nodeId === selNode) ?? null}
          busy={busy !== null}
          onClose={() => setSelNode(null)}
          onRetry={() => selectedRunId && act("retry", () => postV2(`/runs/${selectedRunId}/nodes/${selNode}/retry`))}
          onApprove={(id) => act("approve", () => postV2(`/approvals/${id}/approve`, { by: "creator" }))}
          onReject={(id) => act("reject", () => postV2(`/approvals/${id}/reject`, { by: "creator" }))}
          onOpenArtifact={openArtifactInCanvas}
        />
      )}
    </div>
  );
}

// ---------- Explorer pieces -------------------------------------------------

/** 树里的计数徽章：数据未加载/为 0 时不显示。 */
function fmtCount(n: number | undefined | null): string | undefined {
  return typeof n === "number" && n > 0 ? String(n) : undefined;
}

function ExplorerRow({ icon, label, onClick, meta, disabled, title }: {
  icon: React.ReactNode; label: string; onClick?: () => void;
  meta?: string; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-[7px] text-left text-[13px] ${
        disabled ? "cursor-not-allowed text-slate-400" : "text-slate-700 hover:bg-[#e8eefb]"}`}
    >
      {icon} <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta && <span className="shrink-0 rounded bg-slate-100 px-1 text-[10.5px] tabular-nums text-slate-500">{meta}</span>}
    </button>
  );
}

function ExplorerSection({ label, icon, children, defaultOpen = true }: {
  label: string; icon?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-1">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[12.5px] font-semibold text-slate-500 hover:text-slate-700">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {icon} {label}
      </button>
      {open && <div className="ml-2 border-l border-[#e8eef4] pl-1">{children}</div>}
    </div>
  );
}

const CHAPTER_GROUP_SIZE = 50;

/**
 * 章节树（规格书 §7）：超过 30 章时按 50 章分组折叠，禁止默认全展开；
 * 搜索时跨组平铺命中项；当前阅读章所在组自动展开。
 */
function ChapterTree({ chapters, search, current, muted, onOpen, bookmarkKey, bookmarks, onToggleBookmark }: {
  chapters: ChapterRow[];
  search: string;
  current: number | null;
  muted?: boolean;
  onOpen: (number: number) => void;
  bookmarkKey?: (number: number) => string;
  bookmarks?: string[];
  onToggleBookmark?: (key: string) => void;
}) {
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (current === null) return;
    const group = Math.floor((current - 1) / CHAPTER_GROUP_SIZE);
    setOpenGroups((prev) => (prev.has(group) ? prev : new Set(prev).add(group)));
  }, [current]);

  const row = (chapter: ChapterRow) => {
    const key = bookmarkKey?.(chapter.number);
    const active = current === chapter.number;
    return (
      <div
        key={chapter.number}
        className={`group flex h-8 items-center justify-between gap-1 rounded-md px-2 text-[13px] hover:bg-[#e8eefb] [content-visibility:auto] [contain-intrinsic-size:auto_32px] ${
          active ? "bg-[#dbeafe] font-medium text-[#1d4ed8]" : muted ? "text-slate-500" : "text-slate-700"}`}
      >
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title="在第四栏正文页内联阅读" onClick={() => onOpen(chapter.number)}>
          <span className="truncate">第{String(chapter.number).padStart(3, "0")}章 {chapter.title}</span>
        </button>
        <span className="flex shrink-0 items-center gap-1">
          <ChapterStatusDot chapter={chapter} />
          {key && onToggleBookmark && (
            <button onClick={() => onToggleBookmark(key)} className={bookmarks?.includes(key) ? "" : "opacity-0 group-hover:opacity-100"}>
              <Star size={11} className={bookmarks?.includes(key) ? "fill-amber-400 text-amber-400" : "text-slate-300"} />
            </button>
          )}
        </span>
      </div>
    );
  };

  const filtered = chapters.filter((c) => !search || c.title.includes(search) || String(c.number).includes(search));
  if (search) {
    return <>{filtered.slice(0, 200).map(row)}{filtered.length === 0 && <p className="px-2 py-1 text-[12px] text-slate-400">（无匹配章节）</p>}</>;
  }
  if (chapters.length <= 30) return <>{chapters.map(row)}</>;

  const groups = new Map<number, ChapterRow[]>();
  for (const chapter of chapters) {
    const g = Math.floor((chapter.number - 1) / CHAPTER_GROUP_SIZE);
    const list = groups.get(g);
    if (list) list.push(chapter); else groups.set(g, [chapter]);
  }
  return (
    <>
      {[...groups.entries()].sort((a, b) => a[0] - b[0]).map(([g, list]) => {
        const from = g * CHAPTER_GROUP_SIZE + 1;
        const to = (g + 1) * CHAPTER_GROUP_SIZE;
        const open = openGroups.has(g);
        const containsCurrent = current !== null && current >= from && current <= to;
        return (
          <div key={g}>
            <button
              onClick={() => setOpenGroups((prev) => { const next = new Set(prev); if (next.has(g)) next.delete(g); else next.add(g); return next; })}
              className={`flex h-[30px] w-full items-center gap-1 rounded-md px-2 text-[12.5px] hover:bg-[#e8eefb] ${containsCurrent ? "font-semibold text-[#1d4ed8]" : "font-medium text-slate-600"}`}
            >
              {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
              第 {from}–{Math.min(to, list[list.length - 1]?.number ?? to)} 章
              <span className="ml-auto rounded bg-slate-100 px-1 text-[10.5px] tabular-nums text-slate-500">{list.length}</span>
            </button>
            {open && <div className="ml-2 border-l border-[#e2e8f2] pl-1">{list.map(row)}</div>}
          </div>
        );
      })}
    </>
  );
}

// ---------- Workflow node card ------------------------------------------------

function WorkflowNodeCard({
  node, label, isFirst, executor, currentAction, approval, progress, busy, now, onApprove, onReject, onRetry,
}: {
  node: NodeRecord; label: string; isFirst: boolean; executor?: string; currentAction: string | null;
  approval: ApprovalRecord | null;
  progress: { completed: number; total: number } | null; busy: boolean; now: number;
  onApprove: (approvalId: string) => void; onReject: (approvalId: string) => void; onRetry: () => void;
}) {
  const duration =
    node.startedAt && node.finishedAt ? Date.parse(node.finishedAt) - Date.parse(node.startedAt)
    : node.startedAt && node.status === "running" ? now - Date.parse(node.startedAt)
    : null;
  const pct =
    node.status === "succeeded" ? 100
    : node.status === "running" && progress ? Math.round((progress.completed / progress.total) * 100)
    : node.status === "running" ? null
    : 0;
  const running = node.status === "running";

  return (
    <div className="relative">
      {!isFirst && <div className="absolute left-[18px] -top-1.5 h-1.5 w-px bg-slate-200" />}
      <div className={`mb-2 rounded-xl border bg-white px-3 py-2.5 ${
        node.status === "running" ? "border-[#2563eb]/70 ring-2 ring-[#2563eb]/15"
        : node.status === "waiting_approval" ? "border-amber-400/80 bg-amber-50/40"
        : node.status === "failed" ? "border-red-300"
        : node.status === "succeeded" ? "border-emerald-200"
        : "border-[#e2e8f2]"
      }`}>
        <div className="flex items-center gap-2">
          <StatusIcon status={node.status} />
          <span className="flex-1 truncate text-[13.5px] font-semibold text-slate-800">{label}</span>
          {node.startedAt && <span className="text-[11px] tabular-nums text-slate-400">{node.startedAt.slice(11, 19)}</span>}
          <span className={`text-[12px] ${
            node.status === "waiting_approval" ? "rounded-md bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700"
            : node.status === "succeeded" ? "font-medium text-emerald-600"
            : node.status === "running" ? "font-semibold text-[#2563eb]"
            : "text-slate-500"
          }`}>
            {STATUS_LABEL[node.status] ?? node.status}
          </span>
        </div>

        {/* Agent / Skill 行（规格书 §21：任务卡必须能回答谁在干、用什么技能） */}
        {executor && (node.startedAt || running) && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-slate-400">
            <Bot size={11} className="shrink-0" />
            <span className="shrink-0 font-medium text-slate-500">{agentForExecutor(executor)}</span>
            <span className="truncate rounded bg-slate-100 px-1 font-mono text-[10.5px] text-slate-500" title={`Skill：${executor}`}>{executor}</span>
            {node.attempt > 1 && <span className="shrink-0 text-amber-600">第 {node.attempt}/{node.maxAttempts} 次</span>}
          </div>
        )}

        {/* 当前动作（规格书 §54：显示具体动作，不用"加载中"） */}
        {running && (currentAction || progress) && (
          <p className="mt-1 truncate text-[12.5px] text-[#2563eb]" title={currentAction ?? undefined}>
            {currentAction ?? (progress ? `正在处理 第 ${progress.completed}/${progress.total} 项` : "")}
            {currentAction && progress ? `（${progress.completed}/${progress.total}）` : ""}
          </p>
        )}

        <div className="mt-2 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            {pct === null
              ? <div className="h-full w-1/3 animate-pulse rounded-full bg-[#2563eb]/70" />
              : <div
                  className={`h-full rounded-full transition-all ${node.status === "succeeded" ? "bg-emerald-500" : node.status === "failed" ? "bg-red-400" : pct > 0 ? "bg-[#2563eb]" : "bg-transparent"}`}
                  style={{ width: `${pct}%` }}
                />}
          </div>
          {duration !== null && <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{fmtDuration(duration)}</span>}
          {pct !== null && node.status === "running" && <span className="shrink-0 text-[12px] tabular-nums font-semibold text-[#2563eb]">{pct}%</span>}
        </div>

        {node.error && <p className="mt-1 line-clamp-2 text-[12px] text-red-500" title={node.error}>{node.error}</p>}
        {node.gateResult && node.gateResult.pass === false && (
          <p className="mt-1 text-[12px] text-amber-600">Gate：{(node.gateResult.hardViolations ?? []).join("；")}</p>
        )}
        {node.outputArtifacts.length > 0 && (
          <p className="mt-1 truncate text-[11.5px] text-slate-400">
            产物 {node.outputArtifacts.map((o) => `${artifactLabel(o.artifactId)}@v${o.version}`).join("、")}
          </p>
        )}
        {(approval || ["failed", "stale", "interrupted", "blocked"].includes(node.status)) && (
          <div className="mt-1.5 flex gap-1.5">
            {approval && (
              <>
                <button disabled={busy} onClick={() => onApprove(approval.approvalId)} className="rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">批准</button>
                <button disabled={busy} onClick={() => onReject(approval.approvalId)} className="rounded-md bg-red-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-400 disabled:opacity-50">驳回</button>
              </>
            )}
            {["failed", "stale", "interrupted", "blocked"].includes(node.status) && (
              <button disabled={busy} onClick={onRetry} className="rounded-md border border-[#e2e8f2] bg-white px-2.5 py-1 text-[12px] text-slate-600 hover:bg-[#e8eefb] disabled:opacity-50">重试</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Workflow DAG（React Flow） ---------------------------------------

const DAG_STATUS_COLOR: Record<string, { border: string; bg: string; text: string }> = {
  succeeded: { border: "#16a34a", bg: "#f0fdf4", text: "#166534" },
  running: { border: "#2563eb", bg: "#eff6ff", text: "#1d4ed8" },
  waiting_approval: { border: "#f59e0b", bg: "#fffbeb", text: "#b45309" },
  failed: { border: "#dc2626", bg: "#fef2f2", text: "#b91c1c" },
  stale: { border: "#fb923c", bg: "#fff7ed", text: "#c2410c" },
  blocked: { border: "#94a3b8", bg: "#f8fafc", text: "#64748b" },
};

/** 模板 DAG + 运行状态 → React Flow 节点/边（分层布局：深度=最长依赖路径）。 */
function buildDagGraph(template: TemplateInfo, records: NodeRecord[], selected: string | null) {
  const byId = new Map(records.map((n) => [n.nodeId, n]));
  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = template.nodes.find((n) => n.id === id)?.dependsOn ?? [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => resolve(dep, seen)));
    depth.set(id, d);
    return d;
  };
  for (const node of template.nodes) resolve(node.id, new Set());
  const byLevel = new Map<number, string[]>();
  for (const node of template.nodes) {
    const level = depth.get(node.id) ?? 0;
    byLevel.set(level, [...(byLevel.get(level) ?? []), node.id]);
  }
  const rfNodes: FlowNode[] = template.nodes.map((node) => {
    const record = byId.get(node.id);
    const status = record?.status ?? "pending";
    const color = DAG_STATUS_COLOR[status] ?? { border: "#cbd5e1", bg: "#ffffff", text: "#475569" };
    const level = depth.get(node.id) ?? 0;
    const siblings = byLevel.get(level) ?? [node.id];
    const index = siblings.indexOf(node.id);
    return {
      id: node.id,
      position: { x: (index - (siblings.length - 1) / 2) * 190, y: level * 84 },
      data: { label: `${node.approvalRequired ? "◈ " : ""}${node.label}${node.gate ? " ⛨" : ""}` },
      style: {
        borderColor: selected === node.id ? "#2563eb" : color.border,
        borderWidth: selected === node.id ? 2.5 : 1.5,
        background: color.bg,
        color: color.text,
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        padding: "6px 10px",
        width: 168,
        textAlign: "center" as const,
        boxShadow: status === "running" ? "0 0 0 3px rgba(37,99,235,0.15)" : undefined,
      },
    };
  });
  const rfEdges: FlowEdge[] = template.nodes.flatMap((node) =>
    node.dependsOn.map((dep) => ({
      id: `${dep}->${node.id}`,
      source: dep,
      target: node.id,
      animated: (byId.get(node.id)?.status ?? "") === "running",
      style: { stroke: "#94a3b8", strokeWidth: 1.5 },
    })),
  );
  return { rfNodes, rfEdges };
}

function WorkflowDagView({ template, nodes, selected, onSelect }: {
  template: TemplateInfo; nodes: NodeRecord[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const { rfNodes, rfEdges } = useMemo(() => buildDagGraph(template, nodes, selected), [template, nodes, selected]);
  return (
    <div className="h-[440px] overflow-hidden rounded-xl border border-[#e2e8f2] bg-white">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.25}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => onSelect(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={14} size={1} color="#e2e8f2" />
      </ReactFlow>
    </div>
  );
}

// ---------- 工作流节点详情抽屉 ------------------------------------------------

function NodeDetailDrawer({
  nodeId, record, label, templateNode, logs, approval, busy,
  onClose, onRetry, onApprove, onReject, onOpenArtifact,
}: {
  nodeId: string;
  record: NodeRecord | null;
  label: string;
  templateNode: TemplateInfo["nodes"][number] | null;
  logs: RunEvent[];
  approval: ApprovalRecord | null;
  busy: boolean;
  onClose: () => void;
  onRetry: () => void;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const duration = record?.startedAt && record?.finishedAt
    ? Date.parse(record.finishedAt) - Date.parse(record.startedAt)
    : null;
  return (
    <div className="absolute bottom-0 right-0 top-12 z-40 flex w-[400px] max-w-[85vw] flex-col border-l border-[#e2e8f2] bg-white shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#e2e8f2] px-3.5 py-2.5">
        <StatusIcon status={record?.status ?? "pending"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-slate-800">{label}</div>
          <div className="text-[11px] text-slate-400">{nodeId}</div>
        </div>
        <span className="text-[12px] text-slate-500">{STATUS_LABEL[record?.status ?? "pending"] ?? record?.status}</span>
        <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-[#e8eefb] hover:text-slate-700"><XCircle size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3 text-[12.5px] text-slate-700">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <span className="text-slate-400">尝试次数</span>
          <span className="tabular-nums">{record ? `${record.attempt}/${record.maxAttempts}` : "—"}</span>
          <span className="text-slate-400">开始</span>
          <span className="tabular-nums">{record?.startedAt ? record.startedAt.slice(5, 19).replace("T", " ") : "—"}</span>
          <span className="text-slate-400">耗时</span>
          <span className="tabular-nums">{duration !== null ? fmtDuration(duration) : "—"}</span>
          <span className="text-slate-400">依赖</span>
          <span className="break-all">{templateNode?.dependsOn.join("、") || "（起点）"}</span>
          <span className="text-slate-400">质量门</span>
          <span>{templateNode?.gate ?? "无"}</span>
          <span className="text-slate-400">人工审批</span>
          <span>{templateNode?.approvalRequired ? "需要" : "不需要"}</span>
        </div>

        {record?.gateResult && (
          <div className={`rounded-lg border px-2.5 py-1.5 ${record.gateResult.pass === false ? "border-amber-300 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
            Gate {record.gateResult.pass === false ? "未通过" : "通过"}
            {(record.gateResult.hardViolations ?? []).map((v, i) => <div key={i} className="text-[12px]">· {v}</div>)}
          </div>
        )}
        {record?.error && <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-600">{record.error}</div>}

        {record && record.inputVersions.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-semibold text-slate-500">输入</div>
            <div className="flex flex-wrap gap-1">
              {record.inputVersions.map((input) => (
                <button key={input.artifactId} onClick={() => onOpenArtifact(input.artifactId)}
                  className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11.5px] text-slate-600 hover:bg-[#e8eefb] hover:text-[#1d4ed8]">
                  {artifactLabel(input.artifactId)}@v{input.version}
                </button>
              ))}
            </div>
          </div>
        )}
        {record && record.outputArtifacts.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-semibold text-slate-500">输出（点击在第四栏打开）</div>
            <div className="flex flex-wrap gap-1">
              {record.outputArtifacts.map((output) => (
                <button key={output.artifactId} onClick={() => onOpenArtifact(output.artifactId)}
                  className="rounded-md bg-[#2563eb]/10 px-1.5 py-0.5 text-[11.5px] font-medium text-[#1d4ed8] hover:bg-[#2563eb]/20">
                  {artifactLabel(output.artifactId)}@v{output.version}
                </button>
              ))}
            </div>
          </div>
        )}

        {(approval || (record && ["failed", "stale", "interrupted", "blocked"].includes(record.status))) && (
          <div className="flex gap-1.5">
            {approval && (
              <>
                <button disabled={busy} onClick={() => onApprove(approval.approvalId)} className="rounded-md bg-emerald-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">批准</button>
                <button disabled={busy} onClick={() => onReject(approval.approvalId)} className="rounded-md bg-red-500 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-400 disabled:opacity-50">驳回</button>
              </>
            )}
            {record && ["failed", "stale", "interrupted", "blocked"].includes(record.status) && (
              <button disabled={busy} onClick={onRetry} className="rounded-md border border-[#e2e8f2] px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-[#e8eefb] disabled:opacity-50">重试</button>
            )}
          </div>
        )}

        <div>
          <div className="mb-1 text-[12px] font-semibold text-slate-500">节点日志（{logs.length}）</div>
          {logs.length === 0 && <p className="text-[12px] text-slate-400">（暂无该节点事件）</p>}
          {logs.slice(-40).reverse().map((event) => (
            <div key={event.seq} className="flex gap-1.5 text-[11.5px] leading-5 text-slate-500">
              <span className="shrink-0 tabular-nums text-slate-400">{(event.createdAt ?? "").slice(11, 19)}</span>
              <span className="min-w-0 break-all">{String(event.payload?.message ?? event.type.replace("workflow.", ""))}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 正文章节阅读器 ----------------------------------------------------

/**
 * 第四栏「正文」：在工作台内阅读章节（本书或原著），不跳出页面。
 * 章节切换用下拉 + 上一章/下一章；全文按章加载并缓存。
 */
function ChapterReaderCanvas({
  bookId, bookTitle, chapters, sourceId, sourceTitle, sourceChapters, reader, onOpen, onOpenExternal, drafts,
}: {
  bookId: string;
  bookTitle: string;
  chapters: Array<{ number: number; title: string }>;
  sourceId: string;
  sourceTitle: string;
  sourceChapters: Array<{ number: number; title: string }>;
  reader: { bookId: string; number: number } | null;
  onOpen: (target: { bookId: string; number: number }) => void;
  onOpenExternal: (target: { bookId: string; number: number }) => void;
  drafts: DraftRow[];
}) {
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const target = reader
    ?? (chapters.length > 0 ? { bookId, number: chapters[0].number }
    : sourceId && sourceChapters.length > 0 ? { bookId: sourceId, number: sourceChapters[0].number }
    : null);
  const readingSource = Boolean(target && sourceId && target.bookId === sourceId && sourceId !== bookId);
  const list = readingSource ? sourceChapters : chapters;
  const key = target ? `${target.bookId}:${target.number}` : "";
  const content = key ? cache[key] : undefined;

  useEffect(() => {
    if (!target || cache[key] !== undefined) return;
    void fetch(`/api/v1/books/${encodeURIComponent(target.bookId)}/chapters/${target.number}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { content?: string } | null) =>
        setCache((prev) => ({ ...prev, [key]: typeof data?.content === "string" ? data.content : null })))
      .catch(() => setCache((prev) => ({ ...prev, [key]: null })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!target) {
    return (
      <Card>
        <Empty>
          暂无章节 —— 原创书的正文由工作流「章节正文」节点产出并落章；改编书批准草稿后落章；
          也可以在「导入」页把现有书稿导进来。
        </Empty>
        {drafts.length > 0 && <DraftsCanvas drafts={drafts} />}
      </Card>
    );
  }
  const index = list.findIndex((c) => c.number === target.number);
  const current = list[index] ?? null;
  const go = (offset: number) => {
    const next = list[index + offset];
    if (next) onOpen({ bookId: target.bookId, number: next.number });
  };
  const words = typeof content === "string" ? content.replace(/\s/g, "").length : null;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {sourceId && sourceId !== bookId && (
            <div className="flex rounded-md bg-slate-100 p-0.5 text-[11.5px]">
              {[{ id: bookId, label: "本书" }, { id: sourceId, label: "原著" }].map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => {
                    const first = entry.id === bookId ? chapters[0] : sourceChapters[0];
                    if (first) onOpen({ bookId: entry.id, number: first.number });
                  }}
                  className={`rounded px-2 py-0.5 ${target.bookId === entry.id ? "bg-white font-semibold text-[#2563eb] shadow-sm" : "text-slate-500"}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <select
            value={target.number}
            onChange={(e) => onOpen({ bookId: target.bookId, number: Number(e.target.value) })}
            className="min-w-0 max-w-[240px] flex-1 rounded-lg border border-[#e2e8f2] bg-white px-2 py-1.5 text-[12.5px] text-slate-700"
          >
            {list.map((chapter) => (
              <option key={chapter.number} value={chapter.number}>
                第{String(chapter.number).padStart(2, "0")}章 {chapter.title}
              </option>
            ))}
          </select>
          <button onClick={() => go(-1)} disabled={index <= 0} className="rounded-md border border-[#e2e8f2] px-2 py-1 text-[12px] text-slate-600 hover:bg-[#e8eefb] disabled:opacity-40">上一章</button>
          <button onClick={() => go(1)} disabled={index < 0 || index >= list.length - 1} className="rounded-md border border-[#e2e8f2] px-2 py-1 text-[12px] text-slate-600 hover:bg-[#e8eefb] disabled:opacity-40">下一章</button>
          <button
            onClick={() => onOpenExternal(target)}
            title="在完整章节编辑页打开（离开工作台）"
            className="rounded-md border border-[#e2e8f2] px-2 py-1 text-[12px] text-slate-500 hover:bg-[#e8eefb]"
          >
            编辑页 ↗
          </button>
        </div>
        <div className="mt-1.5 text-[11.5px] text-slate-400">
          《{readingSource ? sourceTitle : bookTitle}》{current ? ` · 第${current.number}章 ${current.title}` : ""}
          {words !== null ? ` · ${words.toLocaleString()} 字` : ""}
        </div>
      </Card>

      <Card>
        {content === undefined && <p className="animate-pulse py-6 text-center text-[12.5px] text-slate-400">章节内容加载中…</p>}
        {content === null && <Empty>章节内容读取失败（文件缺失或格式异常）。</Empty>}
        {typeof content === "string" && (
          <article className="whitespace-pre-wrap text-[13.5px] leading-8 text-slate-800">{content}</article>
        )}
      </Card>

      {drafts.length > 0 && (
        <Card title={`工作流草稿产物（${drafts.length} 章，未落章）`}>
          <DraftsCanvas drafts={drafts} />
        </Card>
      )}
    </>
  );
}

// ---------- 通用画布组件 ----------------------------------------------------

/** 三幕横向卡：把任意节拍序列均分成三幕，分色贴设计稿。 */
function ActsRow({ beats }: { beats: Array<{ id: string; label: string; chapterRange: { from: number; to: number } | null }> }) {
  if (beats.length === 0) return <Empty>（主线骨架未生成）</Empty>;
  const per = Math.ceil(beats.length / 3);
  const acts = [beats.slice(0, per), beats.slice(per, per * 2), beats.slice(per * 2)].filter((a) => a.length > 0);
  const names = ["第一幕 · 建置", "第二幕 · 对抗", "第三幕 · 决战"];
  const skins = [
    { box: "border-emerald-200 bg-emerald-50/90", title: "text-emerald-800", bar: "bg-emerald-500", beat: "text-emerald-900/80" },
    { box: "border-amber-200 bg-amber-50/90", title: "text-amber-800", bar: "bg-amber-500", beat: "text-amber-900/80" },
    { box: "border-rose-200 bg-rose-50/90", title: "text-rose-800", bar: "bg-rose-500", beat: "text-rose-900/80" },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
      {acts.map((act, index) => {
        const from = act[0]?.chapterRange?.from;
        const to = act[act.length - 1]?.chapterRange?.to;
        const skin = skins[index] ?? skins[0];
        return (
          <div key={index} className={`overflow-hidden rounded-xl border ${skin.box}`}>
            <div className={`h-1 w-full ${skin.bar}`} />
            <div className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[12.5px] font-semibold ${skin.title}`}>{names[index] ?? `第${index + 1}幕`}</span>
                {from != null && <span className="text-[11px] tabular-nums text-slate-500">{from}-{to} 章</span>}
              </div>
              <ul className="mt-1.5 space-y-1">
                {act.map((beat) => (
                  <li key={beat.id} className={`truncate text-[12px] leading-5 ${skin.beat}`}>
                    {beat.label}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 指标卡（数值 + 定性 + 来源注明），视觉贴总览六宫格。 */
function MetricChips({ chips, source }: { chips: Array<{ label: string; en: string; value: number; hint: string; color: string }>; source: string }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {chips.map((chip) => (
          <div key={chip.en} className={`${C.card} px-3 py-2.5`}>
            <div className="text-[12px] font-medium text-slate-500">
              {chip.label} <span className="text-[10.5px] text-slate-400">({chip.en})</span>
            </div>
            <div className={`mt-1 text-[22px] font-bold leading-7 tabular-nums ${chip.color}`}>
              {Number.isFinite(chip.value) ? `${Math.max(0, Math.min(10, chip.value)).toFixed(1)}` : "—"}
              {Number.isFinite(chip.value) && <span className="text-[12px] font-semibold text-slate-400">/10</span>}
            </div>
            <div className="text-[11.5px] text-slate-400">{chip.hint}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 text-right text-[10.5px] text-slate-400">{source}</div>
    </div>
  );
}

function DraftsCanvas({ drafts }: { drafts: DraftRow[] }) {
  const [open, setOpen] = useState<number | null>(drafts[0]?.chapter ?? null);
  if (drafts.length === 0) return <Card><Empty>章节正文由工作流「正文」节点产出。</Empty></Card>;
  return (
    <div className="space-y-1.5">
      {drafts.map((draft) => (
        <div key={draft.chapter} className={C.card}>
          <button onClick={() => setOpen(open === draft.chapter ? null : draft.chapter)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-medium text-slate-800">
            <ChevronRight size={14} className={`transition-transform ${open === draft.chapter ? "rotate-90" : ""}`} />
            第{draft.chapter}章 {draft.title}
            <span className="ml-auto text-[11px] font-normal text-slate-400">{draft.content.length} 字</span>
          </button>
          {open === draft.chapter && (
            <pre className="max-h-[440px] overflow-y-auto whitespace-pre-wrap border-t border-[#e2e8f2] px-3.5 py-2.5 font-sans text-[13px] leading-7 text-slate-700">{draft.content}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626", "#0891b2", "#be185d", "#4d7c0f", "#6d28d9", "#b45309"];
const EDGE_COLORS = ["#60a5fa", "#f87171", "#34d399", "#fbbf24", "#a78bfa", "#f472b6"];

/** 关系图（通用）：给定节点与边直接画圆布局。 */
/**
 * 以焦点人物为中心的辐射关系网（王者荣耀人物关系图样式）：
 * - 默认主角居中，关系人按强度环绕展开，连线标注关系强度；
 * - 悬停任意人物（无需点击）→ 图谱平滑重排、该人物移到正中间（粘性切换）；
 * - 点击 = 锁定选中并在下方展开详情；点空白处重置回主角。
 */
function RelationGraphView({
  nodes, edges, height, selected = null, onSelect, edgeUnit,
}: {
  nodes: Array<{ name: string; weight: number; subtitle?: string }>;
  edges: Array<{ a: string; b: string; count: number; label?: string; type?: string }>;
  height: number;
  selected?: string | null;
  onSelect?: (name: string | null) => void;
  /** 连线标签单位（如 "章"、"事件"）；缺省不显示标签。 */
  edgeUnit?: string;
}) {
  const [focusName, setFocusName] = useState<string | null>(null);
  const [pos, setPos] = useState<Map<string, { x: number; y: number }>>(new Map());
  const posRef = useRef(pos);
  posRef.current = pos;
  const animRef = useRef<number | null>(null);
  const animatingRef = useRef(false);

  const protagonist = nodes[0]?.name ?? null;
  const known = (name: string | null) => (name && nodes.some((n) => n.name === name) ? name : null);
  const focus = known(focusName) ?? known(selected) ?? protagonist;

  const W = 560;
  const H = height;
  const cx = W / 2;
  const cy = H / 2 - 4;

  // 焦点的邻居（按关系强度排序）与其余人物
  const { neighborCounts, targets } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of edges) {
      if (edge.a === focus) counts.set(edge.b, Math.max(counts.get(edge.b) ?? 0, edge.count));
      if (edge.b === focus) counts.set(edge.a, Math.max(counts.get(edge.a) ?? 0, edge.count));
    }
    const ring = nodes
      .filter((n) => n.name !== focus)
      .sort((x, y) => (counts.get(y.name) ?? 0) - (counts.get(x.name) ?? 0));
    const r = Math.min(W, H) / 2 - 52;
    const map = new Map<string, { x: number; y: number }>();
    if (focus) map.set(focus, { x: cx, y: cy });
    ring.forEach((node, index) => {
      const angle = (index / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
      map.set(node.name, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    });
    return { neighborCounts: counts, targets: map };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, nodes, edges, H]);

  // 焦点切换 → rAF 缓动重排（350ms easeOutCubic）
  useEffect(() => {
    const from = new Map(posRef.current);
    const start = performance.now();
    const DURATION = 350;
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    animatingRef.current = true;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / DURATION);
      const ease = 1 - Math.pow(1 - k, 3);
      const next = new Map<string, { x: number; y: number }>();
      for (const [name, to] of targets) {
        const origin = from.get(name) ?? to;
        next.set(name, { x: origin.x + (to.x - origin.x) * ease, y: origin.y + (to.y - origin.y) * ease });
      }
      setPos(next);
      if (k < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        animatingRef.current = false;
        animRef.current = null;
      }
    };
    animRef.current = requestAnimationFrame(step);
    return () => { if (animRef.current !== null) cancelAnimationFrame(animRef.current); };
  }, [targets]);

  if (nodes.length === 0) return <Empty>需要人物数据 —— 由 Canon 或拆文事件参与者推导。</Empty>;

  const focusEdges = edges
    .filter((e) => e.a === focus || e.b === focus)
    .sort((x, y) => y.count - x.count);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full select-none"
      style={{ maxHeight: height }}
      onClick={() => { onSelect?.(null); setFocusName(null); }}
      onMouseLeave={() => setFocusName(null)}
    >
      {/* 焦点的关系线（辐射状）+ 强度标签 */}
      {focusEdges.map((edge, index) => {
        const other = edge.a === focus ? edge.b : edge.a;
        const a = pos.get(focus ?? "");
        const b = pos.get(other);
        if (!a || !b) return null;
        const mx = a.x + (b.x - a.x) * 0.56;
        const my = a.y + (b.y - a.y) * 0.56;
        // 有语义类型的关系边按类型着色；否则轮换调色板
        const stroke = (edge.type && RELATION_TYPE_COLORS[edge.type]) || EDGE_COLORS[index % EDGE_COLORS.length];
        const caption = edge.label ?? (edgeUnit && edge.count > 0 ? `${edge.count} ${edgeUnit}` : "");
        return (
          <g key={`${edge.a}-${edge.b}`}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={stroke}
              strokeWidth={Math.min(4.5, 1.3 + edge.count * 0.45)}
              strokeOpacity={0.75}
              strokeLinecap="round" />
            {caption && (
              <text x={mx} y={my - 3} textAnchor="middle" fontSize={9.5}
                fill={edge.type ? stroke : "#475569"}
                stroke="#fff" strokeWidth={2.5} paintOrder="stroke" fontWeight={600}>
                {caption.slice(0, 14)}
              </text>
            )}
          </g>
        );
      })}

      {nodes.map((node, index) => {
        const p = pos.get(node.name);
        if (!p) return null;
        const isFocus = node.name === focus;
        const isSelected = node.name === selected;
        const related = neighborCounts.has(node.name);
        const radius = isFocus ? 25 : related ? Math.min(18, 11 + node.weight * 0.9) : 9;
        const dimmed = !isFocus && !related;
        return (
          <g
            key={node.name}
            opacity={dimmed ? 0.3 : 1}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => { if (!animatingRef.current && node.name !== focus) setFocusName(node.name); }}
            onClick={(e) => { e.stopPropagation(); setFocusName(node.name); onSelect?.(isSelected ? null : node.name); }}
          >
            {isFocus && (
              <>
                <circle cx={p.x} cy={p.y} r={radius + 10} fill="#2563eb" fillOpacity={0.06} />
                <circle cx={p.x} cy={p.y} r={radius + 6} fill="none" stroke="#2563eb" strokeWidth={1.5} strokeOpacity={0.3} strokeDasharray="3 3" />
              </>
            )}
            {isSelected && !isFocus && <circle cx={p.x} cy={p.y} r={radius + 5} fill="none" stroke="#2563eb" strokeWidth={2} strokeOpacity={0.4} />}
            <circle cx={p.x} cy={p.y} r={radius + 2} fill="#fff"
              stroke={isFocus ? "#2563eb" : AVATAR_COLORS[index % AVATAR_COLORS.length]}
              strokeWidth={isFocus ? 3 : 1.5} />
            <circle cx={p.x} cy={p.y} r={radius} fill={AVATAR_COLORS[index % AVATAR_COLORS.length]} fillOpacity={0.92} />
            <text x={p.x} y={p.y + (isFocus ? 4.5 : 3.5)} textAnchor="middle"
              fontSize={isFocus ? 13 : radius > 14 ? 10.5 : 8.5} fill="#fff" fontWeight={700}>
              {node.name.slice(0, isFocus ? 4 : radius > 14 ? 3 : 2)}
            </text>
            <text x={p.x} y={p.y + radius + 13} textAnchor="middle" fontSize={isFocus ? 11 : 10}
              fill={isFocus ? "#1d4ed8" : dimmed ? "#94a3b8" : "#475569"} fontWeight={isFocus ? 700 : 500}>
              {node.name}
            </text>
            {(isFocus || related) && node.subtitle && (
              <text x={p.x} y={p.y + radius + 24} textAnchor="middle" fontSize={9} fill="#94a3b8">
                {node.subtitle}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------- 统一 Story 画布（数据驱动） ---------------------------------------

type DocFn = <T,>(id: string) => T | null;

/** 创作侧在该 Tab 是否有可展示数据。 */
function hasCreationData(tab: CanvasTab, doc: DocFn): boolean {
  switch (tab) {
    case "overview": return Boolean(doc("creation.brief") || doc("creation.canon") || doc("creation.spine") || doc("creation.concepts"));
    case "spine": return Boolean((doc<CreationSpineDoc>("creation.spine")?.beats.length ?? 0) > 0 || (doc<ArcPlanDoc>("creation.arcs")?.arcs.length ?? 0) > 0);
    case "characters": return Boolean((doc<CanonDoc>("creation.canon")?.characters.length ?? 0) > 0);
    case "world": return Boolean(doc("creation.canon"));
    case "hooks": return Boolean(doc("creation.state") || doc("creation.audit-report"));
    default: return false;
  }
}

/** 改编/拆文侧（含 V1 导入）在该 Tab 是否有可展示数据。 */
function hasAdaptationData(tab: CanvasTab, doc: DocFn): boolean {
  const v1 = doc<V1ImportDoc>("v1-import.deconstruct");
  switch (tab) {
    case "overview": return Boolean(doc("adaptation.contract") || (doc<StorylineRow[]>("analysis.storylines")?.length ?? 0) > 0 || doc("adaptation.target-spine") || v1);
    case "spine": return Boolean(doc("adaptation.target-spine") || (doc<StorylineRow[]>("analysis.storylines")?.length ?? 0) > 0 || v1);
    case "characters": return Boolean((doc<StoryEventRow[]>("analysis.events")?.length ?? 0) > 0 || (doc<CharacterMapRow[]>("adaptation.character-map")?.length ?? 0) > 0 || v1);
    case "world": return Boolean(doc("adaptation.contract"));
    case "hooks": return Boolean(doc("analysis.pacing"));
    default: return false;
  }
}

/** 画布运行环境：宿主工作台注入的真实书籍数据（伏笔台账 / 章节状态 / 联动动作）。 */
interface CanvasEnv {
  hooks: HookRow[];
  chapters: ChapterRow[];
  /** 当前阅读章（无阅读时为最新章） */
  focusChapter: number | null;
  bookTitle: string;
  genre?: string;
  onOpenChapter: (number: number) => void;
  onStartAnalysis?: () => void;
  startBusy?: boolean;
}

/**
 * 数据驱动画布：书里有什么数据就渲染什么分区，与书籍角色无关。
 * 改编/拆文数据在前（原著与改编书的主要内容），创作方案数据在后。
 */
function StoryCanvas({ tab, doc, selChar, setSelChar, onExtractRelations, relationsBusy, env }: {
  tab: CanvasTab; doc: DocFn; selChar: string | null; setSelChar: (name: string | null) => void;
  onExtractRelations?: () => void; relationsBusy?: boolean; env: CanvasEnv;
}) {
  const adaptation = hasAdaptationData(tab, doc);
  const creation = hasCreationData(tab, doc);
  if (!adaptation && !creation) {
    return (
      <Card>
        <Empty>
          该页暂无数据。原著书：点顶栏「深度拆文」生成事件/故事线/人物图谱；
          原创书：点「新建工作流」跑创作管线；改编书：选原著后跑改编管线。
          已有 V1 拆解的书会自动展示导入数据。
        </Empty>
      </Card>
    );
  }
  return (
    <>
      {adaptation && (
        <AdaptationCanvas
          tab={tab}
          doc={doc}
          selChar={selChar}
          setSelChar={setSelChar}
          onExtractRelations={onExtractRelations}
          relationsBusy={relationsBusy}
          env={env}
        />
      )}
      {creation && <CreationCanvas tab={tab} doc={doc} selChar={selChar} setSelChar={setSelChar} />}
    </>
  );
}

// ---------- 创作方案画布 ------------------------------------------------------

function CreationCanvas({ tab, doc, selChar, setSelChar }: {
  tab: CanvasTab; doc: DocFn; selChar: string | null; setSelChar: (name: string | null) => void;
}) {
  const brief = doc<CreativeBriefDoc>("creation.brief");
  const concepts = doc<ConceptDoc>("creation.concepts");
  const canon = doc<CanonDoc>("creation.canon");
  const spine = doc<CreationSpineDoc>("creation.spine");
  const arcs = doc<ArcPlanDoc>("creation.arcs");
  const contracts = doc<CreationChapterContract[]>("creation.chapter-contracts");
  const audit = doc<CreationAuditDoc>("creation.audit-report");
  const state = doc<StateDoc>("creation.state");

  if (tab === "spine") {
    return (
      <>
        <Card title="三幕结构"><ActsRow beats={spine?.beats ?? []} /></Card>
        <Card title={`全部节拍（${spine?.beats.length ?? 0}）`}>
          {!spine?.beats.length && <Empty>（主线骨架未生成）</Empty>}
          <div className="space-y-1.5">
            {(spine?.beats ?? []).map((beat, index) => (
              <div key={beat.id} className="flex items-start gap-2">
                <div className="flex flex-col items-center">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2563eb]/10 text-[11.5px] font-semibold text-[#2563eb]">{index + 1}</span>
                  {index < (spine?.beats.length ?? 0) - 1 && <span className="h-4 w-px bg-slate-200" />}
                </div>
                <div className="min-w-0 flex-1 rounded-lg border border-[#e2e8f2] bg-[#f8fafd] px-2.5 py-1.5">
                  <div className="truncate text-[13px] font-medium text-slate-800">
                    <span className="mr-1.5 rounded bg-[#2563eb]/10 px-1.5 text-[11px] text-[#2563eb]">{beat.stage}</span>
                    {beat.label}
                  </div>
                  <div className="text-[11.5px] text-slate-500">
                    {beat.chapterRange ? `第 ${beat.chapterRange.from}-${beat.chapterRange.to} 章` : ""}
                    {beat.stateChange.length ? ` · ${beat.stateChange.join("、")}` : ""}
                    {beat.newQuestion ? ` · 悬念：${beat.newQuestion}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
        {arcs && arcs.arcs.length > 0 && (
          <Card title="卷纲">
            {arcs.arcs.map((arc) => (
              <div key={arc.id} className="mb-2 rounded-lg border border-[#e2e8f2] bg-[#f8fafd] px-2.5 py-1.5 text-[12.5px]">
                <div className="font-medium text-slate-800">
                  {arc.title}
                  {arc.chapterRange && <span className="ml-1 text-[11px] font-normal text-slate-400">第 {arc.chapterRange.from}-{arc.chapterRange.to} 章</span>}
                </div>
                <div className="text-slate-500">Promise：{arc.promise}</div>
                {arc.climax && <div className="text-slate-500">卷高潮：{arc.climax}</div>}
              </div>
            ))}
          </Card>
        )}
      </>
    );
  }

  if (tab === "characters") {
    const chars = canon?.characters ?? [];
    // 原创模式没有事件共现，用「主角 ↔ 其他人物」的 Canon 结构关系成图。
    const graphNodes = chars.slice(0, 10).map((c) => ({ name: c.name, weight: c.role === "protagonist" ? 8 : 4, subtitle: roleLabel(c.role) }));
    const protagonist = chars.find((c) => c.role === "protagonist")?.name;
    const graphEdges = protagonist
      ? chars.filter((c) => c.name !== protagonist).slice(0, 9).map((c) => ({ a: protagonist, b: c.name, count: c.role === "antagonist" ? 3 : 1 }))
      : [];
    const ordered = selChar ? [...chars.filter((c) => c.name === selChar), ...chars.filter((c) => c.name !== selChar)] : chars;
    return (
      <>
        <Card title="人物关系图谱" extra={<span className="text-[11px] text-slate-400">点击人物查看人物卡 · 由 Canon 推导</span>}>
          <RelationGraphView nodes={graphNodes} edges={graphEdges} height={420} selected={selChar} onSelect={setSelChar} />
        </Card>
        <Card title={`人物卡（${chars.length}）`}>
          {chars.length === 0 && <Empty>Canon 未生成。</Empty>}
          {ordered.map((c) => {
            const isSel = c.name === selChar;
            return (
            <div key={c.id} className={`mb-2 rounded-lg border px-2.5 py-1.5 ${isSel ? "border-[#2563eb] bg-[#eef4ff] ring-1 ring-[#2563eb]/30" : "border-[#e2e8f2] bg-[#f8fafd]"}`}>
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-slate-800">
                {c.name}
                <span className={`rounded px-1.5 text-[11px] ${c.role === "protagonist" ? "bg-[#2563eb]/10 text-[#2563eb]" : c.role === "antagonist" ? "bg-red-100 text-red-600" : "bg-slate-100 text-slate-500"}`}>
                  {roleLabel(c.role)}
                </span>
              </div>
              <div className="mt-0.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11.5px] text-slate-500">
                {c.want && <span>想要：{c.want}</span>}
                {c.fear && <span>害怕：{c.fear}</span>}
                {c.lie && <span>错误信念：{c.lie}</span>}
                {c.boundary && <span>不会做：{c.boundary}</span>}
                {isSel && c.need && <span>真正需要：{c.need}</span>}
                {isSel && (c.arcStart || c.arcEnd) && <span className="col-span-2">人物弧：{c.arcStart} → {c.arcEnd}</span>}
              </div>
            </div>
            );
          })}
        </Card>
      </>
    );
  }

  if (tab === "world") {
    return (
      <>
        <Card title="世界规则（Canon）" extra={<Globe2 size={14} className="text-slate-300" />}>
          {!canon?.rules.length && <Empty>Canon 未生成或没有显式世界规则。</Empty>}
          {(canon?.rules ?? []).map((rule) => (
            <div key={rule.id} className="mb-1.5 flex items-start gap-1.5 text-[12.5px] text-slate-700">
              <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[11px] ${rule.hardness === "hard" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>
                {rule.hardness === "hard" ? "硬规则" : "软规则"}
              </span>
              <span>{rule.statement}{rule.cost && <span className="text-slate-400">（代价：{rule.cost}）</span>}</span>
            </div>
          ))}
        </Card>
        <Card title="冲突引擎" extra={<Users size={14} className="text-slate-300" />}>
          {!canon && <Empty>Canon 未生成。</Empty>}
          {canon && (
            <div className="space-y-1 text-[12.5px] text-slate-700">
              <div><span className="text-slate-400">主角长期目标：</span>{canon.conflictEngine.protagonistLongGoal || "（待补）"}</div>
              <div><span className="text-slate-400">系统性阻力：</span>{canon.conflictEngine.systemicObstacle || "（待补）"}</div>
              {canon.conflictEngine.escalationMechanism && <div><span className="text-slate-400">升级机制：</span>{canon.conflictEngine.escalationMechanism}</div>}
              {canon.conflictEngine.victoryCost.length > 0 && <div><span className="text-slate-400">胜利代价：</span>{canon.conflictEngine.victoryCost.join("、")}</div>}
            </div>
          )}
        </Card>
        {(canon?.factions.length || canon?.locations.length) ? (
          <Card title="势力与地点">
            {canon?.factions.map((f) => <div key={f.name} className="text-[12.5px] text-slate-700">· {f.name}{f.goal && <span className="text-slate-400">（{f.goal}）</span>}</div>)}
            {canon?.locations.map((l) => <div key={l.name} className="text-[12.5px] text-slate-700">· {l.name}{l.note && <span className="text-slate-400">（{l.note}）</span>}</div>)}
          </Card>
        ) : null}
      </>
    );
  }

  if (tab === "hooks") {
    return (
      <>
        <Card title="伏笔账本">
          {!state?.hookLedger.length && <Empty>伏笔在章级契约埋设、状态结算时入账。</Empty>}
          {(state?.hookLedger ?? []).map((hook) => (
            <div key={hook.id} className="flex items-center gap-2 py-0.5 text-[12.5px] text-slate-700">
              <span className={`rounded px-1.5 text-[11px] ${hook.status === "paid" ? "bg-emerald-100 text-emerald-700" : hook.status === "reminded" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
                {hook.status === "paid" ? "已兑现" : hook.status === "reminded" ? "已提醒" : "未兑现"}
              </span>
              <span className="truncate">{hook.id}</span>
              <span className="ml-auto text-[11px] text-slate-400">{hook.note}</span>
            </div>
          ))}
        </Card>
        <Card title="未解决问题">
          {!state?.openQuestions.length && <Empty>状态结算后显示章末留下的悬念。</Empty>}
          {(state?.openQuestions ?? []).map((q, i) => <div key={i} className="text-[12.5px] text-slate-700">· {q}</div>)}
        </Card>
        <Card title="审计问题">
          {!audit?.chapters.length && <Empty>审计报告未生成。</Empty>}
          {(audit?.chapters ?? []).flatMap((ch) => ch.issues.map((issue, i) => (
            <div key={`${ch.chapter}-${i}`} className="mb-1 text-[12.5px]">
              <span className={`mr-1.5 rounded px-1.5 text-[11px] ${issue.severity === "blocking" ? "bg-red-100 text-red-600" : issue.severity === "warning" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
                第{ch.chapter}章 {issue.category}
              </span>
              <span className="text-slate-700">{issue.description}</span>
            </div>
          )))}
          {audit?.chapters.every((c) => c.issues.length === 0) && <p className="text-[12.5px] text-emerald-600">没有发现问题。</p>}
        </Card>
      </>
    );
  }

  // ---- overview ----
  if (!brief && !canon && !spine) {
    return (
      <Card>
        <Empty>
          尚无创作数据 —— 顶栏输入一句话创意、点「新建工作流」，创作简报与 Canon 完成后，
          这里会出现故事设定、三幕主线、方案评分、章节节拍与人物关系图谱。
        </Empty>
      </Card>
    );
  }
  const locked = concepts?.candidates.find((c) => c.id === concepts.lockedConceptId);
  const scoreChips = locked
    ? [
        { label: "钩子", en: "Hook", value: locked.scores.hookStrength, hint: grade(locked.scores.hookStrength), color: "text-[#2563eb]" },
        { label: "冲突续航", en: "Conflict", value: locked.scores.conflictSustainability, hint: grade(locked.scores.conflictSustainability), color: "text-red-500" },
        { label: "主动性", en: "Agency", value: locked.scores.characterAgency, hint: grade(locked.scores.characterAgency), color: "text-amber-600" },
        { label: "连载潜力", en: "Serial", value: locked.scores.serialPotential, hint: grade(locked.scores.serialPotential), color: "text-violet-600" },
        { label: "差异度", en: "Novelty", value: locked.scores.novelty, hint: grade(locked.scores.novelty), color: "text-emerald-600" },
      ]
    : [];

  return (
    <>
      <div className="text-[15px] font-semibold text-slate-800">故事设定与主线概览</div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Card title="故事设定（Premise）">
          {brief ? (
            <div className="space-y-1.5 text-[13px] leading-6 text-slate-600">
              <p className="text-[13.5px] font-medium text-slate-800">{brief.coreFantasy || "（核心爽点待补）"}</p>
              {brief.genre.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-400">类型：</span>
                  {brief.genre.map((g) => (
                    <span key={g} className="rounded-md bg-slate-100 px-1.5 text-[11.5px] text-slate-600">{g}</span>
                  ))}
                </p>
              )}
              <p><span className="text-slate-400">读者：</span>{brief.targetAudience || "未指定"}</p>
              <p><span className="text-slate-400">篇幅：</span>{brief.targetChapters ?? "?"} 章 · 单章约 {brief.chapterWordTarget} 字 · {brief.pov}</p>
              {brief.assumptions.length > 0 && <p className="text-amber-600">假设（需确认）：{brief.assumptions.join("；")}</p>}
            </div>
          ) : <Empty>创作简报未生成。</Empty>}
        </Card>
        <div className="flex flex-col gap-3">
          <Card title="主线一句话" className="flex-1">
            <p className="text-[12.5px] leading-6 text-slate-700">{canon?.storyPromise || locked?.premise || "（Canon 生成后显示 Story Promise）"}</p>
          </Card>
          <Card title="主题" className="flex-1">
            <p className="text-[12.5px] leading-6 text-slate-700">
              {canon?.centralQuestion || (canon?.themeTensions.length ? canon.themeTensions.map(([a, b]) => `${a} vs ${b}`).join("；") : "（Canon 生成后显示中心问题）")}
            </p>
          </Card>
        </div>
      </div>

      <Card title="主线结构（三幕结构）"><ActsRow beats={spine?.beats ?? []} /></Card>

      {scoreChips.length > 0 && <MetricChips chips={scoreChips} source="指标来自概念孵化阶段的方案评分（锁定方案）" />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Card title={`章节节拍${contracts?.length ? `（前 ${contracts.length} 章契约）` : ""}`}>
          {!contracts?.length && <Empty>章级契约由工作流「章级契约」节点产出。</Empty>}
          {(contracts ?? []).map((contract) => (
            <div key={contract.chapter} className="mb-2 flex items-start gap-2.5 text-[13px] text-slate-700">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2563eb]/10 text-[11px] font-semibold text-[#2563eb]">
                {String(contract.chapter).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <span className="font-medium">第{contract.chapter}章</span> {contract.chapterGoal}
                <span className="text-slate-400">（{contract.beatIds.length} 个主线节拍{contract.endHook ? " · 有章末钩子" : ""}）</span>
              </div>
            </div>
          ))}
        </Card>
        <Card title="人物关系图谱" extra={<span className="text-[11px] text-slate-400">Canon 结构</span>}>
          <RelationGraphView
            nodes={(canon?.characters ?? []).slice(0, 8).map((c) => ({ name: c.name, weight: c.role === "protagonist" ? 8 : 4, subtitle: roleLabel(c.role) }))}
            edges={(() => {
              const chars = canon?.characters ?? [];
              const p = chars.find((c) => c.role === "protagonist")?.name;
              return p ? chars.filter((c) => c.name !== p).slice(0, 7).map((c) => ({ a: p, b: c.name, count: c.role === "antagonist" ? 3 : 1 })) : [];
            })()}
            height={220}
          />
        </Card>
      </div>
    </>
  );
}

function roleLabel(role: string): string {
  return { protagonist: "主角", antagonist: "反派", ally: "盟友", foil: "对照", supporting: "配角" }[role] ?? role;
}

function grade(v: number): string {
  return !Number.isFinite(v) ? "—" : v < 4 ? "偏弱" : v < 7 ? "中等" : "强";
}

// ---------- 改编/拆文画布 -----------------------------------------------------

// ---------- 总览六模块（规格书 §29）辅助 --------------------------------------

interface StoryIssue { text: string; detail?: string; chapter: number | null; severity: "warning" | "info" }

/** 「当前问题」聚合：伏笔台账 + 节奏产物 + 章节审计，全部来自真实数据。 */
function buildStoryIssues(env: CanvasEnv, pacing: PacingDoc | null): StoryIssue[] {
  const latest = env.chapters.length ? env.chapters[env.chapters.length - 1].number : 0;
  const issues: StoryIssue[] = [];
  const silent = env.hooks
    .filter((h) => h.status === "open" || h.status === "progressing")
    .map((h) => ({ h, silence: latest - (h.lastAdvancedChapter ?? h.startChapter ?? latest) }))
    .filter((x) => x.silence >= 30)
    .sort((a, b) => b.silence - a.silence)
    .slice(0, 3);
  for (const { h, silence } of silent) {
    issues.push({
      text: `伏笔「${h.hookId}」已 ${silence} 章未推进`,
      detail: h.notes?.replace(/（[^）]*）\s*$/, "").slice(0, 90),
      chapter: h.lastAdvancedChapter ?? h.startChapter ?? null,
      severity: "warning",
    });
  }
  for (const stall of (pacing?.mainlineStalls ?? []).slice(0, 2)) {
    issues.push({ text: `第 ${stall.fromChapter}–${stall.toChapter} 章主线停滞`, detail: stall.reason, chapter: stall.fromChapter, severity: "warning" });
  }
  const warned = env.chapters
    .map((c) => ({ c, n: (c.auditIssues ?? []).filter((s) => s.startsWith("[warning]")).length }))
    .filter((x) => x.n > 0)
    .slice(-3);
  for (const { c, n } of warned) issues.push({ text: `第 ${c.number} 章有 ${n} 条审计警告`, detail: c.title, chapter: c.number, severity: "info" });
  return issues.slice(0, 6);
}

function IssuesCard({ issues, onLocate }: { issues: StoryIssue[]; onLocate: (chapter: number) => void }) {
  return (
    <Card title="当前问题" extra={issues.length > 0 ? <span className="rounded bg-amber-100 px-1.5 text-[11px] font-medium text-amber-700">{issues.length}</span> : undefined}>
      {issues.length === 0 && <p className="text-[12.5px] text-emerald-600">暂无待处理问题。</p>}
      <div className="space-y-1.5">
        {issues.map((issue, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[12.5px]">
            <AlertTriangle size={13} className={`mt-0.5 shrink-0 ${issue.severity === "warning" ? "text-amber-500" : "text-slate-400"}`} />
            <div className="min-w-0 flex-1">
              <span className="text-slate-700">{issue.text}</span>
              {issue.detail && <span className="text-slate-400">（{issue.detail}）</span>}
            </div>
            {issue.chapter !== null && (
              <button onClick={() => onLocate(issue.chapter!)} className="shrink-0 rounded border border-[#e2e8f2] px-1.5 py-0.5 text-[11px] text-[#2563eb] hover:bg-[#e8eefb]">
                定位
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 当前章节 Beats（规格书 §29.5）：V1 逐章剧情按句切分为节拍。 */
function ChapterBeatsCard({ env, v1 }: { env: CanvasEnv; v1: V1ImportDoc | null }) {
  const number = env.focusChapter;
  const record = number !== null ? v1?.chapterRecords.find((r) => r.chapterNumber === number) : undefined;
  const beats = record
    ? record.plot.split(/[。！？!?]/).map((s) => s.trim()).filter((s) => s.length >= 4).slice(0, 5)
    : [];
  return (
    <Card
      title={number !== null ? `章节节拍 · 第${number}章${record ? ` ${record.title}` : ""}` : "章节节拍"}
      extra={number !== null ? (
        <button onClick={() => env.onOpenChapter(number)} className="rounded border border-[#e2e8f2] px-1.5 py-0.5 text-[11px] text-[#2563eb] hover:bg-[#e8eefb]">打开正文</button>
      ) : undefined}
    >
      {beats.length === 0 && <Empty>{number === null ? "（暂无章节）" : "左侧点选章节后，这里显示该章的剧情节拍。"}</Empty>}
      <div className="space-y-2">
        {beats.map((beat, i) => (
          <div key={i} className="flex items-start gap-2.5 text-[13px]">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2563eb]/10 text-[11px] font-semibold text-[#2563eb]">B{i + 1}</span>
            <span className="min-w-0 leading-6 text-slate-700">{beat}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const METRIC_DEFS = [
  { label: "节奏", en: "Pacing" }, { label: "冲突", en: "Conflict" }, { label: "人物目标", en: "Goal" },
  { label: "反转", en: "Twist" }, { label: "伏笔兑现", en: "Payoff" }, { label: "连续性", en: "Continuity" },
] as const;

/** 未拆文时的指标占位（规格书 §53：Idle 态，不留空白也不造假数据）。 */
function IdleMetrics() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {METRIC_DEFS.map((m) => (
        <div key={m.en} className={`${C.card} px-3 py-2.5`}>
          <div className="text-[12px] font-medium text-slate-500">{m.label} <span className="text-[10.5px] text-slate-400">({m.en})</span></div>
          <div className="mt-1 text-[22px] font-bold leading-7 text-slate-300">—</div>
          <div className="text-[11.5px] text-slate-300">深度拆文后计算</div>
        </div>
      ))}
    </div>
  );
}

function AdaptationCanvas({ tab, doc, selChar, setSelChar, onExtractRelations, relationsBusy, env }: {
  tab: CanvasTab; doc: DocFn; selChar: string | null; setSelChar: (name: string | null) => void;
  onExtractRelations?: () => void; relationsBusy?: boolean; env: CanvasEnv;
}) {
  const contract = doc<ContractDoc>("adaptation.contract");
  const storylines = doc<StorylineRow[]>("analysis.storylines") ?? [];
  const spine = doc<{ beats: SpineBeat[] }>("adaptation.target-spine");
  const pacing = doc<PacingDoc>("analysis.pacing");
  const chapterContracts = doc<AdaptChapterContract[]>("adaptation.chapter-contracts") ?? [];
  const events = doc<StoryEventRow[]>("analysis.events") ?? [];
  const characterMap = doc<CharacterMapRow[]>("adaptation.character-map") ?? [];
  const v1 = doc<V1ImportDoc>("v1-import.deconstruct");
  const relationsDoc = doc<CharacterRelationsDoc>("analysis.character-relations");

  if (tab === "spine") {
    const beats = spine?.beats ?? [];
    // V2 未拆文时用 V1 全书拆解的逐章脉络兜底
    if (beats.length === 0 && storylines.length === 0 && v1?.chapterRecords.length) {
      return (
        <>
          <Card
            title={`源书章节脉络（V1 拆解 · ${v1.chapterRecords.length} 章）`}
            extra={<span className="text-[11px] text-slate-400">参考级 · V2 深度拆文后替换为可验证故事线</span>}
          >
            <div className="space-y-1">
              {v1.chapterRecords.map((record) => (
                <div key={record.chapterNumber} className="flex items-start gap-2 text-[12.5px] [content-visibility:auto] [contain-intrinsic-size:auto_44px]">
                  <span className="mt-0.5 shrink-0 rounded bg-[#2563eb]/10 px-1.5 text-[11px] tabular-nums text-[#2563eb]">
                    {String(record.chapterNumber).padStart(3, "0")}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-800">{record.title}</div>
                    <div className="line-clamp-2 text-slate-500">{record.plot}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      );
    }
    return (
      <>
        <Card title="三幕结构"><ActsRow beats={beats} /></Card>
        <Card title={`全部节拍（${beats.length}）`}>
          {beats.length === 0 && <Empty>（目标主线骨架未生成）</Empty>}
          <div className="space-y-1.5">
            {beats.map((beat, index) => (
              <div key={beat.id} className="flex items-start gap-2">
                <div className="flex flex-col items-center">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2563eb]/10 text-[11.5px] font-semibold text-[#2563eb]">{index + 1}</span>
                  {index < beats.length - 1 && <span className="h-4 w-px bg-slate-200" />}
                </div>
                <div className="min-w-0 flex-1 rounded-lg border border-[#e2e8f2] bg-[#f8fafd] px-2.5 py-1.5">
                  <div className="truncate text-[13px] font-medium text-slate-800">{beat.label}</div>
                  <div className="text-[11.5px] text-slate-500">
                    {beat.chapterRange ? `目标第 ${beat.chapterRange.from}-${beat.chapterRange.to} 章` : ""}
                    {beat.stateChanges.length ? ` · ${beat.stateChanges.join("、")}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
        {storylines.length > 0 && (
          <Card title="源书故事线">
            {storylines.map((line) => (
              <div key={line.id} className="mb-1.5 flex items-start gap-2 text-[12.5px]">
                <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[11px] ${line.type === "main" ? "bg-[#2563eb]/10 text-[#2563eb]" : "bg-slate-100 text-slate-500"}`}>
                  {line.type === "main" ? "主线" : "支线"}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-800">{line.name} · {line.eventIds.length} 事件</div>
                  <div className="truncate text-slate-500">{line.promise}</div>
                </div>
              </div>
            ))}
          </Card>
        )}
      </>
    );
  }

  if (tab === "characters") {
    // V2 事件缺失时，用 V1 拆解的逐章人物记录算同章共现图谱
    if (events.length === 0 && v1?.chapterRecords.length) {
      const { nodes, edges } = v1CoOccurrence(v1.chapterRecords);
      const cards = Object.entries(v1.characterCards);
      // 有羁绊产物时：边换成带语义的关系（类型着色 + 关系短语标签）
      const nameSet = new Set(nodes.map((n) => n.name));
      const relationEdges = (relationsDoc?.relations ?? [])
        .filter((rel) => nameSet.has(rel.a) && nameSet.has(rel.b))
        .map((rel) => ({ a: rel.a, b: rel.b, count: rel.coChapters, label: rel.label || rel.type, type: rel.type }));
      const graphEdges = relationEdges.length > 0 ? relationEdges : edges;
      return (
        <>
          <Card
            title={relationsDoc ? "人物羁绊图谱" : "人物关系图谱（V1 拆解）"}
            extra={
              <span className="flex items-center gap-2">
                {relationsDoc && (
                  <span className={`rounded px-1.5 text-[10.5px] ${relationsDoc.source === "llm" ? "bg-[#2563eb]/10 text-[#2563eb]" : "bg-amber-100 text-amber-700"}`}>
                    {relationsDoc.source === "llm" ? "LLM 分析" : "仅共现统计"}
                  </span>
                )}
                {onExtractRelations && (
                  <button
                    onClick={onExtractRelations}
                    disabled={relationsBusy}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 ${relationsDoc ? "border border-[#e2e8f2] text-slate-500 hover:bg-[#e8eefb]" : "bg-[#2563eb] text-white hover:bg-[#1d4ed8]"}`}
                  >
                    {relationsBusy ? "分析中…" : relationsDoc ? "重新生成" : "生成人物羁绊（LLM）"}
                  </button>
                )}
                <span className="text-[11px] text-slate-400">悬停换中心 · 点击看详情</span>
              </span>
            }
          >
            <RelationGraphView nodes={nodes} edges={graphEdges} height={460} selected={selChar} onSelect={setSelChar} edgeUnit="章" />
          </Card>
          {selChar && <V1CharacterDetail v1={v1} name={selChar} onPick={setSelChar} relations={relationsDoc} />}
          <Card title={`人物卡（V1 · ${cards.length}）`} extra={<span className="text-[11px] text-slate-400">参考级 · 名称截断为 V1 已知问题</span>}>
            <div className="space-y-1.5">
              {cards.map(([file, content]) => (
                <div key={file} className="rounded-lg border border-[#e2e8f2] bg-[#f8fafd] px-2.5 py-1.5 [content-visibility:auto] [contain-intrinsic-size:auto_52px]">
                  <div className="text-[13px] font-medium text-slate-800">{file.replace(/\.md$/, "")}</div>
                  <div className="line-clamp-2 text-[11.5px] text-slate-500">{content.replace(/^#+\s*/gm, "").slice(0, 160)}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      );
    }
    const { nodes, edges } = coOccurrence(events, characterMap);
    return (
      <>
        <Card title="人物关系图谱" extra={<span className="text-[11px] text-slate-400">悬停换中心 · 点击看详情</span>}>
          <RelationGraphView nodes={nodes} edges={edges} height={460} selected={selChar} onSelect={setSelChar} edgeUnit="事件" />
        </Card>
        {selChar && <EventsCharacterDetail events={events} characterMap={characterMap} name={selChar} onPick={setSelChar} />}
        <Card title="人物映射表">
          {characterMap.length === 0 ? <Empty>人物映射由工作流「人物映射」节点产出。</Empty> : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 pr-2 font-medium">原名</th><th className="py-1 pr-2 font-medium">新名</th>
                  <th className="py-1 pr-2 font-medium">策略</th><th className="py-1 font-medium">级别</th>
                </tr>
              </thead>
              <tbody>
                {characterMap.map((entry) => (
                  <tr key={`${entry.sourceName}-${entry.targetName}`} className="border-t border-[#eef2f8] text-slate-700">
                    <td className="py-1.5 pr-2">{entry.sourceName}</td>
                    <td className="py-1.5 pr-2 font-medium">{entry.targetName}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{entry.strategy}</td>
                    <td className="py-1.5">
                      <span className={`rounded px-1.5 text-[11px] ${entry.tier === "major" ? "bg-[#2563eb]/10 text-[#2563eb]" : "bg-slate-100 text-slate-500"}`}>
                        {entry.tier === "major" ? "主要" : "次要"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </>
    );
  }

  if (tab === "world") {
    if (!contract) return <Card><Empty>世界观约束随改编契约生成。</Empty></Card>;
    return (
      <>
        <Card title="改编世界观约束" extra={<Globe2 size={14} className="text-slate-300" />}>
          <div className="space-y-2 text-[12.5px] text-slate-700">
            <div><span className="font-medium">允许变更：</span><span className="text-slate-500">{contract.canChange.join("、") || "（无）"}</span></div>
            <div><span className="font-medium text-red-500">禁区：</span><span className="text-slate-500">{contract.forbidden.join("、") || "（无）"}</span></div>
            <div><span className="font-medium">目标形态：</span><span className="text-slate-500">{contract.format} · {contract.target.genre || "题材待定"} · {contract.target.chapterCount ?? "?"} 章</span></div>
          </div>
        </Card>
        <Card title="必须保留（must_preserve）" extra={<Users size={14} className="text-slate-300" />}>
          {contract.mustPreserve.map((item) => (
            <div key={item.refId} className="mb-1 flex items-start gap-1.5 text-[12.5px] text-slate-700">
              <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-500" />
              <span><span className="rounded bg-slate-100 px-1 text-[11px] text-slate-500">{item.kind}</span> {item.note || item.refId}</span>
            </div>
          ))}
        </Card>
      </>
    );
  }

  if (tab === "hooks") {
    const stalls = pacing?.mainlineStalls ?? [];
    const flagged = (pacing?.scenes ?? []).filter((s) => s.flags.length > 0);
    return (
      <>
        <Card title="主线停滞（MAINLINE_STALL）">
          {stalls.length === 0 && <p className="text-[12.5px] text-emerald-600">未检测到主线停滞。</p>}
          {stalls.map((stall, i) => <p key={i} className="text-[12.5px] text-amber-600">第 {stall.fromChapter}-{stall.toChapter} 章：{stall.reason}</p>)}
        </Card>
        <Card title="无效场景（PACING_NOOP_SCENE）">
          {flagged.length === 0 && <p className="text-[12.5px] text-emerald-600">没有被标记的无功能场景。</p>}
          {flagged.map((scene) => (
            <p key={scene.sceneId} className="text-[12.5px] text-slate-500">
              第{scene.chapter}章 {scene.sceneId} · Δ={scene.narrativeDelta.toFixed(2)} · {scene.flags.join("、")}
            </p>
          ))}
        </Card>
      </>
    );
  }

  // ---- overview（规格书 §29：六模块驾驶舱） ----
  if (!contract && storylines.length === 0 && !spine) {
    // 未跑 V2 拆文：用 V1 拆解 + 伏笔台账 + 章节审计给出真实驾驶舱，缺的模块给 Idle 态
    if (v1?.chapterRecords.length) {
      const { nodes, edges } = v1CoOccurrence(v1.chapterRecords);
      const nameSet = new Set(nodes.map((n) => n.name));
      const relationEdges = (relationsDoc?.relations ?? [])
        .filter((rel) => nameSet.has(rel.a) && nameSet.has(rel.b))
        .map((rel) => ({ a: rel.a, b: rel.b, count: rel.coChapters, label: rel.label || rel.type, type: rel.type }));
      const issues = buildStoryIssues(env, pacing);
      const totalAppearances = v1.chapterRecords.reduce((a, r) => a + r.characters.length, 0);
      // 全书人物总数：图谱 nodes 为可视化截断的前 N 名，计数用完整数据
      const characterTotal = Math.max(
        Object.keys(v1.characterCards).length,
        new Set(v1.chapterRecords.flatMap((r) => r.characters.map((c) => c.name))).size,
      );
      return (
        <>
          {/* ① Premise 行 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Card title="故事设定（Premise）">
              <div className="space-y-1.5 text-[12.5px] leading-6 text-slate-600">
                <p className="text-[13.5px] font-medium text-slate-800">《{env.bookTitle}》</p>
                <p><span className="text-slate-400">类型：</span>{env.genre || "（未设置）"}</p>
                <p><span className="text-slate-400">体量：</span>{env.chapters.length} 章 · 人物 {characterTotal} 名 · 出场记录 {totalAppearances}</p>
                <p className="text-[11.5px] text-slate-400">一句话主线与主题将在深度分析完成后自动提取。</p>
              </div>
            </Card>
            {/* Story Graph 状态（规格书 §33：产品语言 + 明确下一步） */}
            <Card title="Story Graph 尚未完成" extra={<GitBranch size={14} className="text-slate-300" />}>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  { label: "人物", value: characterTotal, color: "text-violet-600" },
                  { label: "Story Event", value: 0, color: "text-slate-300" },
                  { label: "因果关系", value: 0, color: "text-slate-300" },
                  { label: "伏笔连接", value: env.hooks.length, color: env.hooks.length ? "text-amber-600" : "text-slate-300" },
                ].map((m) => (
                  <div key={m.label}>
                    <div className={`text-[22px] font-bold tabular-nums ${m.color}`}>{m.value}</div>
                    <div className="text-[11px] text-slate-400">{m.label}</div>
                  </div>
                ))}
              </div>
              {env.onStartAnalysis ? (
                <button
                  onClick={env.onStartAnalysis}
                  disabled={env.startBusy}
                  className={`mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] font-medium disabled:opacity-50 ${C.blueBtn}`}
                >
                  {env.startBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 开始深度分析
                </button>
              ) : (
                <p className="mt-2 text-[11.5px] text-slate-400">深度分析完成后，这里会展示事件因果、人物目标变化、主支线与伏笔连接。</p>
              )}
            </Card>
          </div>

          {/* ② Story Arc 行（未分析：Idle 态说明，不造假三幕） */}
          <Card title="主线结构（三幕结构）">
            <Empty>深度分析完成后自动划分三幕结构，并标注每一幕的目标、冲突、高潮与结果。</Empty>
          </Card>

          {/* ③ Metrics 行（Idle 态） */}
          <IdleMetrics />

          {/* ④ 当前问题（真实数据：伏笔台账 + 章节审计） */}
          <IssuesCard issues={issues} onLocate={env.onOpenChapter} />

          {/* ⑤⑥ 当前章节 Beats + 人物关系图 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <ChapterBeatsCard env={env} v1={v1} />
            <Card
              title={relationsDoc ? "人物羁绊图谱" : "人物关系图谱"}
              extra={
                <span className="flex items-center gap-2">
                  {onExtractRelations && !relationsDoc && (
                    <button onClick={onExtractRelations} disabled={relationsBusy}
                      className="rounded-md bg-[#2563eb] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#1d4ed8] disabled:opacity-50">
                      {relationsBusy ? "分析中…" : "生成人物羁绊"}
                    </button>
                  )}
                  <span className="text-[11px] text-slate-400">悬停换中心 · 点击看详情</span>
                </span>
              }
            >
              <RelationGraphView
                nodes={nodes}
                edges={relationEdges.length > 0 ? relationEdges : edges}
                height={420}
                selected={selChar}
                onSelect={setSelChar}
                edgeUnit="章"
              />
            </Card>
          </div>
          {selChar && <V1CharacterDetail v1={v1} name={selChar} onPick={setSelChar} relations={relationsDoc} />}
        </>
      );
    }
    return (
      <>
        <Card title="Story Graph 尚未生成">
          <p className="text-[12.5px] leading-6 text-slate-500">
            深度拆文后，InkOS 会在这里展示：事件因果、人物目标变化、主支线、伏笔连接。
          </p>
          {env.onStartAnalysis && (
            <button
              onClick={env.onStartAnalysis}
              disabled={env.startBusy}
              className={`mt-2.5 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-50 ${C.blueBtn}`}
            >
              {env.startBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 开始深度分析
            </button>
          )}
        </Card>
        <IssuesCard issues={buildStoryIssues(env, pacing)} onLocate={env.onOpenChapter} />
      </>
    );
  }
  const main = storylines.find((l) => l.type === "main");
  const scenes = pacing?.scenes ?? [];
  const avg = (pick: (s: PacingDoc["scenes"][number]) => number) => (scenes.length ? scenes.reduce((a, s) => a + pick(s), 0) / scenes.length : NaN);
  const goalShare = events.length ? events.filter((e) => e.stateChanges.length > 0).length / events.length : NaN;
  const auditChapters = env.chapters.filter((c) => (c.auditIssues ?? []).length > 0).length;
  const chips = [
    { label: "节奏", en: "Pacing", value: avg((s) => s.narrativeDelta) * 2 + 5, hint: scenes.length ? `${scenes.length} 场景` : "待拆文", color: "text-[#2563eb]" },
    { label: "冲突", en: "Conflict", value: avg((s) => s.conflictDelta) * 10, hint: (pacing?.mainlineStalls.length ?? 0) > 0 ? `${pacing!.mainlineStalls.length} 处停滞` : "无停滞", color: "text-red-500" },
    { label: "目标", en: "Goal", value: goalShare * 10, hint: events.length ? `${events.length} 事件` : "待拆文", color: "text-amber-600" },
    { label: "反转", en: "Twist", value: avg((s) => s.emotionDelta) * 10, hint: "情绪增量均值", color: "text-violet-600" },
    { label: "伏笔兑现", en: "Payoff", value: avg((s) => s.hookDelta) * 10, hint: "hook 增量均值", color: "text-emerald-600" },
    { label: "连续性", en: "Continuity", value: env.chapters.length ? 10 * (1 - auditChapters / env.chapters.length) : NaN, hint: auditChapters ? `${auditChapters} 章有审计` : "无审计问题", color: "text-sky-600" },
  ];
  const { nodes, edges } = coOccurrence(events, characterMap);

  return (
    <>
      <div className="text-[15px] font-semibold text-slate-800">故事设定与主线概览</div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Card title="故事设定（Premise）">
          {contract ? (
            <div className="space-y-1.5 text-[13px] leading-6 text-slate-600">
              {contract.target.notes && <p className="text-[13.5px] font-medium text-slate-800">{contract.target.notes}</p>}
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="text-slate-400">类型：</span>
                {(contract.target.genre || "（题材待定）").split(/[、,/|]/).filter(Boolean).map((g) => (
                  <span key={g} className="rounded-md bg-slate-100 px-1.5 text-[11.5px] text-slate-600">{g.trim()}</span>
                ))}
              </p>
              <p><span className="text-slate-400">源书：</span>《{contract.sourceBookId}》 · 目标 {contract.target.chapterCount ?? "?"} 章 · 节奏 {contract.target.pace}</p>
              <p className="text-[11.5px] text-slate-400">
                must_preserve {contract.mustPreserve.length} 项 · 可变更 {contract.canChange.length} 项
                {contract.forbidden.length > 0 ? ` · 禁区 ${contract.forbidden.length} 项` : ""}
              </p>
            </div>
          ) : <Empty>（改编契约未生成）</Empty>}
        </Card>
        <div className="flex flex-col gap-3">
          <Card title="主线一句话" className="flex-1">
            <p className="text-[12.5px] leading-6 text-slate-700">{main?.promise ?? "（深度拆文完成后从主线 Storyline 提取）"}</p>
          </Card>
          <Card title="主题" className="flex-1">
            <p className="text-[12.5px] leading-6 text-slate-700">
              {main ? `主线事件 ${main.eventIds.length} · 支线 ${storylines.length - 1} 条` : "（拆文后生成）"}
            </p>
          </Card>
        </div>
      </div>

      <Card title="主线结构（三幕结构）"><ActsRow beats={spine?.beats ?? []} /></Card>

      <MetricChips chips={chips} source="指标由拆文产物（pacing/events）聚合推导" />

      <IssuesCard issues={buildStoryIssues(env, pacing)} onLocate={env.onOpenChapter} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Card title={`章节节拍${chapterContracts.length ? `（前 ${chapterContracts.length} 章契约）` : ""}`}>
          {chapterContracts.length === 0 && <Empty>章级契约由工作流「章级契约」节点产出。</Empty>}
          {chapterContracts.map((c) => (
            <div key={c.chapter} className="mb-2 flex items-start gap-2.5 text-[13px] text-slate-700">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2563eb]/10 text-[11px] font-semibold text-[#2563eb]">
                {String(c.chapter).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <span className="font-medium">第{c.chapter}章</span> {c.chapterGoal}
                <span className="text-slate-400">（{c.sourceEventIds.length} 个源事件{c.endHook ? " · 有章末钩子" : ""}）</span>
              </div>
            </div>
          ))}
        </Card>
        <Card title="人物关系图谱" extra={<span className="text-[11px] text-slate-400">悬停换中心 · 点击看详情</span>}>
          <RelationGraphView nodes={nodes} edges={edges} height={340} selected={selChar} onSelect={setSelChar} edgeUnit="事件" />
        </Card>
      </div>
      {selChar && <EventsCharacterDetail events={events} characterMap={characterMap} name={selChar} onPick={setSelChar} />}
    </>
  );
}

/** 点选人物后的详情面板（V1 拆解数据）：出场统计 + 羁绊 + 人物卡 + 关系 + 逐章剧情。 */
function V1CharacterDetail({ v1, name, onPick, relations }: {
  v1: V1ImportDoc; name: string; onPick: (name: string) => void;
  relations?: CharacterRelationsDoc | null;
}) {
  const myRelations = (relations?.relations ?? []).filter((rel) => rel.a === name || rel.b === name);
  const appearances = v1.chapterRecords.filter((r) => r.characters.some((c) => c.name === name));
  const totalMentions = appearances.reduce((a, r) => a + (r.characters.find((c) => c.name === name)?.count ?? 0), 0);
  const co = new Map<string, number>();
  for (const record of appearances) {
    for (const c of record.characters) if (c.name !== name) co.set(c.name, (co.get(c.name) ?? 0) + 1);
  }
  const coOccurrenceList = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxCo = coOccurrenceList[0]?.[1] ?? 1;
  // V1 人物卡文件名可能被截断（已知问题），前缀双向匹配
  const card = Object.entries(v1.characterCards).find(([file]) => {
    const n = file.replace(/\.md$/, "");
    return n === name || name.startsWith(n) || n.startsWith(name);
  });
  return (
    <Card
      title={`${name} · 人物详情`}
      extra={<span className="text-[11px] text-slate-400">出场 {appearances.length} 章 · 提及 {totalMentions} 次 · V1 拆解</span>}
    >
      <div className="space-y-3">
        {myRelations.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-semibold text-slate-600">羁绊（{relations?.source === "llm" ? "LLM 分析" : "共现统计"}，点击切换人物）</div>
            <div className="space-y-1">
              {myRelations.map((rel) => {
                const other = rel.a === name ? rel.b : rel.a;
                const color = RELATION_TYPE_COLORS[rel.type] ?? "#64748b";
                return (
                  <button key={`${rel.a}-${rel.b}`} onClick={() => onPick(other)}
                    className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[#e8eefb]">
                    <span className="mt-0.5 shrink-0 rounded px-1.5 text-[10.5px] font-semibold text-white" style={{ backgroundColor: color }}>
                      {rel.type}
                    </span>
                    <span className="min-w-0">
                      <span className="text-[12.5px] font-medium text-slate-700">{other}</span>
                      <span className="ml-1.5 text-[12px] text-slate-500">{rel.label}</span>
                      {rel.note && <span className="block truncate text-[11px] text-slate-400">{rel.note}</span>}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-slate-400">{rel.coChapters} 章</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {card && (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-[#e2e8f2] bg-[#f8fafd] px-2.5 py-2 text-[12px] leading-5 text-slate-600 whitespace-pre-wrap">
            {card[1].trim()}
          </div>
        )}
        <div>
          <div className="mb-1 text-[12px] font-semibold text-slate-600">关系（同场章数，点击切换人物）</div>
          {coOccurrenceList.length === 0 && <Empty>没有与其他已记录人物同章出现。</Empty>}
          <div className="space-y-1">
            {coOccurrenceList.map(([other, count]) => (
              <button key={other} onClick={() => onPick(other)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-[#e8eefb]">
                <span className="w-[72px] shrink-0 truncate text-[12.5px] font-medium text-slate-700">{other}</span>
                <span className="h-2 rounded-full bg-[#2563eb]/70" style={{ width: `${Math.max(6, (count / maxCo) * 100)}%`, maxWidth: "70%" }} />
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{count} 章</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-semibold text-slate-600">剧情时间线（{appearances.length} 章）</div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {appearances.map((record) => (
              <div key={record.chapterNumber} className="flex items-start gap-2 text-[12px] [content-visibility:auto] [contain-intrinsic-size:auto_42px]">
                <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 text-[10.5px] tabular-nums text-slate-500">
                  {String(record.chapterNumber).padStart(3, "0")}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-700">
                    {record.title}
                    <span className="ml-1 font-normal text-slate-400">出现 {record.characters.find((c) => c.name === name)?.count ?? 0} 次</span>
                  </div>
                  <div className="line-clamp-2 text-slate-500">{record.plot}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** 点选人物后的详情面板（V2 拆文事件）：参与事件 + 同场关系。 */
function EventsCharacterDetail({ events, characterMap, name, onPick }: {
  events: StoryEventRow[]; characterMap: CharacterMapRow[]; name: string; onPick: (name: string) => void;
}) {
  const rename = new Map(characterMap.map((e) => [e.sourceName, e.targetName]));
  const display = (n: string) => rename.get(n) ?? n;
  const mine = events.filter((e) => e.participants.some((p) => display(p) === name));
  const co = new Map<string, number>();
  for (const event of mine) {
    for (const p of new Set(event.participants.map(display))) if (p !== name) co.set(p, (co.get(p) ?? 0) + 1);
  }
  const relations = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxCo = relations[0]?.[1] ?? 1;
  return (
    <Card
      title={`${name} · 人物详情`}
      extra={<span className="text-[11px] text-slate-400">参与 {mine.length} 个事件 · V2 拆文</span>}
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[12px] font-semibold text-slate-600">关系（同场事件数，点击切换人物）</div>
          {relations.length === 0 && <Empty>没有与其他人物同场的事件。</Empty>}
          <div className="space-y-1">
            {relations.map(([other, count]) => (
              <button key={other} onClick={() => onPick(other)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-[#e8eefb]">
                <span className="w-[72px] shrink-0 truncate text-[12.5px] font-medium text-slate-700">{other}</span>
                <span className="h-2 rounded-full bg-[#2563eb]/70" style={{ width: `${Math.max(6, (count / maxCo) * 100)}%`, maxWidth: "70%" }} />
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{count} 事件</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-semibold text-slate-600">参与事件（{mine.length}）</div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {mine.map((event) => (
              <div key={event.id} className="flex items-start gap-2 text-[12px] [content-visibility:auto] [contain-intrinsic-size:auto_42px]">
                <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 text-[10.5px] tabular-nums text-slate-500">
                  第{event.chapter}章
                </span>
                <div className="min-w-0">
                  <div className="line-clamp-2 text-slate-700">{event.summary}</div>
                  <div className="truncate text-[11px] text-slate-400">
                    {event.stateChanges.length > 0 ? `状态变化：${event.stateChanges.join("、")}` : ""}
                    {event.outcome ? `${event.stateChanges.length > 0 ? " · " : ""}结果：${event.outcome}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** V1 拆解的逐章人物记录 → 同章共现关系图（权重=出场章数，边=同章次数）。 */
function v1CoOccurrence(records: V1ImportDoc["chapterRecords"]) {
  const counts = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const record of records) {
    const people = [...new Set(record.characters.map((c) => c.name))];
    for (const p of people) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const key = [people[i], people[j]].sort().join("\u0000");
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = top[0]?.[1] ?? 1;
  const nodes = top.map(([name, count]) => ({
    name,
    weight: Math.max(2, Math.round((count / max) * 9)),
    subtitle: `${count} 章`,
  }));
  const nameSet = new Set(nodes.map((n) => n.name));
  const edges = [...pairs.entries()]
    .map(([key, count]) => {
      const [a, b] = key.split("\u0000");
      return { a, b, count };
    })
    .filter((e) => nameSet.has(e.a) && nameSet.has(e.b))
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);
  return { nodes, edges };
}

/** 事件参与者共现 → 关系图节点与边。 */
function coOccurrence(events: StoryEventRow[], characterMap: CharacterMapRow[]) {
  const rename = new Map(characterMap.map((e) => [e.sourceName, e.targetName]));
  const display = (name: string) => rename.get(name) ?? name;
  const counts = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const event of events) {
    const people = [...new Set(event.participants.map(display))];
    for (const p of people) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const key = [people[i], people[j]].sort().join("\u0000");
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const nodes = top.map(([name, count], index) => ({ name, weight: count, subtitle: index === 0 ? "主角" : undefined }));
  const nameSet = new Set(nodes.map((n) => n.name));
  const edges = [...pairs.entries()]
    .map(([key, count]) => {
      const [a, b] = key.split("\u0000");
      return { a, b, count };
    })
    .filter((e) => nameSet.has(e.a) && nameSet.has(e.b));
  return { nodes, edges };
}
