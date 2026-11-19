# 权威 runtime「读取 → 空档回退 → 命令依赖条目」静态审计（blob-audit）

> **状态更新**：本报告的候选已由 lead 在修复轮（tree-1a9c90046b7b89a6）处理，F1–F6 的修复与验收见 [../../report.md §4](../../report.md)。

> 审计员：blob-auditor ｜ 范围：`src/shared/pet-runtime/**` + 导入/迁移归一化（`src/shared/sync/**`、`server/src/portable-import.ts`、`src/main/local-repository.ts`、`src/shared/local-repository/host.ts`、`storage-controller` 模式切换）
> 基线缺陷：`saveJsonData.task` 为空 → `claimTaskReward` 拒绝 `not_available/unknown task`（README §1）。
> 本报告未修改 `src/`、`scripts/`、`server/` 下任何已跟踪文件；新增文件仅在本目录。
> 复现脚本：`probe.mjs`（内存构造，不落盘）；原始输出：`evidence.txt`（`bash evidence.sh > evidence.txt` 可重跑）。

## 0. 结论摘要

- **候选 15 条**：A 级（真实 fixture 直接命中且在命令面上可复现）**1 条**；B 级（导入校验确认放行 + 合成空档命中，代码链完整）**9 条**；观察/变体（同机制但当前不产生拒绝，或方向相反的多给）**5 条**；另有 **10 条已排除**（列在 §6，避免重复排查）。
- 最可疑 3 条：
  1. **C01** `task.claim` 的 `daily` 表仍然"只由 06:00 重置生成"，`ensureStaticTaskLists` 只补 `ddw/growth/travel` → 导入后 `task:'{}'` 点今日任务仍是 `not_available/unknown task`（与已修缺陷同一命令、同一拒绝码）。
  2. **C02** `gameSaveDatas.travel_china` 缺失时，`task.claim(tab:'travel', index:2)`（Travel2 计数）与 `travel.completeCollection` 直接 `TypeError → internal`；导入校验放行该空档。
  3. **C04** `selfGoodUseOption` 缺键时 `tickTimedGoods` 对 `undefined` 取 `.left` → **每一分钟 tick 都 internal**（不是单条命令失败，而是世界推进停摆）。
- 根因（S3 总账）：**导入/迁移只归一化 `petInfo.diamond`**；`assertSharedSaveData` 只校验"组存在 + blob 形状"，从不校验 `studyInfo / selfGoodDatas / selfGoodUseOption / gameSaveDatas / activeOption / illustrated / petComputedlInfo` 的成员。因此"空存档"能通过导入，却把补默认值的责任摊给了每个 handler。详见 §4、§5。

## 1. 判定方法与证据等级

| 级别 | 含义 | 本报告条目 |
|---|---|---|
| A | 真实 fixture（`fixtures/imported-shared.json`）+ 实际命令面复现，且与正常状态对照 | C01 |
| B | 导入校验实测放行（`validateEngineState === true`）+ 合成空档命中拒绝/异常，代码链完整；触发依赖"旧存档缺该字段" | C02–C10 |
| 观察 | 机制同源，但当前 UI 不会给出可点条目，或方向是"多给"而非"拒绝" | C11–C15 |
| 排除 | 有默认值/懒生成/导入强校验兜底，或已核实不会产生用户可见失败 | E1–E10 |

证据门槛对齐 README §3：每条给"复现命令 + 代码调用链 + 正常状态对照"；无法用真实存档证明"旧存档确实会缺该字段"的，明确标注为 B 级并交 repro-auditor 用 legacy/截断存档复核。

## 2. blob 读者矩阵（`saveJsonData` 8 个键）

`readSharedBlob`（`runtime-helpers.ts:231-239`）的语义：**键不存在 → fallback；JSON 解析失败 → fallback；解析成功但类型不对（如 `'null'`/`'[]'`）→ 原样返回**（类型问题靠导入 canonical 校验挡住，见 E7）。因此"键缺失"与"`{}`/`'[]'`"在读取侧等价。

