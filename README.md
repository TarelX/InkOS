# InkOS V2 — AI 小说创作 / 改编工作台

基于 `@actalk/inkos@1.7.2`（AGPL-3.0）正式 fork 的 V2 源码仓库。
在上游"AI 写书"能力之上，新增了**故事智能层（深度拆文）**、**版本化产物仓库**、**持久化 DAG 工作流引擎**、**保真改编 / 原创创作双管线**与**四栏统一工作台前端**。

> 功能与代码结构的完整说明见 [`docs/功能模块文档.md`](docs/功能模块文档.md)。
> 数据库表结构见 [`db/`](db/) 目录（仅 DDL，无数据）。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22（建议 24 LTS） | 使用了内置 `node:sqlite` |
| pnpm | ≥ 10 | monorepo 包管理器 |
| Windows / macOS / Linux | — | 桌面打包脚本目前面向 Windows（PowerShell） |

## 依赖安装

本仓库**不含 node_modules 与构建产物**，克隆后安装：

```bash
# 安装 pnpm（如未安装）
npm i -g pnpm

# 安装全部工作区依赖（packages/* 与 apps/*）
pnpm install
```

> Electron 等需要 postinstall 的依赖已在根 `pnpm-workspace.yaml` 的
> `onlyBuiltDependencies` / `allowBuilds` 中放行，`pnpm install` 会自动处理。

## 构建与运行

```bash
# 全量构建（core → studio 前后端）
pnpm build

# 启动 Studio（Web 工作台），第二个参数是书籍项目目录
node packages/studio/dist/api/index.js <你的项目目录>
# 打开 http://localhost:4567
```

首次启动会在项目目录下自动创建 `.inkos/` 状态目录并按代码迁移建库建表（见 `db/`）。

### 桌面版（Windows）

```powershell
# 打包 Electron 桌面应用（绿色目录版 + 安装包）
powershell -File scripts/build-desktop.ps1
```

### 测试

上游与 V2 的测试文件未包含在本仓库中（按发布要求剔除）。
完整开发仓库中可用 `pnpm -r test`（vitest）运行全量测试。

## 目录速览

```
packages/core     核心库：Agent、写作管线、LLM 接入、V2 子系统（artifacts / workflow / story-intelligence / adaptation / creation / migration）
packages/studio   Studio 服务端（Hono API + SSE）与前端（React 四栏工作台）
apps/desktop      Electron 桌面壳
scripts           构建 / 打包脚本
skills            内置写作技能包
db                SQLite 表结构 DDL（inkos-v2 / book-memory / play）
docs              架构决策、迁移台账、验收用例、功能模块文档
```

## LLM 配置

在 Studio「设置 → 模型服务」里配置任意 OpenAI 兼容 / Anthropic / Google 端点；
不配置 LLM 时，V2 工作流会退化为确定性基线执行器（可离线跑通全流程，用于 CI/验证）。

## License

AGPL-3.0-only（继承上游）。
