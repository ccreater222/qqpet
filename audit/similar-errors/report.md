# server 模式「同类错误」排查报告

> 起点：server 模式下「逗逗我 5/5 · 领取奖励」点击后弹「操作失败 · 当前无法进行这个操作」。
> 根因已定位并修复（服务端 `task` 的静态任务表从未物化）。本报告回答：**代码里还有没有同类错误？**
> 所有结论绑定可重跑命令与文件:行；仅推理的标「待验证」。

## 0. 结论

**有同类机制，但只有一类会重现「界面可点、点击即失败」的致命症状——就是已修的静态任务表。** 其余同根问题分成四档，均不会让按钮报错，但会造成内容/金额不一致、功能空窗或数据丢失：

| 编号 | 发现 | 类型 | 真实可触发？ | 严重度 | 状态 |
|---|---|---|---|---|---|
| **F1** | 静态任务表（`taskList.ddw/growth/travel`）只由 06:00 重置生成，领奖要求条目存在 | S1 | 是（本次故障） | 致命 | **已修复 + 回归测试** |
| **F2** | 今日任务（`daily`/`taskList.daily`）同理由 06:00 生成；server 模式切换/新领养后到次日 06:00「今日任务」为空 | S1 同型 | 是 | 中（功能空窗） | **已修复**（首 tick/领养/领奖按需生成） |
| **F3** | 渲染层用本地 `Math.random` 伪造 reroll 奖励图标，权威端首次领奖才生成另一组 | S2 | 是 | 中低（观感/信任） | **已修复**（投影模式不再本地抽） |
| **F4** | 客户端提示与权威结果不一致：商城结算恒成功、看病报价不含药费 | S2′ | 是 | 中高（误报成功/金额） | **已修复**（共享医疗报价 + 逐条结算） |
| **F5** | 导入边界（bundle）不归一化嵌套 canonical 结构；`assertSharedSaveData` 只校验顶层 | S3 | 仅外部/旧构建 bundle | 低概率/高后果（C04 会让世界推进停摆） | **已修复**（normalize + 类型校验） |
| **F6** | 本地→server 迁移把在途打工/上课/旅游丢掉（无 job、首次 tick 静默清空，无奖励） | S3 | 是（切换时在途） | 中（一次性） | **已修复**（迁移重建 pending job） |

一句话：**F1–F6 均已在工作区修复并通过回归**（修复细节与证据见第 4 节）；服务端仍待部署（`100.64.0.3`），部署后现有存档无需迁移，首个 tick 会自动补齐任务表。

## 1. 方法与证据强度

判定标准见 [README](./README.md)：S1 权威端从空 blob 回退但要求「只能由周期任务生成的条目」；S2 客户端用本地默认/随机决定可操作状态；S3 迁移/导入把空或旧结构带进权威端。

三条独立审计线，互相对照：

1. **静态 blob 审计**（blob-auditor）：逐 blob / 逐字段列出「读取→回退→命令依赖→谁初始化」，15 条候选、10 条排除，见 [blob-audit/report.md](./findings/blob-audit/report.md)。
2. **渲染层对照**（ui-auditor）：UI 判定源（A）vs 命令（C）vs handler（B）三元组，12 条高可疑、14 条排除、9 条潜伏，见 [ui-divergence/report.md](./findings/ui-divergence/report.md)。
3. **动态矩阵**（repro-auditor + lead）：`CommandPayloadMap` **75/75 命令全覆盖**、40 条链、300 步 × 20 种存档形状；三场景（imported / imported-reset / fresh-adopted）共用同一资源 boost，只让存档形状成为变量，见 [repro-matrix/report.md](./findings/repro-matrix/report.md)。

**敏感性校验（关键）**：把 F1 修复 `git stash` 后，矩阵 `task.static` 链 4/4 报 `not_available/unknown task`；恢复修复后通过。证明这套动态证据能检测到本次缺陷，不是「跑绿了但眼瞎」。
锚点：`fixtures/imported-shared.json` 来自用户 19:36 本地→server 切换时的真实 bundle（名字已脱敏，`task/farm/fishs/island/email` 为空、`signin` 有值）。

## 2. 已确认发现

### F1 静态任务表未物化（已修复，致命）