| blob | 读取函数（文件:行） | 空档回退形状 | 依赖"已存在条目/元素"的 handler | 条目由谁生成 | `{}` / `[]` / `'0'` 下实测行为 | 判定 |
|---|---|---|---|---|---|---|
| `task` | `readTaskProgress` `runtime-helpers.ts:249-263` | `{doNums:{}, taskList:{daily:[],ddw:[],growth:[],travel:[]}, daily:[], dailyDay:0}`（`defaultTaskProgress` 245-247） | `claimTaskReward` `handlers-c.ts:146-166`；`completeTravelCollection` `handlers-b.ts:289-291`；`rewardGameSession` `sessions.ts:140-141`（`doNums.Game ?? 0` 安全） | 静态三表：`resetDailyTasks→buildResetStaticTaskLists`（`runtime-tasks.ts:111-134,160-177`），修复后按需 `ensureStaticTaskLists`（136-158）；`daily` 表：**仅** `rollDailyTasks`（64-108，唯一调用点 175） | `task.claim daily#0 → not_available/unknown task`；`ddw/growth/travel` 由修复补表 → `not_available/task is not complete`；`travel#2` 计数读 `travel_china`，缺字段 → internal | **C01 / C02 / C15** |
| `signin` | `readSignIn` `runtime-helpers.ts:285-294` | 内联默认，`collectionList:{}`、`getGrowth:null`、`onlineGiftNum:0`、`isOnlineLastTime:20`、`getBirthDayGift:true`（注意 `defaultSignIn` 281-283 未被调用） | `signIn` `handlers-d.ts:33-54`；`drawGrowth` 56-86；`claimOnlineGift` 88-109（`:91` 冷却判定）；`claimBirthdayGift` 111-130（`:114` 已领判定） | `collectionList`/`getGrowth` 由对应命令写；`isOnlineLastTime` 由 `resetSignInAtBoundary`（`tick.ts:64-71`）与 `sessionClockTick`（273-281）维护；`getBirthDayGift` 仅边界且 `onLineTime>10` 时置 false | `claimOnlineGift → cooldown`（20 分钟内）；`claimBirthdayGift → already_claimed`（默认 true）；`signIn` 可重复签到 | **C12**（方向为多给 + 生日礼物默认锁死，非点击失败） |
| `email` | `readMails` `runtime-helpers.ts:300-302` | `{}` | `claimMail` `handlers-d.ts:143-159`；`claimAllMail` 161-181（`:172`）；`deleteMail` 183-196；`deleteAllMail` 198-213 | `deliverMails` 只在 06:00（`tick.ts:73-106`，欢迎信 77-78）；旅行明信片 `travel.ts:59-71` | `mail.claimAll → not_available/no mail rewards are available`；`mail.claim → not_available/mail does not exist or was deleted` | **C11**（机制同源，非缺陷：新存档本无邮件、UI 也不展示条目） |
| `fishs` | `readPond` `runtime-helpers.ts:351-354` | `{PD:{allvipcnt:0,canusecnt:0}, fishs:[]}` | `fishingSpeedUp` `fishing-runtime.ts:164-178`（`:166` 依赖 `PD.canusecnt`）；`fishingFeed/Harvest` 依赖用户自己买的鱼（合理） | 鱼：`fishingBuy`；`PD`：`resetFishLimits`（`handlers-b.ts:214-219`，06:00 或首次买粉钻 `:236`） | `fishing.speedUp`（粉钻用户 + `{}`）→ `not_available/no pink-diamond speed-ups remain`；`resetFishLimits` 后无鱼 → `not_available/the pond is empty`；重置后 1 条鱼 → OK | **C09** |
| `farm` | `readFarmFromState` `farm-runtime.ts:74-84` | `{...freshFarm(), burden:[], warehouse:[], farmland: 6×FarmlandS + 12×Wasteland}`（54-60） | `farmPlant` 依赖购买得到的种子（`burden`，合理）；`farmReclaim/Care/Harvest/Clear` 依赖用户已种作物（合理） | 结构默认值 + 用户命令写入 | `farm.buySeed → OK`；`farm.plant` 无种子 → `insufficient_item`；14 块地全部可取（`landAt` 162-169） | **E4** 安全 |
| `island` | `readIsland` `runtime-helpers.ts:316-345`（含 `newsFacts/newsDay` 形状校验 318-327） | 全字段默认（`day = floor(gameTime/1000)`）。另有死代码 `defaultIsland` 308-314 | 所有 island handler 经 `requireIslandReady` + `ensureIslandDay`（`island-runtime.ts:46-51,197-199`）→ `materializeIslandDay`（171-195） | `materializeIslandDay`：06:00 强制（`tick.ts:134`）+ 首次 island 命令懒生成 | `island.arriveScene` 后实测 `day=1794952800, want="102010003", errands=8`（自愈）；`island.turnInErrand` 未知 errand → `not_available`；`island.giftNpc` 有 want 但未持有 → `insufficient_item` | **E3** 安全；**C14** 观察（`tier` 默认 0 的多给变体） |
| `album` | `readAlbumShots` `album.ts:8-17` | `[]`（`undefined` / 解析失败 / 非数组都返回 `[]`） | 无命令要求已存在照片；`appendTravelPhoto` `album.ts:24-41` 只追加 | 旅行完成时写 | `travel.completeCollection`/旅行返回正常；`shot === null` 时只是没有明信片 | **E2** 安全 |
| `activity` | 无读取函数；`tick.ts:231` 仅做 `!== '0'` 的陈旧标记判断 | 写入 `'0'`（`runtime-helpers.ts:506-516`、`tick.ts:171,255`） | 无 | 活动命令 / tick 投影 | 只影响"是否需要把 activity 写回 0" | **E1** 安全（写-only） |

## 3. 非 blob canonical 字段矩阵

