# V2.1 验收用例（改编保真闭环）

## 数据集

- `test-fixtures/mini-novel/`：无版权风险的 8–12 章合成小说 fixture（进仓库）。
- 用户真实书（如《国运唤名-我以妖族镇诸天》356 章）只在本地 eval runner 抽样，不进仓库。

## A. 深度拆文

| 用例 | 判定 |
|---|---|
| A1 随机抽 20 个重大事件 | 每个都能通过 SourceRef 定位原文，引句哈希校验通过 |
| A2 主线可追踪 | 主线 Storyline 从起点事件一路追到兑现事件，每条边有解释 |
| A3 删边影响 | 人为屏蔽一个关键事件后，系统能列出失去因果依据的后续事件 |
| A4 人物弧 | 重要角色的转变均能点到触发事件 |
| A5 停滞检测 | 系统指出的主线停滞章节附带可点击证据（低 delta 指标 + 原文） |
| A6 断点续跑 | 拆文中途 kill 进程，重启后从 checkpoint 继续且结果与一次跑完一致 |

## B. 改编保真

| 用例 | 判定 |
|---|---|
| B1 must_preserve 覆盖 | Contract 中 must_preserve 源事件 100% 有 target mapping |
| B2 决策可见 | preserve/compress/merge/split/reorder/replace/remove 每条有 reason |
| B3 因果不破坏 | 删除强因果中间事件而无 replacement 时 Gate 阻断 |
| B4 角色溯源 | 改编书主要角色全部来自源实体或已批准合并/发明 |
| B5 端到端 | 真实/fixture 源书 → Contract → Event Map → Target Spine → 前 3 章 Draft + 四类审计全部产出 |

## C. Workflow Engine

| 用例 | 判定 |
|---|---|
| C1 刷新不丢 | 浏览器刷新后 run/node 状态从 SQLite 恢复，一致 |
| C2 重启恢复 | 服务重启后 running → interrupted，幂等节点 resume 成功 |
| C3 stale 传播 | 修改上游 Artifact（如源章节）后，依赖节点全部标 stale |
| C4 单点 retry | 失败节点单独 retry，不重跑已成功的兄弟节点 |
| C5 SSE 续传 | 断开 SSE 后带 Last-Event-ID 重连，无事件丢失/重复 |
| C6 输入输出真值 | 每个节点展示的 input/output 与 Artifact manifest 一致 |

## D. 迁移与桌面

| 用例 | 判定 |
|---|---|
| D1 正文不动 | 迁移前后章节 SHA-256 全等 |
| D2 可回滚 | 迁移后 V1 Studio 仍能打开原书库 |
| D3 沙箱先行 | 未过沙箱验证时拒绝迁移原书库 |
| D4 桌面 E2E | 新书库首启 → 迁移副本 → 改编前三章 → 重启续跑 → 导出 |