- 机制：`claimTaskReward` 要求 `taskList[tab][index]` 存在，否则 `not_available/unknown task`（[handlers-c.ts:152](../../src/shared/pet-runtime/handlers-c.ts)）；静态三表**只**由 `resetDailyTasks → buildResetStaticTaskLists` 生成（[runtime-tasks.ts:160-177](../../src/shared/pet-runtime/runtime-tasks.ts)）。
- 客户端用本地 `TASKS` 定义补齐，所以「界面可领」；服务端没有条目 → 点击失败。
- 修复：`ensureStaticTaskLists` 在领奖前按 `STATIC_TASKS` 补齐缺失条目（保留已有 `take`/奖励，reroll 用 runtime RNG），[runtime-tasks.ts:143-158](../../src/shared/pet-runtime/runtime-tasks.ts) + [handlers-c.ts:149](../../src/shared/pet-runtime/handlers-c.ts)。
- 回归：c3 套件新增 3 个用例（空 blob 领奖、部分表保留/reroll、**每个静态条目在未初始化存档上逐一可领**），38/38 通过；全量 `test:compat` 770 例（768 通过、2 跳过）、server 测试 89 例、`npm run typecheck` 均通过。

### F2 今日任务在 06:00 前为空（S1 同型，真实，非报错）

- `daily` 定义与 `taskList.daily` 只由 `rollDailyTasks` 生成，唯一调用点是每日边界（[runtime-tasks.ts:64-108,160-177](../../src/shared/pet-runtime/runtime-tasks.ts)）。
- 证据（[evidence/tick-and-daily-gaps.out](./evidence/tick-and-daily-gaps.out)）：导入存档 `daily=0 taskList.daily=0`；跨过一次 06:00 后 `daily=4 taskList.daily=4`。
- 为什么是回归：legacy 模式在启动/跨日时 `rollDaily` 会立刻生成（[renderer/pet/tasks.ts:245-264](../../src/renderer/pet/tasks.ts)）；server 模式渲染层 `rollDaily` 直接 return，权威端只认 06:00 → 19:36 切换或 20:00 新领养的用户，到次日 06:00 之前「今日任务」是空的。
- 影响：不是点击失败（空表没有可点条目），是**功能空窗**；与 F1 同根（周期内容缺按需生成）。

### F3 reroll 奖励图标由本地伪造（S2，真实，内容层）

- 渲染层 `load()` 在 blob 缺条目时用本地 `rewards()`（`loot(reroll)`，`Math.random`）补 `good`（[renderer/pet/tasks.ts:121-134](../../src/renderer/pet/tasks.ts)），UI 直接画这些图标（[renderer/ui/task.ts:43](../../src/renderer/ui/task.ts)）。
- 权威端在领奖时才用 runtime RNG 生成 `entry.good`（[handlers-c.ts:158](../../src/shared/pet-runtime/handlers-c.ts)）→ 玩家会看到「图标 A、弹窗 B」。用户截图里第 4/5 条（reroll 模板）的图标就来自本地随机。
- 可领性判定仍来自投影（`take`/`doNums`），所以**不会**再出现 F1 式拒绝；属内容层 S2、经济无害、信任有害。
- 若 blob 形如 `taskList.ddw[0]={}`（条目在但缺 `good`），`t.good.map` 会抛 `TypeError`；该形状会被导入校验拒绝，标「待验证」。

### F4 客户端提示 ≠ 权威结果（S2′，真实）

1. **商城假成功**：[renderer/pet/items.ts:206-213](../../src/renderer/pet/items.ts) 在 projection 模式 `buy()` 先发命令、**恒返回 true**；[renderer/ui/shop.ts:303-349](../../src/renderer/ui/shop.ts) 的 `checkout()` 据此清空购物车并道谢。服务端可能以等级/粉钻/余额拒绝（[handlers-b.ts:46-61](../../src/shared/pet-runtime/handlers-b.ts)）→ 购物车清空、实际什么都没买到。
2. **看病报价不含药费**：渲染层只报 `(5-health)*10`（[renderer/pet/items.ts:236-247](../../src/renderer/pet/items.ts)）；服务端在没有对症药时额外扣 `药价×1.2`（[handlers-b.ts:168-181](../../src/shared/pet-runtime/handlers-b.ts)），死亡状态更是无报价直接扣钱。界面金额 ≠ 实扣金额。
3. 同类较轻：领奖/签到成功后立即 `render()`，读的仍是旧投影，按钮短暂仍可点，再点会被服务端以 `already_claimed` 拒绝（UD-02）。

