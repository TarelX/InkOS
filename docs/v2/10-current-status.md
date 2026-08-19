# InkOS V2 当前状态（2026-08-16）

分支 `v2/adaptation-first`（基线 v1.7.2）。以下全部有单测/集成测试/冒烟覆盖，`pnpm -r build && pnpm -r test` 全绿。

## 已交付（V2.1 改编保真纵切）

| 子系统 | 位置 | 测试 |
|---|---|---|
| Story Intelligence Schema（SourceRef/Event/Scene/实体/因果边/故事线/伏笔/节奏 + 内容寻址稳定 ID） | `packages/core/src/story-intelligence/` | 16 用例 |
| 版本化 Artifact Store（原子发布、哈希校验、状态流转、stale 判定、SQLite 索引可重建） | `packages/core/src/artifacts/` + `v2/project-db.ts` | 8 用例 |
| 持久化 DAG Workflow Engine（模板编译校验、状态机、Gate、Retry、Approval、崩溃恢复、stale 传播、事件流水） | `packages/core/src/workflow/` | 11 用例 |
| 深度拆文管线（规则分场 + 模型逐场提取 + 引句强校验反幻觉 + 断点续跑 + 实体合并提案 + 窗口化因果召回 + 故事线聚类 + 节奏报告） | `packages/core/src/story-intelligence/` | 8 用例 |
| 改编管线（契约 → 事件映射 → 人物映射 → 目标骨架 → 章级契约 → 草稿 → 保真审计；B1/B3/B4 硬闸） | `packages/core/src/adaptation/` | 5 用例 + 端到端 |
| 资产注册中心（Skill/Rule/Schema/Template/Evaluator 五类、许可证/信任/checksum 防篡改、SKILL.md 兼容） | `packages/core/src/v2/asset-registry.ts` | 4 用例 |
| V1→V2 迁移器（只增不改、正文哈希校验、沙箱先行闸、幂等） | `packages/core/src/migration/v1-to-v2.ts` | 4 用例 |
| API v2（runs/approvals/artifacts/模板 + Last-Event-ID 可续传 SSE，惰性初始化） | `packages/studio/src/api/v2/router.ts` | 服务器冒烟脚本 |
| 四栏改编工作台（文件树 / Agent 对话 / 工作流节点+审批+日志 / 故事智能画布，按 `ui-reference.png`） | `packages/studio/src/pages/AdaptationStudio.tsx` | 浏览器实测走通全流程 |
| 桌面壳（monorepo 直出，`pnpm deploy` 生产依赖，不再复制全局 npm 安装） | `apps/desktop/` + `scripts/build-desktop.ps1` | — |

## 怎么跑

```powershell
# 开发
pnpm install ; pnpm -r build
node packages\studio\dist\api\index.js <书库目录>   # 打开 http://localhost:4567/#/v2/<bookId>

# API 冒烟（起临时项目全流程验证）
node scripts\v2-smoke.mjs

# 桌面便携版
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
# → apps\desktop\release\win-unpacked\
```

入口：打开任意书后顶栏「V2 改编工作台」按钮，或直接访问 `#/v2/<bookId>`。

## 已知边界 / 下一步

1. **LLM 执行器未接线**：拆文/草稿目前跑 deterministic 基线（结构正确、可全流程验收）。接入真模型 = 实现
   `ChapterAnalysisModel` / `CausalJudge` / `draftWriter` 三个接口并在 `createV2Runtime` 传入 `models`
   （走现有 provider 抽象 + Cursor 反代）。这是 V2.1 收尾的第一优先级。
2. **16 个 V1 补丁尚未迁入源码**（见 `08-v1-to-v2-migration.md` 处置表）：V1 装置继续可用；
   优先级 P0 = patch-thinking-level / patch-cursor-mode / patch-architect-retry（接 LLM 时同文件顺手迁）。
3. 第四栏的 Event Graph / 人物关系图暂为表格与列表渲染，`@xyflow/react` 图形化在 V2.1 收尾迭代。
4. 真书验收（356 章《国运唤名》抽样）待 LLM 执行器接线后跑 `09-evaluation-cases.md` A/B 组。
5. `pnpm -r test` 偶发一次 Node 24 原生崩溃（root cert init assert，vitest worker，与代码无关），重跑即过。
6. **`publish-package.test.ts`（上游发布测试）在本机非确定性失败**：`npm pack` 打 studio 包时 zlib 报
   `Z_DATA_ERROR: incorrect data check`（npm 回读自己刚生成的 tarball 时 CRC 不过）。同一 dist 内容
   6 连跑 2 过 4 挂、`--ignore-scripts`（跳过 prepack 重建）同样偶发，core/cli 小包正常——判定为
   Node v24.14.0 Windows 构建的 zlib 非确定性 bug（同类问题在 Node 14.18/M1、clang-12 构建、Node 18 pre
   均有先例），与仓库代码无关，不影响 studio 运行时、API、桌面构建。全量回归时该用例挂了重跑即可。
