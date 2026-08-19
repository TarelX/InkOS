/**
 * InkOS V2 左侧窄图标栏（参考 ui-reference：logo 在上、中部主导航、底部设置/主题）。
 * 纯导航壳：每条目是一个带提示的图标按钮；活动页高亮；点击切路由。
 */

import {
  BookOpen,
  Clapperboard,
  FileText,
  Film,
  Gamepad2,
  Home,
  Languages,
  ScrollText,
  Settings,
  Moon,
  Sun,
} from "lucide-react";

import { InkosLogo } from "./InkosLogo";

export interface IconRailItem {
  readonly id: string;
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly onClick: () => void;
}

export function IconRail({
  activePage,
  items,
  onSettings,
  theme,
  onToggleTheme,
}: {
  readonly activePage: string;
  readonly items: ReadonlyArray<IconRailItem>;
  readonly onSettings: () => void;
  readonly theme: "light" | "dark";
  readonly onToggleTheme: () => void;
}) {
  const buttonClass = (active: boolean) =>
    `group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
      active
        ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_var(--tw-shadow-color)] shadow-primary/20"
        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
    }`;
  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-border/50 bg-card/70 py-3 backdrop-blur">
      <button title="InkOS V2 首页" onClick={() => items[0]?.onClick()} className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <InkosLogo className="h-[22px] w-[22px]" />
      </button>
      <div className="flex flex-col gap-1.5">
        {items.map((item) => {
          const active = activePage === item.id || (item.id === "dashboard" && activePage === "dashboard");
          return (
            <button key={item.id} title={item.title} onClick={item.onClick} className={buttonClass(active)}>
              {item.icon}
              <span className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md border border-border/60 bg-popover px-2 py-1 text-[12px] text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                {item.title}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-auto flex flex-col gap-1.5">
        <button title={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme} className={buttonClass(false)}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button title="设置" onClick={onSettings} className={buttonClass(false)}>
          <Settings size={18} />
        </button>
      </div>
    </nav>
  );
}

export const DEFAULT_RAIL_ICONS = {
  home: <Home size={18} />,
  novel: <BookOpen size={18} />,
  adaptation: <FileText size={18} />,
  script: <Clapperboard size={18} />,
  storyboard: <ScrollText size={18} />,
  short: <FileText size={18} />,
  play: <Gamepad2 size={18} />,
  film: <Film size={18} />,
  translation: <Languages size={18} />,
};