### F5 导入边界不归一化嵌套 canonical 结构（S3，低概率/高后果）

- 校验只到顶层：`assertSharedSaveData` 要求 `studyInfo/selfGoodDatas/selfGoodUseOption/gameSaveDatas/activeOption/illustrated` 这些**键存在**，不校验键内结构；迁移只 backfill `petInfo.diamond`（[portable.ts:594-598](../../src/shared/sync/portable.ts)、[data-boundary.ts:358-380](../../src/shared/sync/data-boundary.ts)）。
- 实测（[evidence/nested-shape-gap.out](./evidence/nested-shape-gap.out)），这些形状都能通过 `assertSharedSaveData`：
  | 形状 | 后果 |
  |---|---|
  | `activeOption={}` 或缺 `work` | `job.startWork` → **`busy`（恒忙，误导）** |
  | `gameSaveDatas={}` | `travel.completeCollection` / `task.claim travel#2` → `internal: reading 'length'` |
  | `selfGoodDatas` 缺 `food` | `inventory.buy/use` → `internal: reading 'findIndex'` |
  | `selfGoodUseOption` 缺任一键 | **每分钟 tick → `internal: reading 'left'`**（[tick.ts:259-271](../../src/shared/pet-runtime/tick.ts)）；server 侧 `scheduler.tick_failed`，世界推进停摆 |
- 可达性：本版本自身存档不会长这样——renderer `startSave().repair()` 会补齐 9 科目/全部分组/`travel_china`（[save-logic.ts:69-87](../../src/shared/save-logic.ts)），`emptyEggSave` 也齐全；只有其它构建/手改/第三方 bundle 经 `admin.importPortableBundle` 进来才会命中。因此归为**导入加固**，不是当前玩家可触发。

### F6 迁移丢在途活动（S3，真实，一次性，中）

- 迁移把 `scheduledJobs` 置空（[portable.ts:672](../../src/shared/sync/portable.ts)），而 legacy 的在途状态只存在于 `activeOption.work` + `saveJsonData.activity`（无 job）；首个 tick 的 `syncActivityProjection` 发现没有 pending job → 直接清空 `work/study/trip` 并把 `activity` 写 0（[tick.ts:227-235](../../src/shared/pet-runtime/tick.ts)）。
- 证据（[evidence/tick-and-daily-gaps.out](./evidence/tick-and-daily-gaps.out)）：`before: work=bz activity=30 jobs=0` → 一 tick 后 `work=null activity=0`，事件只有 `pet.statsChanged`，**无奖励、无计数**。
- 触发：本地→server 切换（或导入）时正好在打工/上课/旅游；用户 19:36 的存档里 `activeOption` 全空，未命中。

## 3. 已排除（附证据，避免重复排查）

| 对象 | 结论 | 证据 |
|---|---|---|
| `island` 空 blob | 首次 island 命令懒物化；实测 `arriveScene` 后 8 条 errand + want；`refreshNews` 4 条 facts | [evidence/self-initializing-blobs.out](./evidence/self-initializing-blobs.out) |
| `farm` 空 blob | `freshFarm()` 兜底；`reclaim` 后 18 块地 | 同上 |
| `fishs` 空 blob | `readPond` 兜底；`fishing.buy` 后 pond 有鱼 | 同上 |
| `email` 空 | 新存档本就无邮件，UI 不展示条目；`claimAll` 的拒绝语义正确 | [blob-audit/report.md](./findings/blob-audit/report.md) §6 |
| `signin` 空 | 客户端与权威端默认一致（`getBirthDayGift:true`），界面隐藏按钮；无「点击失败」 | 同上 |
| `album`/`activity` | 只增/只写，读取对坏 JSON 统一回退 | 同上 |
| legacy 设置页直写（`setFrozen`/`setCustody`/`undoing` 等） | projection 模式下 `setup.ts:485/523` 换成命令驱动表单，legacy section **不可达**，仅属潜伏点 | [ui-divergence/report.md](./findings/ui-divergence/report.md) §0.1 |
| 内容表漂移 | renderer/canonical 的 tasks、goods、fries、exam 完全一致；省份名一致 | ui-auditor `check-task-tables.out` |
| `task:'{}'` 时点「今日任务」 | 空表无条目可点，不构成点击失败（但见 F2 空窗） | 本报告 §2 F2 |
| `completeTravelCollection` 对空 travel 表的 `slice(2)` | 空操作；计数已清零，无法重复领奖 | blob-auditor E9 |