| 字段 | runtime 读取点 | 空档（如 `{}` / 缺键 / 缺元素）下的实测行为 | 生成者 | 判定 |
|---|---|---|---|---|
| `gameSaveDatas.travel_china` | `taskCount` `runtime-helpers.ts:277`；`counterValue` `runtime-tasks.ts:180`；`claimTaskReward` `handlers-c.ts:154`；`completeTravelCollection` `handlers-b.ts:284,288`；`visitProvince` `travel.ts:82-88` | **`TypeError: Cannot read properties of undefined (reading 'length')` → `internal`**（task.claim travel#2、travel.completeCollection 均命中） | 旅行返回 `visitProvince`；`completeTravelCollection` 清零 | **C02** |
| `gameSaveDatas.ddw` | `pokeFace` `handlers-a.ts:190`（`+= 1`） | `undefined + 1 = NaN` → 收尾 `assertEngineState` 失败 → `internal: $.save.gameSaveDatas.ddw must be a finite JSON number` | `pokeFace` | **C16**（并入 C02 的 S3 家族） |
| `gameSaveDatas.fishing_harvestfish / yyds` | `harvestAchievement` `fishing-runtime.ts:72-81`（`+ count`） | 缺键 → `NaN` → 收尾校验 `internal`（捕鱼收获路径） | 捕鱼收获 | C02 家族（低） |
| `studyInfo.<subject>` | `startWork` `handlers-c.ts:58-60`（`?? 0`，安全）；`startStudy` `:82-87`（`hasOwnProperty` 拒绝）；`startExam` `sessions.ts:214-219`；`submitExam` `:262-267`（**无 guard**）；`completeActivityJob` `tick.ts:162-166`（**无 guard，`+= 1`**） | `studyInfo:{}` → `job.startStudy` / `exam.start` = **`not_available/unknown study subject`**（文案误导）；tick 侧 `undefined += 1 → NaN → internal`（需键在会话期间丢失才可达） | 导入 / `emptyEggSave` / `repair`；正常只增不减 | **C05** |
| `selfGoodDatas.<group>` | `inventoryIndex` `runtime-helpers.ts:360-362`；`inventoryCount` 364-368；`addGood` 370-379；`takeGood` 381-390；`selfCare` `self-care.ts:17-28`；`inventoryTotal` `travel.ts:73-79`；`ownedGoodOfType` `island-runtime.ts:238-244`；`undefined` 分组 | **`TypeError: ... reading 'findIndex'` → `internal`**（`inventory.use`/`inventory.buy` 均命中）；组值非数组（`null`）同类 | 导入 / `emptyEggSave` / 购买赠送 | **C03** |
| `selfGoodUseOption.<type>` | `tickTimedGoods` `tick.ts:259-271`（`:261` 只判 `null`，**不判 `undefined`**） | **`TypeError: ... reading 'left'` → `advanceMinute` 返回 `internal`**（缺任一键即可）；server 侧表现为每分钟 `scheduler.tick_failed` | `startTimedGood` `runtime-helpers.ts:426-429`（只写被使用的那一类） | **C04**（最高危：全局 tick） |
| `activeOption.<kind>` | `isBusy` `runtime-helpers.ts:147-149`（`!== null`）；`cannotStartActivity` `handlers-c.ts:30-37`；`stopActivity` 133-135 | 缺 `trip`（其余为 null）→ `job.startWork` = **`not_available/busy`**；`activity.stop` 反而能"停止 trip"并把三键写成 null（自愈） | 导入 / `emptyEggSave` / 活动命令 | **C06** |
| `petComputedlInfo.*` | `applyGood` `runtime-helpers.ts:409-424`；`pokeFace` `handlers-a.ts:189`；`adminGrantCheat` `handlers-server.ts:79-88`；`dailyTaskNeeded` `runtime-tasks.ts:40-50`；`stageOf(level)` `island-runtime.ts:264`、`sessions.ts:98-99` | `{}` → `pet.pokeFace`/`pet.cheer` = **`internal: $.save.petInfo.mood must be a finite JSON number`**；`game.startSession` = `not_available/the pet is still an egg`（`stageOf(undefined)`）；`job.startWork` = **OK 并借机跳过等级门槛**；`toOutcome` 的 `recomputePetComputed` 会在任一成功命令后自愈 | `recomputePetComputed`（`runtime-helpers.ts:450-464`，每条命令收尾） | **C07**（首条命令窗口 + 等级门槛绕过） |
| `illustrated` | `addGood` `runtime-helpers.ts:372`（`.includes/.push`） | `illustrated:null` → **`TypeError: ... reading 'includes'` → `internal`**（任何买/赠/领奖） | `addGood` | **C08** |
| `settings.*` | `requireNotPaused` 143-145；`scaleYbForDifficulty` 466-468；`illnessTick` `tick.ts:316` | 导入强制校验（`assertSharedSettings`）→ 不存在空档 | — | **E10** 安全 |
| `scheduledJobs` / `gameSessions` / `sessionCoverage` / `environment` | `processDueJobs` `tick.ts:175-219`；`findSession` 518-520；`sessionActivityForInterval` `coverage.ts`；`resolveWeather` `tick.ts:55-62` | 导入强制结构校验（`assertEngineState`，`portable.ts:494-534`）→ 空数组合法、元素非法被拒 | 命令 / host / 导入 | **E6** 安全 |
| 在途活动（`activeOption.*` + `saveJsonData.activity`） | `syncActivityProjection` `tick.ts:221-257`（无 pending job 分支 227-235） | legacy 存档只有 `activeOption.work` + `activity:'30'`，迁移后 `scheduledJobs=[]` → **首个 tick 把 work 清空、activity 写 0，无奖励、无 Work 计数**（probe 实测） | 迁移（`portable.ts:672` 固定空 jobs） | **C13**（S3：静默丢数据） |

