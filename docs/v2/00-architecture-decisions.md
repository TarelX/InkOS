# InkOS V2 架构决策记录（ADR）

> 分支：`v2/adaptation-first`（基线 `v1.7.2`，commit `c7851b9`）
> 上游：<https://github.com/Narcooo/inkos>（AGPL-3.0-only）

## ADR-001 代码基线：正式 fork，不再补丁注入

- V1 形态：全局 npm `@actalk/inkos` dist + `D:\inkos\patches` 的 16 个幂等热补丁。
- V2 形态：本仓库为唯一真源。所有 V1 补丁按 `port / replace / retire` 迁入 TypeScript/React 源码（见 `08-v1-to-v2-migration.md`）。
- 上游跟进方式：保留 `origin` remote，定期 `git fetch` 后 cherry-pick，冲突以 V2 结构优先。

## ADR-002 许可证约束（AGPL-3.0-only）

- 本 fork 及桌面分发必须随发行提供对应源码与修改说明；不允许闭源分发。
- 引入外部技能资产时：MIT/Apache 可迁入；CC BY 保留署名；GPL/AGPL 内容不得混入不兼容发行物。
- 若未来需要闭源商业化：需取得上游商业许可，或 clean-room 重写受影响部分。

## ADR-003 数据真源分层

- **内容真源**：版本化 Artifact（JSON canonical + Markdown projection），落在
  `books/<bookId>/.inkos/artifacts/<artifactId>/<version>/`。
- **状态真源**：项目级 SQLite `.inkos/inkos-v2.sqlite`（workflow runs/nodes/events/approvals + Artifact 索引）。
- SQLite 索引必须可以从 Artifact manifests 全量重建；两者永不互为主。
- V1 真相文件（`story/outline`、`story/roles`、`story/state` 等）在迁移期只读兼容，V2 不在原地覆盖。

## ADR-004 Story Model

- 分析最小单位是 Event（因果）与 Beat（视觉改编），不是章节摘要。
- 所有 accepted 级结论必须携带 `SourceRef`（章节文件 + 内容 SHA-256 + 偏移区间 + 引句 + 引句哈希）；
  无法溯源的结论只能是 `candidate`。
- 稳定 ID：`bookId + sourceHash + chapter/scene/order` 派生；实体合并走 alias/redirect，不重写历史 ID。

## ADR-005 Workflow Engine

- DAG 模板（YAML）+ 编译校验（重复节点/缺依赖/环/schema/gate/retry/approval）。
- 节点状态机：`pending/ready/running/waiting_approval/succeeded/failed/blocked/cancelled/stale/interrupted`。
- 节点输出先进 attempt staging，Gate 通过后原子发布 Artifact；幂等键 = 输入版本 + executor/skill/prompt 版本。
- 服务重启：running → interrupted；幂等节点可 resume。上游 Artifact 变更 → 后代节点 stale。
- SSE 事件带递增 sequence，支持 `Last-Event-ID` 重连。

## ADR-006 Quality Gate

- Gate = 硬约束（可程序判定） + 分项 rubric（LLM 评审，输出证据） + 人工 Approval（高杠杆决策）。
- 模型自评分数不作为客观真值；rubric 分数仅用于排序与提示，硬约束才有一票否决权。

## ADR-007 V2.1 交付范围（改编保真优先）

先打通：深度拆文 → 因果/故事线 → Adaptation Contract → Event Map → Target Spine →
Beat Plan → Draft（前 3 章） → 四类保真审计 → Gate/Approval。
原创长篇（V2.2）、漫剧产线（V2.3）、生成 Provider（V2.4）不混入本期。

## ADR-008 四栏 UI

- 布局参考 `docs/v2/ui-reference.png`（用户提供的设计稿）：
  1. 文件管理（项目导航树：原始小说 / 改编方案 / 世界观 / 人物卡 / 主线脉络 / 章节 / 拆文库 / 资产库）
  2. Agent 对话（Story Architect 会话 + Skill chips + 上下文指示）
  3. 工作流（DAG 节点列表：深度拆文 → 事件链提取 → 主线分析 → 人物分析 → 改编契约 → 章级契约 → …，含进度、耗时、任务日志）
  4. Story Intelligence 画布（Tab：总览 / 主线结构 / 正文 / 人物关系 / 世界观 / 状态；含 Premise 卡、三幕主线条、节奏/冲突/伏笔指标、章节节拍、人物关系图谱）
- 技术：`react-resizable-panels` 四栏拖拽 + 复用已有 `@xyflow/react` 画 DAG 与关系图；长列表虚拟化。
- 所有 Agent 结论必须能跳转 Evidence；Retry/Cancel/Approve 只调 run/node API，UI 不直接改状态。

## ADR-009 模型调用

- LLM 一律走现有 provider 抽象（本机默认 Cursor 反代 127.0.0.1:9000，OpenAI 兼容）。
- 每个节点记录 provider/model/prompt version/skill versions/input artifact versions/tokens/latency。
- CI 集成测试使用 deterministic fake LLM；真实模型只做本地 canary。