## 4. 修复记录与验收（本轮已实施）

### 4.1 修复清单

| 编号 | 改动 | 关键行为 | 测试 |
|---|---|---|---|
| F1 | `ensureStaticTaskLists` + `claimTaskReward` 先补齐（上一轮） | 静态三表缺失时按模板物化，保留已有 `take`/奖励 | c3 新增 3 例（含全静态条目逐一可领） |
| F2 | `ensureTaskTables`（`runtime-tasks.ts`）在首 tick / `pet.adopt` / `task.claim` 前补齐静态表与今日表 | 导入或新领养后立即有今日任务；06:00 仍只重置一次 | c3 新增 3 例（首 tick、领养、跨边界只 roll 一次）+ 验收脚本 |
| F3 | 新建 `task-preview.ts`，`tasks.ts` 投影模式只显示固定奖励 | 不再用本地 `Math.random` 伪造 reroll 图标 | `task-preview` 3 例；`renderer-c6b` 断言投影模式 loot 调用为 0 |
| F4 | 新建 `medical-cost.ts` 共享报价；`handlers-b` 用它计费；`items.ts` 新增 `buyRuntime`、医生文案用报价；`shop.ts` 逐条 await 结算 + 新建 `shop-cart.ts` 纯函数 | 看病报价=实扣（含药费/死亡复活药）；商城被拒不再清空购物车/道谢，失败行保留 | `medical-cost` 8 例、`medical-treat` 7 例（实扣=报价）、`shop-cart` 5 例 |
| F5 | 新建 `normalize.ts`；legacy 迁移、bundle 回填、server `planPortableImport`、local v2 导入均先归一化；`data-boundary` 增加“存在即校验类型”的组校验（缺失/null 放行，`die` 豁免） | partial 嵌套结构在导入边界补齐；坏类型仍在边界 `invalid_schema`/`invalid_payload` 被拒 | `portable-normalize` 7 例（含 server plan 不改调用方、幂等、坏类型拒绝） |
| F6 | `portable.ts` 新增 `restoreLegacyActivityJob` | 迁移按 `activeOption`+`activity` 分钟数重建 pending job；到期结算一次，未知 id 不建 job | `portable-migration-jobs` 7 例（work/study/travel、提前/到期/已完成/未知） |

### 4.2 验收证据

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过（node/web/harmony/e2e 四个配置） |
| `npm run test:compat` | **811 tests / 809 pass / 2 skip / 0 fail** |
| `cd server && npm test` | **89 / 89 pass**（server 重新编译 shared） |
| 本轮相关套件合并 | **162 / 162 pass**（c3、c4a、c4b、task-preview、renderer-c6b、medical-cost、medical-treat、shop-cart、portable-normalize、portable-migration-jobs、sync-data-boundary、sync-protocol） |
| 独立验收脚本 | [evidence/f2-f6-acceptance.out](./evidence/f2-f6-acceptance.out)：F2 首 tick/领养后 `daily=4`、F3 投影 `lootDraws=0`、F4 三组“报价=实扣”、F5 partial 迁移后 buy/work/tick/travel 全通、F6 job 到期结算 `Work+1` |
| 敏感性（上一轮） | stash 掉 F1 修复后矩阵 4/4 报 `unknown task`，恢复后通过 |

### 4.3 行为变化与兼容性说明

- **F2 会改变首个 tick 的 RNG 流**：首 tick/领养会物化任务表并抽奖，既有 characterization 的 golden digest 与 adopt 路径期望已按新语义更新（c3 内有注释），不是放松断言。
- **F3** 在权威端尚未物化的极短窗口内，reroll 模板显示“无图标”而不是本地猜测；F2 让这个窗口通常不超过 1 个 tick。
- **F4** 商城部分失败时购物车保留失败行并给一行提示；看病弹窗展示诊疗费+药费合计（死亡展示复活药费）；单件即时购买仍保持逐件道谢。
- **F5** 归一化只发生在迁移/导入/文档加载边界，`assertSharedSaveData` 仍严格；**整组缺失**（不是缺成员）的 bundle 仍会在命令 payload 校验阶段被拒（这是本次未放开的上限，避免凭空生成顶层结构）。
- **F5 校验收紧**：历史 server 状态若本身含坏类型（非本版本产生），升级后会在加载时 fail closed，需要重新导入；正常存档与 fixtures 不受影响。
- **F6** 仅作用于 legacy 裸存档迁移；自带 `scheduledJobs` 的 bundle 完全不动；未知活动 id 不重建（不抛错）。