## 4. 导入 / 迁移归一化缺口（S3 总账）

| 位置 | 做了什么 | 没做什么 |
|---|---|---|
| `toSharedSaveData` `data-boundary.ts:216-229` | 过滤 blob → canonical 字符串；`assertSharedSaveData` | 不修复任何组/字段成员 |
| `assertSharedSaveData` `data-boundary.ts:358-380` | 要求 14 个顶层 key 存在（`:368`）；`saveJsonData` **只允许**已知键（`:375`），**不要求键存在**；每个 blob 先 canonical 再跑形状校验（`:376-379`）；`petInfo`/`settings` 严格校验 | **完全不校验** `petComputedlInfo`、`studyInfo`、`activeOption`、`selfGoodDatas`、`selfGoodUseOption`、`gameSaveDatas`、`illustrated`、`havePet/isBury/saveNum/nowTimeLine` 的类型与成员（`evidence.txt` §4：这些键在 `src/shared/sync` 中的全部出现只有 key 清单） |
| blob 校验器 `data-boundary.ts:649-875` | 逐字段校验"存在则形状正确" | 所有字段都是可选的（`assertTaskBlob` 668-691、`assertSigninBlob` 693-720、`assertPondBlob` 728-739、`assertFarmBlob` 770-794、`assertEmailBlob` 825-831、`assertAlbumBlob` 796-805、`assertIslandCanonical` 847-875）→ `{}`/`[]` 全部合法 |
| `backfillPortableBundleDefaults` `portable.ts:594-598` | 只调用 `backfillLegacySharedPetInfo`（`data-boundary.ts:242-254`）→ **只补 `petInfo.diamond`** | 不补 `saveJsonData` 任何 blob；不补各 groups；不物化任何"当日表" |
| `migrateLegacySaveDataToPortableBundle` `portable.ts:632-693` | 校验 anchor/authority/timezone；`scheduledJobs: []`（`:672`）；`environment` 空（`:680`） | 不跑 `save-logic.repair()`；不生成静态/每日任务表；不 materialize island/farm/pond |
| `migratePortablePetBundleV0` `portable.ts:695-730` | v0→v1 只补 engine 边界字段（`:714-717`） | 同上的数据缺口 |
| `server/src/portable-import.ts` | `planPortableImport`：authority 校验、anchor/clamp、daily-boundary 元数据归一（`:147-160,204-223`）、coverage/session 重绑 | 不读也不改 `save.saveJsonData`；不补 groups |
| `src/main/local-repository.ts:886-892` / `src/shared/local-repository/host.ts:1034-1061` | `migrateLegacySaveDataToPortableBundle(raw)` 产 bundle；**`startSave(raw)` 只用于生成 device overlay**（`lastX/lastY/设备 settings`） | 修复后的 `SaveData` 从未回写 bundle，bundle 依旧是 raw 的 canonical 版本 |
| `save-logic.ts:30-130 RULES` / `repair` 230-243 / `startSave` 253-262 | **本地加载路径**会逐字段修复 `petInfo/petComputedlInfo/studyInfo/activeOption/selfGoodDatas/selfGoodUseOption/gameSaveDatas/settings/illustrated` | 该修复只发生在"本地 `startSave`"，权威存档（bundle/engine/server）没有对应实现 → 同一份旧存档在本地模式没事，切到 server 模式就缺字段 |

实测（`evidence.txt` §1 末尾）：

```
bundle canonical studyInfo keys: chinese,mathematics,politics,music,art,manner,pe,labouring   ← 缺 wushu
bundle canonical selfGoodDatas keys: food,clean,medicine,background,service,work,study,trip,nums ← 缺 toy
bundle canonical gameSaveDatas: {"fishing_harvestfish":0,"travel_china_num":0,"ddw":0,"yyds":0}   ← 缺 travel_china
bundle canonical saveJsonData: {}
bundle petInfo.diamond backfilled: 3
bundle engine validates: true            ← 导入会接受
repaired save fields: studyInfo.wushu, selfGoodDatas.toy, gameSaveDatas.travel_china
```

## 5. 候选清单

### A 级（真实 fixture + 命令面复现）

