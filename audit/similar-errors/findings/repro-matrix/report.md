# repro-matrix · 动态复现矩阵（server 模式「存档形状/初始化缺失」类失败）

> **状态更新**：本报告的候选已由 lead 在修复轮（tree-1a9c90046b7b89a6）处理，F1–F6 的修复与验收见 [../../report.md §4](../../report.md)。

> 结论先行：**75/75 条 `CommandPayloadMap` 命令全部跑过（含多步会话/买种子链），40 条链 / 300 步 × 20 个 state。**
> 除「立即领奖修不了的空存档」外，未发现新的**玩家本版本可触发**的功能性失败；
> 发现 **3 条候选**，都属于同一根因：**导入边界不校验 `save` 的子对象形状 → 运行时抛 TypeError → `internal`**（而不是优雅拒绝）。
> 「任务静态表」修复在多形状下 5/5 通过（正面对照）。

- 复现台：[harness-matrix.mjs](<audit/similar-errors/findings/repro-matrix/harness-matrix.mjs>)（`audit/similar-errors/harness.mjs` 的超集副本，未改动原文件）
- 原始输出：[evidence.txt](<audit/similar-errors/findings/repro-matrix/evidence.txt>)
- 基线（本报告不重复）：imported vs imported-reset / fresh 的 `--diff` 已有结论；敏感性验证（stash 修复 → 4/4 `unknown task`）由 lead 完成。

## 0. 复现台设计（可重跑）

```bash
# 覆盖自检：total=75 covered=75
node --experimental-strip-types audit/similar-errors/findings/repro-matrix/harness-matrix.mjs --coverage
# 单场景 / 单变体
node --experimental-strip-types audit/similar-errors/findings/repro-matrix/harness-matrix.mjs --state imported --json
node --experimental-strip-types audit/similar-errors/findings/repro-matrix/harness-matrix.mjs --state variant:gamesave-partial --json
# 全矩阵（20 state × 40 chain）
node --experimental-strip-types audit/similar-errors/findings/repro-matrix/harness-matrix.mjs --matrix
```

20 个 state：`imported` / `imported-reset`（跨一次 06:00）/ `fresh`（adopt 后）+ 17 个「只改一处」的形状变体。
每个 state 都用**同一个 boost**（资源/等级/学习进度），因此差异只来自存档形状。
每个 state 还额外记录 **`importable`**：把该 state 的 `save` 交给 `assertSharedSaveData`（即导入边界 `toSharedSaveData`/`assertEngineState` 用的同一函数）判定，用来区分「真实可导入的形状」与「harness 硬造的死状态」。

## 1. 判定表

