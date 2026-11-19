# 同类缺陷排查 · 共享约定

> 本目录是「server 模式下领奖失败」修复后的同类缺陷排查工作区。
> 所有结论必须可追溯到 文件:行 / 命令 / 输出；口头判断无效。

## 1. 已知缺陷（起点）

现象：server 模式下，客户端「活动列表」显示「逗逗我~~ 5/5 / 领取奖励」，点击却弹「操作失败 · 当前无法进行这个操作」。

机制（已复现）：

- 服务端权威存档的 `saveJsonData.task` 里 `taskList.ddw/growth/travel` 是空数组（导入/切换模式时 `task` 是 `{}`）。
- `claimTaskReward` 要求 `taskList[tab][index]` 存在，找不到就 `reject('not_available', 'unknown task')`。
- 静态任务表只在每天 06:00 的每日重置里生成（`resetDailyTasks` → `buildResetStaticTaskLists`），切换发生在白天 → 整个窗口期领奖全挂。
- 客户端 UI 用本地 `TASKS` 定义补齐静态表（`src/renderer/pet/tasks.ts` 的 `load()`），只有计数来自服务端 → UI 看起来一切正常，权威端却没有条目。

修复：`ensureStaticTaskLists`（`src/shared/pet-runtime/runtime-tasks.ts`）+ `claimTaskReward` 先补齐再校验。

## 2. 判定标准（什么算「同类错误」）

满足任意一条即可立案：

- **S1 机制同源**：权威 runtime 从 canonical blob 读取数据时使用空/默认回退，但命令路径要求「只能由周期任务或初始化器生成」的条目 → 命令被拒（`not_available` / `wrong_phase` / `internal`）或静默空操作。
- **S2 症状同源**：客户端基于本地默认值/本地推测，渲染出可操作的 UI 状态，而权威端数据缺失或不同 → 用户点击后被拒（或结果与界面不符）。
- **S3 来源同源**：迁移、导入（portable bundle）、本地↔server 模式切换把空或旧结构的 blob 带进权威端，权威端从未归一化。

## 3. 证据门槛

「已确认」必须同时具备：

1. 可复现命令（脚本 + 参数 + 原始输出，输出存到证据文件）；
2. 代码调用链（文件:行，说明读取→回退→拒绝/空操作）；
3. 对照：同一命令在「已初始化/正常状态」下的结果（或说明正常路径如何产生该数据）。

只有推理没有复现的，放「待验证」并写清验证方法。

## 4. 非目标

- 不修与本类无关的 bug、不做泛化重构、不改视觉样式；
- 不动 `src/` 与 `scripts/` 下已有文件（修复阶段由 lead 统一安排）；
- 不在 `audit/similar-errors/` 之外写文件。

## 5. 角色与写作用域

| 角色 | 写作用域 | 职责 |
|---|---|---|
| lead | `audit/similar-errors/`（README、report、evidence） | 定标准、分工、复核、修复决策、最终报告 |
| blob-auditor | `audit/similar-errors/findings/blob-audit/` | 静态审计：blob 读取/回退/初始化器一致性 |
| ui-auditor | `audit/similar-errors/findings/ui-divergence/` | 静态审计：渲染层默认值 vs 权威 runtime |
| repro-auditor | `audit/similar-errors/findings/repro-matrix/` | 动态审计：legacy/导入存档下的命令面矩阵与对照 |
| verifier | `audit/similar-errors/findings/verify/` | 对抗复核：专找能推翻结论的反例 |

## 6. 运行环境

- Node 24，TS 源码用 `node --experimental-strip-types` 直接跑；`src/shared/**` 的相对导入需要 `registerHooks` 补 `.ts`（参考 `scripts/tests/pet-runtime-c3.test.mjs` 头部）。
- 现有测试入口：`node --experimental-strip-types --test scripts/tests/<file>.test.mjs`；server 测试：`cd server && npm test`。
- 真实存档锚点：`audit/similar-errors/fixtures/imported-shared.json`（来自用户 19:36 本地→server 切换时的 bundle，名字已脱敏；`task/farm/fishs/island/email` 为空、`signin` 有值）。