#### C01 `task.claim` 的 `daily` 表仍然依赖 06:00 重置
- **机制**：与已修缺陷完全同型——命令要求 `taskList[tab][index]` 存在，而 `daily` 表只能由每日重置生成；修复只把"静态三表"改成按需补齐。
- **代码链**：`claimTaskReward` `handlers-c.ts:146-166` → `ensureStaticTaskLists` `:149`（`runtime-tasks.ts:143-158`，`STATIC_TASK_TABS = ['ddw','growth','travel']` `:136`）→ `taskDefinitionAt(progress,'daily',i)` 读 `progress.daily`（`runtime-tasks.ts:215-216`）→ `progress.taskList.daily[i]`（`handlers-c.ts:151`）→ 两者皆无 → `reject('not_available','unknown task')` `:152`。`daily` 表唯一生成者是 `resetDailyTasks` → `rollDailyTasks`（`runtime-tasks.ts:160-177` → `:64-108`）。
- **空档行为**：`task:'{}'` + `task.claim{tab:'daily',index:0}` → `not_available / unknown task`（probe 实测）。对照：真实跑一次 `resetDailyTasks` 后同 payload → `not_available / task is not complete`（定义已存在，只是计数不够）；再对照已修的静态表：poke 5 次后 `task.claim{tab:'ddw',index:0}` → **OK**。
- **为什么同类**：同命令、同拒绝码、同"只能由周期任务生成的条目"。当前唯一挡住用户可见故障的是 **UI 侧**：server 模式 `rollDaily`/`resetTasks` 直接 return（`renderer/pet/tasks.ts:246,182`），`tasks('daily')` 从服务端 blob 取到 `[]`（`:151`），面板不渲染条目 → 用户看到的是"今日任务空"，而不是"点了失败"。**功能上也仍然是缺陷**：导入/新领养后到下一个 06:00 没有今日任务。
- **动态验证**（repro-auditor）：`probe.mjs` 已含；另建议用真实 bundle 走 `planPortableImport` 后直接 `executeCommand(task.claim daily#0)`。

### B 级（导入校验实测放行 + 合成空档命中）

#### C02 `gameSaveDatas.travel_china` 缺失 → 同一命令 `internal`
- 链：`handlers-c.ts:154`（`save.gameSaveDatas.travel_china.length`）/ `travel.ts:82` / `handlers-b.ts:284` / `runtime-tasks.ts:180`。导入侧：`validateEngineState=true`（`assertSharedSaveData` 不校验 `gameSaveDatas`），迁移不补（§4）。
- 空档：`task.claim{tab:'travel',index:2}`、`travel.completeCollection` → `internal / Cannot read properties of undefined (reading 'length')`。
- 为什么同类：S3 来源 + "命令路径需要数组元素"；Travel2 计数是 `claimTaskReward` 内部唯一绕过 `doNums` 的分支。

#### C03 `selfGoodDatas` 分组缺失 → 全部库存命令 `internal`
- 链：`inventoryIndex` `runtime-helpers.ts:361` ← `inventoryCount`/`addGood`/`takeGood`；调用方 `handlers-b.ts:100`（use）、`:56`（buy）、`self-care.ts:17-28`、`travel.ts:73-79`、`island-runtime.ts:238-244`。
- 空档：`inventory.use{toy}` / `inventory.buy{food}` → `internal / reading 'findIndex'`。对照：分组存在时 buy → OK。
- 为什么同类：S3；且 `repair()` 明明会补组（`save-logic.ts:73-80`），权威端没有。

#### C04 `selfGoodUseOption` 缺键 → 每分钟 tick `internal`（世界停摆）
- 链：`tick.ts:259-271`（`:261` `if (timed === null) continue`，`undefined` 不匹配）→ `:263 timed.left` → TypeError；`advanceMinuteInPlace` `:416` 调用 `passiveMinute` → `tickTimedGoods`。server 侧：`RuntimeHost.advance` 抛错（`server/src/runtime-host.ts:57`），`scheduler.ts:166-169` 记 `scheduler.tick_failed` 并累计 `scheduler.errors`；catch-up 侧进 `catchUpFailures`（`server/src/scheduler.ts:143-144,254-256`）。
- 空档：`selfGoodUseOption:{}` 或 `{background:null,food:null,clean:null}`（缺 `toy`）→ `advanceMinute` = `internal / reading 'left'`。
- 为什么同类：S1——`readIsland`/`readPond` 都会补默认，唯独这里假设四键齐全；S3——导入不补。

#### C05 `studyInfo` 缺科目
- 链：`handlers-c.ts:82-87`、`sessions.ts:214-219`（hasOwnProperty → `unknown study subject`）；`sessions.ts:262-267`、`tick.ts:162-166`（无 guard，`+=1` → NaN → 收尾 `internal`）。
- 空档：`studyInfo:{}` → `job.startStudy{xx-chinese}` = `not_available/unknown study subject`；`exam.start` 同。对照：`studyInfo.chinese=1`（低于 9 节）→ **OK**。
- 为什么同类：S3；且拒绝文案把"字段缺失"伪装成"课程不存在"，与已修缺陷的 `unknown task` 同一类误导。