| 编号 | 命令 | 变体 / 形状 | 结果 | 对照（正常状态） | 真实可触发？ | 文件:行 | 建议 |
|---|---|---|---|---|---|---|---|
| **R1** | `task.claim`(travel) / `travel.completeCollection` | `variant:gamesave-partial`：`gameSaveDatas` 缺 `travel_china` 键 | **`internal: Cannot read properties of undefined (reading 'length')`** | `imported`：`travel.completeCollection` = ok；`task.claim` travel = ok | **否（本版本）**，理论风险 | `runtime-tasks.ts:180`、`handlers-c.ts:154`、`handlers-b.ts:284`；边界漏检 `data-boundary.ts:358-380` | 边界补 `gameSaveDatas` 形状校验，或读取处用 `?? []`；至少把 TypeError 变成 `not_available` |
| **R2** | `medical.treat`(doctor/owned) / `inventory.*` / `task.claim` | `variant:goods-missing-group`：`selfGoodDatas` 缺 `medicine` 分组 | **`internal: Cannot read properties of undefined (reading 'findIndex')`** | `imported`：doctor = ok；healthy 时 = `not_available the pet is healthy` | **否（本版本）**，理论风险 | `runtime-helpers.ts:360-361`（`inventoryIndex`）、`:373`（`addGood`）；边界漏检 `data-boundary.ts:358-380` | 同上：校验分组齐全，或 `selfGoodDatas[type] ?? []` |
| **R3** | `exam.start` / `job.startStudy` | `variant:study-partial`：`studyInfo` 只有 `chinese` | `exam.start xx-mathematics` → `not_available: unknown study subject` | `imported`（9 键齐全）：ok | **否（本版本）**，理论风险（且只是拒绝，不崩） | `sessions.ts:215`、`handlers-c.ts:83`；边界漏检 `data-boundary.ts:358-380` | 与 R1/R2 一并修：`studyInfo` 缺键按 0 归一化 |
| R4 | `travel.completeCollection` | `imported`（`task` 为 `{}`，taskList.travel 缺失） | 命令成功，但**「重置 keep 任务 take 标记」是静默空操作**（`[].slice(2)`） | `imported-reset`（有 9 条 travel entry）：take 被清回 false | 否：无用户可见差异 | `handlers-b.ts:290` | 无需修；`ensureStaticTaskLists` 重建时就是 `take:false`，语义等价。留一条注释即可 |
| R5 | `task.claim` ddw/growth/travel（18 连领） | `task-counters-only` / `task-counter-lists-empty` / `task-ddW-partial`（只有 1 条 entry） | **全部 ok**（补全由 `ensureStaticTaskLists` 完成） | `imported` 同 setup = ok | —（**修复有效性正对照**） | `handlers-c.ts:149`、`runtime-tasks.ts:143-158` | 保持 |
| R6 | `task.claim`(daily) | `task-daily-defs-no-entry`：有 `daily` 定义、`taskList.daily` 为空 | index0 → `not_available: unknown task`；其它 tab ok | `task.daily`（定义+条目都在）：ok | 存疑但无 UI 触发（见 §3） | `runtime-tasks.ts:184-208`、`handlers-c.ts:152` | 可选：daily 也用 `ensureStaticTaskLists` 同款「按定义补条目」；优先级低 |
| R7 | `signin.sign` / `signin.drawGrowth` | `signin-minimal`（`signin = "{}"`，无 getGrowth/collectionList） | 两者都 ok | `fresh`：同样 ok；`imported`：`already_claimed`（fixture 已签到、已抽过） | 否：**这就是新宠物的标准初始形状**（`save-logic.ts` fresh 的 `signin:'{}'`；`defaultSignIn` 同） | `runtime-helpers.ts:281-294` | 无需处理 |
| R8 | `island.giftNpc` | `island-partial`（无 `want`） | `not_available: no daily want is available` | `imported`：`does not match 小艾's daily want` | 否：两条都是「不可领」，`materializeIslandDay` 会补 want | `island-runtime.ts:428-437` | 无需处理 |
| R9 | `fishing.speedUp` | `fishs-PD-only`（只有 PD 段） | `not_available: the pond is empty` | `imported`：`no pink-diamond speed-ups remain` | 否：两条都拒绝，仅文案不同 | `fishing-runtime.ts:164-167` | 无需处理 |
| R10 | `mail.*` | `email-mixed`（未领/已领/已删占位混合）、`email-claimed-only` | 与 `imported` **完全一致**（claimAll 领 1、deleteAll 删 2、删除后再领 → `not_available`） | `imported`：同上 | 否 | `handlers-d.ts:132-213` | 无需处理 |
| R11 | `farm.*`（13 步：买种/买肥/开荒/种植/施肥/除草/浇水/等待 841 分/收获/清地/售卖） | `farm-half`（2 块地、无 burden/warehouse） | 与 `imported` 一致（`readFarmFromState` 用 `freshFarm()` 合并，12 块地） | `imported`（`farm:"{}"`）：同上 | 否 | `farm-runtime.ts:74-84` | 无需处理 |
| R12 | `fishing.buy/feed/harvest/harvestAll/speedUp` | 成熟鱼（advance 241 分钟） | harvest ok（`ripe:true`）、harvestAll ok（2 条）、speedUp 在 PD 用尽后拒绝 | 同 | 否 | `fishing-runtime.ts:132-178` | 无需处理 |
| R13 | `island.acceptLetter/deliverLetter`、`turnInErrand`（talk/visit/chat/tour/bring/gift）、`startQuiz/answerQuiz`、`fightMonster`、`claimGrowthReward/claimTreasure/refreshNews` | `island-errands`（8 条真实可达委托）、`island.quiz`、`island-partial` | 全部按预期：可完成 → ok；重复 → `already_claimed`；未就绪 → `not_available`；错日期 → `not_available` | `imported`/`imported-reset` | 否 | `island-runtime.ts:291-517`、`sessions.ts:290-383` | 无需处理 |
| R14 | `exam.start/submit`（36 个科目 × 3 步 = 108 步） | `imported`/`fresh`/`imported-reset` | 全部 applied；`passed:true` 分支通过读引擎侧会话答案覆盖；伪 token → `not_available unknown session token` | 同 | 否 | `sessions.ts:201-275` | 无需处理 |
| R15 | `game.*` / `diudiule.*` | 过期（advance 61 分）、错误 token、kind 混用、health<5 | `not_available session has expired` / `unknown session token` / `wrong_phase` / `not_available the pet is too ill` | `imported`：正常领奖 ok | 否 | `sessions.ts:79-199` | 无需处理 |
| R16 | `pet.reset` → `pet.adopt` → 重领（signin/task/island/farm） | `imported` | reset 把 `saveJsonData` 重置为全空 8 键（`emptyJsonData`），adopt 后：signin ok、drawGrowth ok、`task.claim` → `not_available task is not complete`（**不是** `unknown task`）、island/farm 正常 | 同 | 否 | `handlers-a.ts:34-65,104-147` | 无需处理（`ensureStatic` 生效） |
| R17 | `device.list/revoke`、`admin.exportForDetach/importPortableBundle/resumeServer` | 合法/半合法 payload | 全部 `not_available: command is outside the C3/C4a runtime slice` | — | 否：**host-only**，由 `server/src/command-service.ts:191,194,206,234,237` 实现 | `runtime.ts:172-176`（unsupportedCommand） | 无需处理；本报告的 host-only 结果**不代表 server 层语义**（见 §4） |
| R18 | `settings.setShared`、`server.setAdvanceWhileEmpty/setTimeZone/setWeatherCity`、`admin.grantCheat/grantRandomGoods` | `imported` | 全部 applied；非法值 → `invalid_payload`；不存在的 type → `not_available` | 同 | 否 | `handlers-server.ts:20-116` | 无需处理 |
| R19 | 全部命令 | `blobs-missing`：`saveJsonData` 缺 `farm/island/activity/album` 键（旧版本真实形状） | 与 `imported` **零差异** | `imported` | 否 | `runtime-helpers.ts:231-239`（`readSharedBlob` 统一回退） | 无需处理（这是回退做得对的地方） |

