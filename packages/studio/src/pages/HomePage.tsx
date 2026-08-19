/**
 * InkOS V2 首页（对齐 ui-reference 目标设计）：
 *   大标题 + 描述副题 → 最近创作项目卡（渐变封面块）→ 六功能入口卡。
 * 项目卡数据来自 /api/v1/books；功能入口只接通真实存在的路由，不做假按钮。
 */

import { useMemo } from "react";
import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import {
  BookOpen,
  Clapperboard,
  FileText,
  Film,
  Gamepad2,
  Languages,
  ArrowRight,
  Plus,
  Clock,
} from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly updatedAt?: string;
}

export interface HomeNav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toBookCreate: () => void;
  toChat: () => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toTranslation: () => void;
  toFilmStudio: (id: string) => void;
}

/** 项目封面色：由书名哈希稳定取一组渐变，避免随机每次变。 */
const COVER_PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["from-indigo-500/80", "to-violet-500/80"],
  ["from-rose-500/80", "to-orange-400/80"],
  ["from-emerald-500/80", "to-teal-400/80"],
  ["from-sky-500/80", "to-cyan-400/80"],
  ["from-amber-500/80", "to-red-400/80"],
  ["from-fuchsia-500/80", "to-purple-400/80"],
];

function coverFor(id: string): readonly [string, string] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return COVER_PALETTES[Math.abs(hash) % COVER_PALETTES.length];
}

interface FeatureCard {
  readonly id: string;
  readonly title: string;
  readonly desc: string;
  readonly icon: React.ReactNode;
  readonly accent: string;
  readonly onClick: (nav: HomeNav, books: ReadonlyArray<BookSummary>) => void;
}

const FEATURE_CARDS: ReadonlyArray<FeatureCard> = [
  {
    id: "adaptation",
    title: "小说改编",
    desc: "深度拆文 → 改编契约 → 事件映射 → 保真生成",
    icon: <BookOpen size={20} />,
    accent: "text-primary",
    onClick: (nav, books) => nav.toBook(books[0]?.id ?? ""),
  },
  {
    id: "script",
    title: "剧本创作",
    desc: "分幕结构、场景节拍、对白与动作设计",
    icon: <Clapperboard size={20} />,
    accent: "text-violet-500",
    onClick: (nav) => nav.toChat(),
  },
  {
    id: "storyboard",
    title: "分镜创作",
    desc: "镜头链、起始帧、连续性契约与生成 Prompt",
    icon: <Film size={20} />,
    accent: "text-sky-500",
    onClick: (nav) => nav.toChat(),
  },
  {
    id: "short",
    title: "短篇小说",
    desc: "一次成稿的短篇与中篇创作管线",
    icon: <FileText size={20} />,
    accent: "text-emerald-500",
    onClick: (nav) => nav.toBookCreate(),
  },
  {
    id: "play",
    title: "互动影游",
    desc: "分支互动叙事、节点图与可玩导出",
    icon: <Gamepad2 size={20} />,
    accent: "text-amber-500",
    onClick: (nav) => nav.toChat(),
  },
  {
    id: "translation",
    title: "翻译译介",
    desc: "章节翻译、术语表与风格对齐",
    icon: <Languages size={20} />,
    accent: "text-rose-500",
    onClick: (nav) => nav.toTranslation(),
  },
];

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return "";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

export function HomePage({ nav, theme, t }: { nav: HomeNav; theme: Theme; t: TFunction }) {
  const { data } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const books = useMemo(
    () =>
      [...(data?.books ?? [])].sort((a, b) =>
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
      ),
    [data],
  );
  const isDark = theme === "dark";

  return (
    <div className={`min-h-full ${isDark ? "" : "bg-[radial-gradient(1200px_500px_at_20%_-10%,rgba(99,102,241,0.10),transparent)]"}`}>
      <div className="mx-auto max-w-5xl px-8 pb-20 pt-16">
        {/* Hero */}
        <div className="mb-14 text-center">
          <h1 className="font-serif text-5xl font-semibold tracking-tight">
            AI 创作工作台
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            从小说创作、改编分析，到剧本与分镜生产 —— 用结构化 Story Intelligence
            和多 Agent 工作流，把一部长篇变成可追踪、可改编、可影视化的生产资料。
          </p>
        </div>

        {/* 最近创作 */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold">最近创作</h2>
          <button
            onClick={nav.toBookCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground shadow-sm shadow-primary/20 transition-transform hover:scale-[1.03] active:scale-95"
          >
            <Plus size={14} /> 新建创作
          </button>
        </div>
        <div className="mb-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {books.slice(0, 6).map((book) => {
            const [from, to] = coverFor(book.id);
            return (
              <button
                key={book.id}
                onClick={() => nav.toBook(book.id)}
                className="group overflow-hidden rounded-2xl border border-border/50 bg-card/70 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/10"
              >
                <div className={`h-32 bg-gradient-to-br ${from} ${to} flex items-end p-4`}>
                  <span className="rounded-md bg-black/25 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-white/90 backdrop-blur">
                    {book.genre || "未分类"}
                  </span>
                </div>
                <div className="p-4">
                  <div className="truncate font-serif text-[17px] font-semibold group-hover:text-primary transition-colors">
                    {book.title}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[12px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={12} /> {timeAgo(book.updatedAt) || book.status}
                    </span>
                    <span>{book.chaptersWritten} 章</span>
                  </div>
                </div>
              </button>
            );
          })}
          {books.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed border-border/60 px-6 py-12 text-center text-[14px] text-muted-foreground">
              还没有创作 —— 点右上角「新建创作」开始第一本书。
            </div>
          )}
        </div>

        {/* 功能入口 */}
        <h2 className="mb-4 text-[17px] font-semibold">创作方式</h2>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURE_CARDS.map((card) => (
            <button
              key={card.id}
              onClick={() => card.onClick(nav, books)}
              className="group rounded-2xl border border-border/50 bg-card/70 p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
            >
              <div className={`mb-3 inline-flex rounded-xl bg-secondary/70 p-2.5 ${card.accent}`}>
                {card.icon}
              </div>
              <div className="text-[15px] font-semibold">{card.title}</div>
              <p className="mt-1 text-[13px] leading-6 text-muted-foreground">{card.desc}</p>
              <div className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                进入 <ArrowRight size={13} />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