#### C06 `activeOption` 缺键 → 恒 `busy`
- 链：`isBusy` `runtime-helpers.ts:148`（`undefined !== null` → true）→ `cannotStartActivity` `handlers-c.ts:35` → `rejectActivityBlocker('busy')` `:42`。影响 `job.*`、`activity`（`game.startSession` 的 `requirePlayable` `sessions.ts:100` 也会 busy）。
- 空档：缺 `trip` → `job.startWork` = `not_available/busy`；`activity.stop` 反而成功并返回 `stopped:"trip"`（自愈，但向用户报告了一个从未进行的活动）。
- 为什么同类：S3 + "缺键被当成业务状态"。

#### C07 `petComputedlInfo` 缺键 → 首条命令 NaN / `stageOf(undefined)` 蛋
- 链：`applyGood` 413-415、`pokeFace` `handlers-a.ts:189`、`handlers-server.ts:79-88`、`runtime-tasks.ts:40-50`、`stageOf` `island-runtime.ts:264`/`sessions.ts:98-99`。
- 空档：`{}` → `pokeFace/cheer` = `internal (.mood finite)`；`game.startSession` = `not_available/the pet is still an egg`；`job.startWork` = **OK**（`needLevel > undefined` 为 false，等级门槛被绕过），且成功后 `toOutcome` 的 `recomputePetComputed`（`runtime.ts:144`）自愈整条结构。
- 为什么同类：S3；读取点假设"已归一化"，而 runtime 自己有 `levelAndCapsOf` 可兜底。

#### C08 `illustrated` 非数组（`null`）→ 购买/赠礼/领奖 `internal`
- 链：`addGood` `runtime-helpers.ts:372`。空档实测 `illustrated:null` → `internal / reading 'includes'`。
- 为什么同类：S3；`assertSharedSaveData` 只要求键存在，`repair()` 只处理 `??= []`（null 会被修成 []，权威端没修）。

#### C09 `fishs.PD.canusecnt` 只由重置/首次买粉钻生成
- 链：`resetFishLimits` `handlers-b.ts:214-219`（06:00 `tick.ts:126`；首次买粉钻 `:236`）→ `fishingSpeedUp` `fishing-runtime.ts:166`。
- 空档：粉钻用户 + `fishs:'{}'` → `fishing.speedUp` = `not_available/no pink-diamond speed-ups remain`；`resetFishLimits` 后（6 次）→ 有鱼时 **OK**。
- 为什么同类：与已修缺陷同型（计数型条目"只能由周期任务/特定购买生成"，命令依赖其存在），只是文案不误导。

#### C10 迁移丢在途活动（静默）
- 链：`portable.ts:672 scheduledJobs: []` → 首个 tick `syncActivityProjection` `tick.ts:227-235`（无 pending job → 清空 `work/study/trip`、`activity` 写 0）；legacy 存档的在途状态只存在于 `activeOption` + `saveJsonData.activity`（`SaveData` 无 jobs 字段）。
- 实测：`activeOption.work="bz"`、`activity:"30"`、0 jobs；一 tick 后 `work=null`、`activity="0"`、`task.doNums={}`、事件仅 `pet.statsChanged`。
- 为什么同类：S3（迁移产生"有状态、无 companion 条目"的存档）；不是拒绝，而是静默丢奖励。

### 观察 / 变体（同机制，但当前不是"点击失败"或方向相反）

| 编号 | 内容 | 判定理由 |
|---|---|---|
| C11 | `email` 空 → `claimMail/claimAllMail` 拒绝；欢迎信要等 06:00 | 新存档本无邮件，UI 也不展示条目；拒绝语义正确。列此避免被当作新缺陷 |
| C12 | `readSignIn` 默认 `getBirthDayGift:true` → 生日礼物被判"已领"；同时空档允许重复签到/重复抽成长 | 客户端 `renderer/pet/signin.ts:37` 同默认、`ui/signin.ts:268` 据此隐藏按钮 → 界面一致，无"点击失败"；属语义风险 + 多给变体 |
| C13 | `task.claim` 不校验 `dailyDay`/当天：携带昨日 `daily` 表的 bundle 可在新一天补领 | 过期条目可领（多给方向）；根因同为"命令路径不校验周期性生成的时间归属" |
| C14 | `island.tier` 默认 0 → 高等级导入可一次性补领历史层级奖励（`200×count` 元宝 + loot） | 多给方向；`islandClaimGrowthReward` `island-runtime.ts:397-410`。需 repro 评估能否通过重复导入（epoch 递增）重复获利 |
| C15 | `daily` 定义存在但 `taskList.daily` 为空（partial blob）→ 同样 `unknown task` | `assertTaskBlob` 不要求 `daily` 与 `taskList.daily` 等长/配对；任何部分写入/截断都会复现 C01 的拒绝码 |

## 6. 已排除清单（不要重复排查）