「真实可触发」一列的依据：R1–R3 的变体虽然 `importable=true`（边界真的放行），但**本版本客户端不可能产出这种存档**——
`startSave()` 在加载本地 save.json 时就把三类子对象补全：`studyInfo` 9 键齐全（[save-logic.ts:69](<src/shared/save-logic.ts#L69>)）、`selfGoodDatas` 全部分组（[:73](<src/shared/save-logic.ts#L73>)）、`gameSaveDatas` 含 `travel_china`（[:83](<src/shared/save-logic.ts#L83>)），且 `resetPet`/`adoptPet` 走 `emptyEggSave` 同样齐全（`handlers-a.ts:54-62`）。
所以这三条只能由**别的构建/手工改过的 portable bundle** 带进来 → 按 README §3 归为「理论风险」，但属于 S3 的边界缺口，建议随下次 schema 收紧一起修。

## 2. 明确排除：这些差异都是合法前置条件

逐条回答「差异 = 缺陷 还是 前置条件」，排除依据均为上表的对照列：

- **imported vs imported-reset**（每日重置差异）：`signin`（当天已签到/已抽成长 → 重置后可领）、`island.*`（岛屿日由 `materializeIslandDay` 在 06:00 重建，`island.day` 变了 → 委托/灯/宝藏全部重开）。**时间前置**，非缺陷。
- **imported vs fresh**：只有 `signin` 差异（`fresh` 的 `signin:'{}'` = 没签到过）。**数据前置**，非缺陷。
- **`task.static.raw` 在 imported/fresh 都是 `not_available: task is not complete`**：`task:"{}"` → `doNums` 为空 → 计数为 0，这是**真实的资源前置**（玩家确实还没做任务），不是 `unknown task`。这正是修复与未修复的分界：未修复时会先撞 `unknown task`（lead 已完成 stash 敏感性验证）。
- **R4/R6/R7/R8/R9**：要么无用户可见差异，要么两条路径都拒绝。
- **结论**：**没有任何「真实可触发 + 与正常初始化结果不同」的新候选**；R1–R3 是边界校验缺口（理论风险），R4–R6 是已被现有机制吸收的残留。

## 3. 交互核对（客户端会不会把入口显示成可用）

`audit/similar-errors/findings/ui-divergence/report.md` **不存在**（该目录为空），因此按 `src/renderer` 代码核对：

- R1/R2/R3 的状态**客户端无法自行产生**（本地存档在加载期就被 `startSave` 归一化），所以渲染层不会把入口画成「可点但必失败」。客户端把 R1/R2 变成 `internal` 的场景**不存在** → 降级为「理论风险」，无需 UI 侧改动。
- R6（`daily` 定义有、条目无）：客户端每日任务列表从**投影的 `taskList.daily`/`daily` 读**。既然权威端 `taskList.daily` 为空，客户端列表同样是空 → **不会**显示可领按钮；该形状只能由「两份表不同步」的存档在导入后出现，属编辑器/bundle 才能构造 → 同样降级为理论风险。
- R4：`completeTravelCollection` 成功后 `travel_china` 归零，客户端下一轮自然显示「未完成」，与静默空操作一致 → 无可点差异。

## 4. 未覆盖 / 覆盖限制（诚实清单）

- **命令面：75/75 全部至少跑一次**（`--coverage` 自检 `total=75 covered=75 missing=[]`），含需要先建会话（exam/game/quiz）、先买种子/化肥/鱼苗、先做动作凑计数器的多步链。
- **未覆盖的部分**：
  1. `device.*` / `admin.exportForDetach` / `admin.importPortableBundle` / `admin.resumeServer` 只验证到「shared runtime 不实现」，**没有跑 server 层**（需要 sqlite authority + 设备库）。要覆盖需 `cd server && npm test` 或专门的 import 计划测试，按时间盒未做。
  2. `admin.importPortableBundle` 的**迁移归一化**只做了静态阅读（`server/src/portable-import.ts:103-246` 不触碰 `save.saveJsonData`，只重排时钟/锚点/会话），未做纯函数级动态验证。这正是 R1–R3 的入口，建议 verifier 补。
  3. `exam.submit` 的 `passed:true` 分支是 harness 直接读引擎侧 `session.payload.questions[].answerIndex` 构造答案（客户端拿不到答案键，`assertNoSessionAnswerKeys` 保证），故它验证的是运行时分支，不是客户端可完成的路径。
  4. 多账号/多设备并发、`op_id` 幂等重放、跨时区 06:00 双边界未纳入本矩阵。

## 5. 建议（按优先级）

1. **P2**：把 `gameSaveDatas` / `selfGoodDatas` / `studyInfo` / `illustrated` 纳入 `assertSharedSaveData` 的形状校验（或读取处 `?? []` / `?? 0`），把 `internal` 收敛成 `invalid_schema`/`not_available`。这是 R1–R3 的共同根因，也是导入边界唯一被动态证实的缺口。
2. **P3**：`travel.completeTravelCollection` 的 keep 重置加一句「表缺失时跳过并交给 `ensureStaticTaskLists`」的注释（R4，行为已正确）。
3. **P3**：`claimTaskReward` 的 daily 分支可复用 `ensureStaticTaskLists` 思路（R6），避免依赖「两份表必须同步写」。
4. 其余（R7–R19）**不建议改动**：都是合法的资源/阶段/时间/无邮件前置条件，或被现有回退机制正确吸收。