### 4.4 后续建议（未做）

- **部署**：把本轮 + F1 一起部署到 `100.64.0.3`（重建 server、重启）；现有存档首个 tick 自动补齐任务表。
- **可观测性**：`dispatchRuntimeCommand` 把服务端 `error.code/message` 打到 `console.warn`，避免再次只看到“当前无法进行这个操作”。
- **server 端命令测试**：目前 server/test 没有 task/island/farm/fishing 的命令面断言，建议补一条“导入后首 tick → 领取今日任务”的端到端用例。
- **F5 剩余面**：若需要支持“整组缺失”的更老 bundle，应在命令 payload 校验前做 normalize（协议层），而不是在 plan 内；这会改变 wire 校验语义，需单独评审。
- **渲染层 E2E**：仓库无 jsdom，F4 的购物车/看病交互只有纯函数与代码级验证，建议后续用 Electron E2E 覆盖。

## 5. 复现命令

```bash
cd /Users/ccreater/Desktop/work/qqpet

# 三场景矩阵与 diff（75/75 命令覆盖）
node --experimental-strip-types audit/similar-errors/harness.mjs --scenario imported
node --experimental-strip-types audit/similar-errors/harness.mjs --diff

# 嵌套结构缺口（activeOption/travel_china/selfGoodDatas）
node --experimental-strip-types audit/similar-errors/evidence/nested-shape-gap.mjs

# C04 tick 停摆 / F2 今日任务空窗 / F6 在途活动丢失
node --experimental-strip-types audit/similar-errors/evidence/tick-and-daily-gaps.mjs

# 自初始化对照（island/farm/fishs）
node --experimental-strip-types audit/similar-errors/evidence/self-initializing-blobs.mjs

# 本轮验收（F2–F6：每日任务/预览/报价/归一化/迁移 job）
node --experimental-strip-types audit/similar-errors/evidence/f2-f6-acceptance.mjs

# 回归
node --experimental-strip-types --test \
  scripts/tests/pet-runtime-c3.test.mjs \
  scripts/tests/task-preview.test.mjs \
  scripts/tests/medical-cost.test.mjs scripts/tests/medical-treat.test.mjs scripts/tests/shop-cart.test.mjs \
  scripts/tests/portable-normalize.test.mjs scripts/tests/portable-migration-jobs.test.mjs \
  scripts/tests/renderer-c6b.test.mjs
npm run test:compat
cd server && npm test
```

## 6. 遗留未知与限制

- **部署未做**：所有修复目前只在工作区（未提交、未部署）；`100.64.0.3` 仍是旧服务端，F1/F2 的玩家可见效果要等部署后生效。
- **F5 上限**：整组缺失（而非缺成员）的 bundle 仍在 payload 校验被拒，未纳入本次归一化；历史 server 状态若含坏类型会在加载时 fail closed（预期，但需要时需重新导入）。
- **渲染层 E2E 缺位**：仓库无 jsdom，F4 的购物车/看病交互只有纯函数与代码级验证（`renderer-c6b` 只覆盖任务预览）；建议后续用 Electron E2E 走一遍真实点击。
- **F2 RNG 流**：首个 tick 的随机消耗已改变，golden digest 已按新语义更新；跨版本逐 tick 逐字节对比的历史工装需要重新基线。
- `device.*` / `admin.*` 仍只验证到 runtime/host 边界；F5 的 server WS 层另由 server 测试覆盖（89/89）。

## 附：子报告

- [blob-audit/report.md](./findings/blob-audit/report.md)（15 候选 / 10 排除 / 导入校验总账）
- [ui-divergence/report.md](./findings/ui-divergence/report.md)（12 高可疑 / 14 排除 / 9 潜伏 / 本地写入口未迁移）
- [repro-matrix/report.md](./findings/repro-matrix/report.md)（75/75 覆盖 / 20 状态 / 3 条导入边界候选）