| 编号 | 对象 | 为什么安全 |
|---|---|---|
| E1 | `saveJsonData.activity` | runtime 内只写不读（`writeSharedBlob`/`tick.ts:231` 的 `!== '0'` 判断），没有命令依赖条目 |
| E2 | `saveJsonData.album` | `readAlbumShots` 对 `undefined`/坏 JSON/非数组统一 `[]`；`appendTravelPhoto` 只追加，`shot===null` 只是没有明信片 |
| E3 | `saveJsonData.island` 主体 | 06:00 强制物化（`tick.ts:134`）+ 首次 island 命令懒物化（`island-runtime.ts:171-199`），实测空 blob 后 `arriveScene` 立即产出 8 条 errands/want；`readIsland` 对 `newsFacts/newsDay` 还有形状拒绝（316-327），不会越界 |
| E4 | `saveJsonData.farm` | `freshFarm()` 提供 14 块地、rank/experience 默认；`readFarmFromState` 对 `burden/warehouse/farmland` 分别兜底；实测 `{}` 下 buySeed/plant/reclaim 均可走 |
| E5 | `saveJsonData.fishs` 主体 | `readPond` 兜底 `PD/fishs`；`fishingBuy` 自愈（probe OK）；feed/harvest 依赖用户自己的鱼属合理拒绝 |
| E6 | `scheduledJobs`/`gameSessions`/`sessionCoverage`/`environment` | `assertEngineState`（`portable.ts:494-534`）逐元素强校验，空数组合法、元素非法在导入即拒 |
| E7 | `readSharedBlob` 对 `'null'`/`'[]'` 等类型不匹配原样返回（会导致 `.newsFacts`/`.doNums` 取属性抛错） | 导入前 `assertCanonicalSaveJsonBlob` 会按 blob 类型拒绝（`data-boundary.ts:916-938`），且全部写入走 canonical writer；只有外部篡改本地文件才可达 |
| E8 | island quiz/errand 跨日索引漂移（`sessions.ts:346-363` 的 identity 校验） | 不是空档问题，是"数组下标当身份"的设计；跨 06:00 或重物化时确实会拒绝，但与本次机制无关，仅提示 repro 观察 |
| E9 | `completeTravelCollection` 对 `taskList.travel.slice(2)` 重置 `take`（`handlers-b.ts:289-291`）在表未物化时静默空操作 | 同一 handler 已把 `travel_china` 清零（`:284-288`），计数归零后无法重复领奖；只是"静默空操作"，不构成可获利缺陷 |
| E10 | `settings.*`、`petInfo.*` | `assertPetInfo`/`assertSharedSettings` 严格校验（`data-boundary.ts:271-296`），缺字段会在导入被拒 |

## 7. 测试覆盖对照

| 路径 | 现有覆盖 | 与候选的重合 |
|---|---|---|
| 静态任务表按需物化 | `scripts/tests/pet-runtime-c3.test.mjs:347-390`（修复新增：空 `task` + poke 5 次 → ddw claim 成功；部分表保留；reroll 长度） | 正是 C01 的修复面；**没有** daily 表用例 |
| `daily` 领取 | `pet-runtime-c3.test.mjs:324-345`（手工塞好 `daily` + `taskList.daily` 再领；未达成 → `not_available`） | 只覆盖"已存在条目"的正常态，**未覆盖** C01/C15 的空档 |
| 06:00 边界重置 | `scripts/tests/pet-runtime-c4b.test.mjs:288-296`；`server/test/scheduler.test.ts:362-403,1292-1308` | 证明重置会生成 `dailyDay`/island.day；**未**断言"重置前命令面" |
| signin 礼物 | `pet-runtime-c3.test.mjs:435-455`（显式 `getBirthDayGift:false` / `isOnlineLastTime:0`）；`:488-549`（边界与 session clock） | **未覆盖**默认 `true`/20 的拒绝路径（C12） |
| island | `pet-runtime-c4a.test.mjs:258-336`（fixture 已物化）、`:744-779`（daily roll 6+2）、`:780-830`（news） | 覆盖懒物化的正常态（E3）；**未覆盖** `tier` 默认 0 的多给（C14） |
| fishing | `pet-runtime-c4a.test.mjs:337-378`（buy/feed/harvest/speedUp，pond 已带 PD 计数） | **未覆盖** `PD.canusecnt` 缺失（C09） |
| farm | `pet-runtime-c4a.test.mjs:379-435,436-486`（空 farm blob 起步、肥料包） | 覆盖 E4；**未覆盖**分组缺失 |
| server 命令面 | `server/test/server.test.ts` 中 **无** task/island/farm/fish/signin/mail 相关断言（`grep` 无匹配） | C01–C10 均无 server 端回归测试 |
| 导入/迁移归一化 | `scripts/tests/sync-data-boundary.test.mjs`（blob 形状、禁止字段）、`server/test/scheduler.test.ts:731-798`（daily-boundary 元数据） | **未覆盖**"非 blob 组缺失"与"迁移后命令面"（C02–C10 全空） |

## 8. 给 repro-auditor 的动态验证清单

