# V1 → V2 迁移账本

> V1 = 全局 npm `@actalk/inkos@1.7.2` + `D:\inkos\patches` 16 个热补丁 + `D:\inkos\desktop` Electron 壳。
> 处置：`port`（按功能在源码重实现）/ `replace`(被 V2 新子系统取代) / `retire`（不再需要）。

**重要事实（2026-08-16 核实）**：V1 补丁链的锚点（`reasoningRef`、`parseThinkingDirective`、
`interactionMode` 等）大多是**前序补丁注入 dist 的产物**，在 v1.7.2 上游 TS 源码中不存在。
因此 `port` ≠ 机械搬 diff，而是按功能重实现。V2 的替代路径已可用：
LLM 私有字段（thinking level / cursor_mode）可直接通过 `inkos.json` 的 `llm.extra`
（`reasoning_effort`、`cursor_mode`）传给反代，V2 执行器（`completionFromClient`）走同一 client，
无需补丁链即可携带。

## 补丁处置表

| # | V1 补丁 | 处置 | V2 落点 |
|---|---|---|---|
| 1 | patch-attachment-transcript-separation | **port（已完成）** | `packages/core/src/interaction/attachment-transcript.ts` + agent-session/restore 接线 |
| 2 | patch-hooks-pipeline（伏笔回收强化） | **port（已完成）** | planner-context（窗口 12 + 回收前强化）、settler-prompts（回收质量契约）、ai-tells（dim24 高频词，短文本防误报） |
| 3 | patch-memory-backfill-persistence | **port（已完成）** | `pipeline/runner.ts` rebuildCurrentStateFactHistory 保留 facts-backfill.json |
| 4 | patch-style-analyzer（中文分段） | **port（已完成）** | `packages/core/src/agents/style-analyzer.ts`（一行一段 + Markdown 过滤） |
| 5 | patch-direct-chapter-actions | **port（已完成）** | server.ts parseStudioDirectChapterAction + 直连 audit/revise 工具 + RequestedIntent 扩展 + system prompt 模式说明 |
| 6 | patch-model-chat-test | **port（已完成）** | server.ts runServiceChatProbe（两步验证：列表+真实推理）+ 账号池 503 诊断 + 前端 model 透传 |
| 7 | patch-refresh-state | **port（已完成）** | pickModelSelection 用户选择短路 + setSelectedModel 持久化 + last-session 恢复 + /agent 配置服务回退 + visibleMessageEvents（失败轮 ✗ 消息） |
| 8 | patch-refresh-stop-button | **port（已完成）** | server 在飞聊天轮计数 + GET /sessions/:id chatRunning + loadSessionDetail 恢复流 |
| 9 | patch-story-ledger-ui | **port（已完成）** | server.ts story-ledger 三路由 + `public/story-ledger.html`（/story-ledger.html） |
| 10 | patch-rich-attachments | **port（已完成）** | core document-extract + llm/file-input 五件套 + server 提取分支/能力探测路由 + ChatPage 30 格式/20MB/粘贴/拖拽 |
| 11 | patch-thinking-level | **port（已完成）** | `agent-session.ts` reasoning ref + `server.ts` parseThinkingDirective（/think 前缀、model@level 后缀、请求体字段三通道） |
| 12 | patch-architect-retry（确定性补齐 + Ask 拦截） | **port（已完成）** | Ask → `suppressProductionTools`；architect_incomplete 诚实失败文案 + afterToolCall isError |
| 13 | patch-cursor-mode | **port（已完成）** | `agent-session.ts` onPayload 注入 cursor_mode（仅 Cursor 反代端点）+ pipeline extra |
| 14 | patch-deconstruct-adapt（拆文/角色隔离/改编溯源闸） | **replace（已完成）** | Story Intelligence V2 + Adaptation Pipeline + `v1-import.deconstruct` 迁移器 |
| 15 | patch-thinking-level-ui | **port（已完成）** | ChatPage 底部「思考」「模式」下拉（chat store 持久化，请求体显式字段） |
| 16 | patch-workflow-board（六阶段抽屉） | **replace（已完成）** | Workflow Engine V2 + 四栏第三栏（BookWorkbench） |

处置进度：**16/16 全部完成**（2026-08-18）。V1 补丁链退役条件达成：V2 源码已覆盖全部 V1 功能。

## 桌面壳

- `D:\inkos\desktop\main.cjs` → `apps/desktop/main.cjs`（port，改为打包 monorepo build 产物）。
- `prepare-resources.py` / `build.ps1` → retire（被 monorepo 构建 + electron-builder 直出替代）。

## 数据迁移原则（只增不改）

1. `scan → dry-run report → backup → migrate → verify` 五步；任何一步失败保留 V1 可启动状态。
2. 不覆盖：`story/outline`、`story/roles`、`story/state`、`story/deconstruct`、`story/workflow.json`、章节正文。
3. 迁移产物只写入 `books/<id>/.inkos/artifacts/` 与 `.inkos/inkos-v2.sqlite`。
4. 验证：迁移前后章节正文 SHA-256 完全一致；V1 Studio 仍可打开原书库。
5. 先在 `my-novel-v2-sandbox` 副本验证，用户确认后才允许指向原书库。

## 兼容层

- `/api/v1/*` 全部保留；V2 新路由挂 `/api/v2/*`。
- `INKOS_V2_ENABLED=1` 打开四栏与 workflow v2；未开启时行为与 V1 一致。
- V1 拆文库（`story/deconstruct/*.json`）可被 V2 只读导入为 candidate 级 Artifact（无 SourceRef 精确偏移，标注 `provenance: v1-import`）。