优先级从高到低；所有命令都在 `src/shared/pet-runtime` 真实入口上执行（`executeCommand` / `advanceMinute` / `planPortableImport`），不修改 `src/`。

```text
# 0) 基线（已修缺陷）——应通过
fixture(imported-shared.json) → pokeFace ×5 → task.claim{tab:'ddw',index:0}           期望 OK
fixture                          → task.claim{tab:'daily',index:0}                     期望 not_available/unknown task   ← C01

# 1) C01/C15：daily 表
fixture + reject 白天导入 → planPortableImport → task.claim{tab:'daily',index:0}
真实 06:00 reset 后再 claim                                         对照：not_available/task is not complete

# 2) C02：travel_china（用旧存档或截断字段构造，须先证明 validateEngineState=true）
save.gameSaveDatas 去掉 travel_china → task.claim{tab:'travel',index:2}
                                  → travel.completeCollection
期望 internal/Cannot read ... 'length'；对照：补回 [] 后 → not_available/not every province...

# 3) C04：selfGoodUseOption（最高危，测每分钟 tick）
save.selfGoodUseOption={} → advanceMinute()
期望 internal/... 'left'；server 侧观察 scheduler.errors / 世界时间是否停滞
对照：四键齐全 → ok:true

# 4) C03/C08：selfGoodDatas / illustrated
去掉 selfGoodDatas.toy → inventory.use{toy,t0002}         期望 internal/'findIndex'
illustrated=null        → inventory.buy{food,102010001}   期望 internal/'includes'

# 5) C05/C06/C07：studyInfo / activeOption / petComputedlInfo
studyInfo={} → job.startStudy{xx-chinese}、exam.start{xx-chinese}
activeOption={work:null,study:null,ill:null,die:null} → job.startWork{bz}，再 activity.stop
petComputedlInfo={} → pet.cheer、game.startSession、job.startWork{bz}

# 6) C09：粉钻 + 空 pond
petInfo.pinkDiamond=true, PDiamondLevel=3, fishs='{}' → fishing.speedUp
对照：resetFishLimits → fishing.buy → fishing.speedUp 期望 OK

# 7) C10：legacy 在途活动
legacy save.json: activeOption.work='bz', saveJsonData.activity='30'
→ migrateLegacySaveDataToPortableBundle → advanceMinute()：观察 activeOption 被清空、无奖励

# 8) C12/C13/C14（多给方向，评估可重复性）
signin='{}' → signin.sign ×2、signin.drawGrowth ×2
bundle 带昨日 daily 表 → 次日 claim daily
高等级 + island='{}' → island.claimGrowthReward（重复导入能否重复获利）
```

配套脚本：本目录 `probe.mjs` 已覆盖 0–7 的主要分支与对照（输出在 `evidence.txt` §1），可直接改造为真实 bundle 版本。

## 9. 修复建议（根因，供 lead 决策）

1. **一次性归一化，而不是逐 handler 打补丁**：在 `toSharedSaveData`/`planPortableImport`/本地 `importPortableBundle` 之后加一个 canonical `normalizeSharedSave(save)`，复用 `save-logic.ts` 的 `RULES` 语义补齐 `studyInfo/selfGoodDatas/selfGoodUseOption/gameSaveDatas/activeOption/illustrated/petComputedlInfo`，并补 `saveJsonData` 缺失键（`email/task/signin/fishs/farm/activity/album/island` 的 canonical 空值）。
2. **"当日表"在导入/领养时物化**：`ensureStaticTaskLists` 之外，补 `ensureDailyTasksForCurrentDay`（`dailyDay !== currentBoundarySeconds` 时 roll）与 `ensureIslandDay`/`resetFishLimits` 的按需调用；或者在 import 计划里直接跑一次幂等的"当前日边界物化"。
3. **读取侧统一兜底**：`tickTimedGoods` 改 `timed === null || timed === undefined`；`isBusy` 用 `typeof x === 'string'`；`inventoryIndex` 用 `(save.selfGoodDatas[type] ?? [])`；`travel_china` 读取统一 `?? []`；`petComputedlInfo` 读取前先 `recomputePetComputed`。
4. **schema 兜底**：给 `assertSharedSaveData` 增加非 blob 组的最小形状校验（至少类型：对象/数组），让"导入一份缺组的存档"在导入阶段显式报错，而不是在运行期变成 `internal`。

## 10. 证据索引

- `evidence.txt` §0 仓库状态 / §1 `probe.mjs` 全量输出（含正常态对照）/ §2 blob 读者源码 / §3 blob 校验器 / §4 非 blob 组无校验 / §5 迁移只补 diamond / §6 import 计划 / §7 本地 repair / §8 runtime 依赖点 / §9 测试覆盖 / §10 死代码兜底 / §11 无启动期物化。
- `probe.mjs`：内存构造，不写盘；`evidence.sh`：一条命令重生成证据。
- 真实锚点：`audit/similar-errors/fixtures/imported-shared.json`（`saveJsonData` 中 `task/email/farm/fishs/island` 均为空，`signin` 有值）。
