# 渲染层「本地默认/本地推测」vs 权威 runtime · 静态审计报告

> **状态更新**：本报告的候选已由 lead 在修复轮（tree-1a9c90046b7b89a6）处理，F1–F6 的修复与验收见 [../../report.md §4](../../report.md)。

> 审计员：ui-auditor ｜ 写作用域：`audit/similar-errors/findings/ui-divergence/`
> 基准：`audit/similar-errors/README.md`（S1/S2/S3 判定 + 证据门槛）
> 性质：**只做静态审计**；未修改 `src/`、`scripts/`、`server/` 任何已跟踪文件；未跑全量测试。
> 模式定义：`runtimeProjectionMode = window.__qqpetRuntimeV2 === true`（`src/renderer/pet/store.ts:23`），即 server 模式与 local-v2 投影模式的共同渲染路径；权威端分别在 `server/` 与 `src/shared/pet-runtime/`（同一套 handler）。

---

## 0. 结论摘要

| 项 | 数量 |
|---|---|
| 高度可疑候选（主表，S2 / S2′） | **12**（UD-01…UD-12） |
| 已排除（只读投影，判定源=权威值） | **14**（E-01…E-14） |
| 边界/潜伏（当前不可达或无差异，但缺守卫） | **9**（L-01…L-09） |
| 次要类别：本地写入口未迁移（W-xx 独立小节） | **13** |

**最可疑的 3 条**

1. **UD-01** 任务奖励内容：`tasks.ts` 的 `load()` 在模块加载时就用 `Math.random` 抽查并补齐静态任务表，UI 显示的是本地随机奖励，权威端首次领奖才用 runtime RNG 生成另一组 → 图标与实发不一致（与本次修复同根：**奖励内容**是本地推测，**计数**才是权威值）。
2. **UD-06** 看病：runtime 分支弹窗只报 `(5-health)*10` 的诊疗费，服务端还额外扣 `售价×1.2` 的药费——**界面金额 ≠ 实际扣费**（死亡状态下更是无任何报价直接扣钱）。
3. **UD-05** 商城：`buy()` 在 projection 模式恒返回 `true`，购物车结算据此清空购物车并道谢，但服务端逐条 `payYb` 可能拒绝（余额、等级、粉钻、下架）→ **假成功 + 部分成交**。

### 0.1 对 lead 两个特别确认点的答复

**(1) legacy `cheatSection` / `sweetSection` 的直接写入，在 server 模式是否确实不可达？——是，两道闸门都在，且都只作用在「渲染哪个表单」这一层：**

| 闸门 | 证据 | 效果 |
|---|---|---|
| 设置页的 tab 渲染切换 | `ui/setup.ts:485` `render: (redraw) => (runtimeProjectionMode ? runtimeSweetSection() : sweetSection(redraw))`；`ui/setup.ts:523` `runtimeProjectionMode ? CHEAT_OPTIONS.map(...) : cheatSection(redraw)` | projection 模式下 `sweetSection`/`cheatSection` **根本不会执行**，返回的是命令驱动的最小页（`runtimeSweetSection`，`setup.ts:339-347`）与 `CHEAT_OPTIONS`（`:349-382`） |
| 唯一导入方 | `ui/setup.ts:24` 是 `setup-sections.ts` 的**唯一**导入点（`grep -rn setup-sections src/renderer` 仅此一处）；`openSetup` 只挂在该面板 | 没有任何旁路入口能渲染这两个 section |
| 作弊页入口 | `ui/setup.ts:593` `TABS.filter((t) => t.label !== '作弊' || s.cheatTab)`（需 5 连点版本号） | 即便打开，渲染的也是 `CHEAT_OPTIONS`，不是 `cheatSection` |

结论：`setFrozen` / `skipTime` / `setCustody` / `setCare` / `clearCareLog` / 点亮省份 / `undying` 直写，在当前代码下**均不可达**（详见 §4 W-01…W-11，含每条的写函数与抛错判定）。它们是**缺自身守卫的潜伏点**：一旦这些 section 被重新挂回 runtime 入口（或新增调用方），会立刻变成「点击无反应 + 控制台 `CanonicalMutationBlockedError`」。
另外两点补充：
- `skipTime()` 即便被调到也**不会抛**：projection 模式从不启动 `tick()`（`main.ts:543-551` → `beginProjection`），`lastTick` 恒为 `null`，`pet/pet.ts:379` 直接 return → 静默无操作（但 UI 文案仍会说「时间过去了 N 小时」）。
- `payDiamond()`（`pet/items.ts:25-32`）**没有** projection 守卫（对比 `pay()` 在 `:14-15` 有），当前调用方都在不可达分支，属同类潜伏不一致。

**(2) 任务 reroll 奖励图标用本地 `loot` 伪造的严重度：中（内容层），但结构风险高。**

- **不会造成拒绝**：可领性（`take`、`doNums`、`travel_china.length`）全部来自投影，`ui/task.ts:18` 与服务端 `handlers-c.ts:153-155` 同规则；因此点击**不再**出现「unknown task」。
- **会造成「界面 ≠ 实发」**：列表图标来自 `tasks.ts:126` 的本地 `rewards()`（`loot(reroll)`，Math.random），实发来自 `handlers-c.ts:158` 的权威 `entry.good`（runtime RNG）。点击后 `showResult` 用的是**命令结果**（`claimRuntime` → `commandResultGoods`，`tasks.ts:174-178` + `runtime-command.ts:68-93`），所以用户会当场看到「图标 A、弹窗 B」。
- **经济无害、信任有害**：数量（`reroll` 个数）两边一致、池子同一份 `pool.json`，只错在具体物品/稀有度；如果本地抽到史诗而权威给稀有，观感上等同「假奖励」。
- **额外结构风险（待 blob-auditor 确认）**：若导入的 `task` blob 形如 `taskList.ddw[0] = {}`（条目存在但缺 `good`），`load()` 的 `entry()` 会产出 `{take:false, good: undefined}`（`tasks.ts:126`）→ `ui/task.ts:43` 的 `t.good.map` 抛 `TypeError`，活动列表直接渲染不出来；同状态下服务端 `grantGoods(save, undefined)`（`handlers-c.ts:158` + `runtime-helpers.ts:392-395`）也会抛 → 可能落成 `internal`。README §6 的真实 fixture `task` 为空，不触发；「条目存在但缺 `good`」的存档尚未确认，标**待验证**（验证方法：构造 `{"taskList":{"ddw":[{}]}}` 的 blob，打开活动列表 + 领奖各一次）。
- **收敛条件**：只要 `ensureStaticTaskLists` 在**启动/投影前**就把静态表补齐（而不是等第一次领奖），本地预览与权威条目就同源；否则每次导入/切换的「当日首次领奖前」都会重现。这条建议交给 lead 在修复阶段决定。


---

## 1. 判定模型（本报告怎么区分「属于/不属于 S2」）

对每一条路径取三元组：

- **A（客户端判定源）**：渲染层用来决定「按钮可点 / 可领 / 可买 / 数量多少」的值与规则；
- **C（命令）**：`runtimeProjectionMode` 分支发出的 `PetCommand`（`src/renderer/pet/command-map.ts`）；
- **B（权威校验）**：对应 handler 的前置条件与授予逻辑（`src/shared/pet-runtime/handlers-*.ts`、`sessions.ts`、`farm-runtime.ts`、`fishing-runtime.ts`、`island-runtime.ts`、`runtime-tasks.ts`）。

分类：

| 分类 | 含义 | 与本缺陷的关系 |
|---|---|---|
| **S2** | A 使用**本地默认值 / 本地随机 / 本地时钟推断**，权威端在该数据状态下会拒绝或给出不同结果 | 同症状同根（README §2 S2） |
| **S2′** | A 完全来自投影（或根本没判定），但缺了 B 的某条前置条件 → 点击即拒。**按钮可点性是本地「未禁用」的猜测**，但判定源不是本地默认值 | 同症状、不同根；本次一并列出（任务要求的 A/B 前置条件一致性） |
| **S1** | 权威端自身从空 blob 回退 | 属 blob-auditor，本报告只在交叉处引用 |
| 非缺陷 | A=B 或只读投影 | 见 §3 已排除 |

> 注意：`update()` 在 projection 模式会抛 `CanonicalMutationBlockedError`（`src/renderer/pet/store.ts:207-218` + `src/shared/renderer-projection.ts:262-267`）。任何 **当前仍可达** 的 canonical 本地写都会让「点击后没反应/控制台异常」，是同根的第二种表现。这一面单列在 §4「次要类别」，按要求**不与 S1/S2 主表混淆**。

---

## 2. 主表 · 高度可疑候选

### 2.1 汇总表

| 编号 | 主题 | UI 入口（文件:行） | A 判定依据 | 命令 → handler | 分类 | 严重度 |
|---|---|---|---|---|---|---|
| UD-01 | 任务奖励内容本地随机 | `src/renderer/pet/tasks.ts:121,123-134,151`；`src/renderer/ui/task.ts:43` | `load()` 里 `rewards()`→`loot()`（Math.random） | `task.claim` → `handlers-c.ts:146-166` | **S2** | 中（内容层）／结构风险高 |
| UD-02 | 命令回执不落本地缓存 → 重复提交被拒 | `ui/task.ts:28-32`；`ui/email.ts:41-45`；`ui/signin.ts:119-127` | 成功后立即 `render()`，读的仍是旧 blob | `task.claim` / `mail.claim` / `signin.sign` | **S2** | 中（server 模式） |
| UD-03 | 「今天」= 本地 06:00 + 本地时区 | `ui/signin.ts:61-75,245-247`；`pet/signin.ts:47-51`；`pet/vip.ts:11-16` | `dayStart()`/`new Date()` | `signin.sign` → `handlers-d.ts:33-40` | **S2** | 中 |
| UD-04 | 在线礼包不校验元宝 | `ui/signin.ts:184-205`；`pet/signin.ts:91` | `giftCost()` 本地算，未比 `info.yb` | `signin.claimOnlineGift` → `handlers-d.ts:88-101` | **S2** | 中 |
| UD-05 | 商城购买恒成功 + 购物车清空 | `pet/items.ts:206-213`；`ui/shop.ts:303-313,337-349` | `buy()` 让位给异步命令但**恒返回 true** | `inventory.buy` → `handlers-b.ts:46-61` | **S2** | 高 |
| UD-06 | 看病报价不含药费 | `pet/items.ts:229-250` | 本地算 `(5-health)*10` 并当总价展示 | `medical.treat` → `handlers-b.ts:157-199` | **S2** | 高 |
| UD-07 | 农场施肥/高级种子永远可点 | `ui/farm.ts:120-131,161-173` | 只渲染库存与等级，不做可执行判定 | `farm.care` / `farm.buySeed` → `farm-runtime.ts:301-309,346` | S2′ | 中 |
| UD-08 | 池塘投放数量被静默 clamp | `ui/fishing.ts:85-108` | 本地 `pondRoom()` 算空位并让用户选 N | `fishing.buy` → `fishing-runtime.ts:91-116` | **S2** | 中 |
| UD-09 | 企鹅岛「刷新新闻」dayKey 本地推断 | `ui/island-runtime.ts:191-193,228-231` | `currentProjectionView()`，缺省 `UTC`+`Date.now()` | `island.refreshNews` → `island-runtime.ts:497-500` | **S2** | 低 |
| UD-10 | 旅游：忙/元宝未判定 | `ui/travel.ts:37-55,88-110` | 只看 `activity('trip')` | `job.startTravel` / `travel.completeCollection` | S2′ | 中 |
| UD-11 | 小游戏启动未判定 paused/授权 | `ui/smallgame.ts:239-249,251-262` | `stage()`/`busy()` | `game.startSession` → `sessions.ts:95-101,104-110` | S2′ | 中 |
| UD-12 | 暂停成长态下活动入口全可点 | `ui/farm.ts:149-173`；`ui/fishing.ts:77-128`；`ui/island-runtime.ts:260-355` | 无 `save.settings.paused` 判定 | 多个 handler 的 `requireFarmReady`/`requirePondReady`/`requireIslandReady` | S2′ | 中 |

---

### 2.2 逐条详述

#### UD-01 任务奖励内容：本地随机 vs 权威随机（**S2，最高优先**）

**UI 入口**
- `src/renderer/pet/tasks.ts:136` `let progress = load()` —— 模块导入即执行；
- `src/renderer/pet/tasks.ts:121` `const rewards = (t: Task): Good[] => [...(t.reroll ? loot(t.reroll) : []), ...(t.good ?? []).map(parseGood)]`；
- `src/renderer/pet/tasks.ts:126-133` `entry()` / `list()`：blob 里没有该 tab 的第 i 项时 → `{ take:false, good: rewards(t) }`（**本地抽**）；
- `src/renderer/pet/tasks.ts:151` `tasks()` 把 `progress.taskList[tab][i]` 摊进返回值；
- `src/renderer/ui/task.ts:43` 用 `t.good.map(...)` 画奖励图标；`:24` 「领取奖励」。

**A 的随机源**：`src/renderer/pet/loot.ts:7-19`（`Math.random()` 选池、选条目）经 `rand.ts`。

**C**：`src/renderer/pet/tasks.ts:174-178` `claimRuntime()` → `uiCommands.claimTask(tab,i)`（`command-map.ts:35-36`）。

**B**：`src/shared/pet-runtime/handlers-c.ts:146-166`

```ts
export function claimTaskReward(context, payload) {
  requireLivingPet(context.state)
  const save = context.state.save
  const progress = ensureStaticTaskLists(save, context.rng)      // ← 修复点：先补齐静态表
  const definition = taskDefinitionAt(progress, payload.tab, payload.index)
  const entry = progress.taskList[payload.tab][payload.index]
  if (definition === undefined || entry === undefined) reject('not_available', 'unknown task')
  ...
  grantGoods(save, entry.good)                                    // ← 发的永远是权威 entry
```

`ensureStaticTaskLists` / `buildResetStaticTaskLists` 用 **runtime RNG** 生成：

```ts
// runtime-tasks.ts:19-23
function rewardGoods(template, rng) {
  const fixed = (template.good ?? []).map(parseGoodCode)...
  const random = template.reroll ? lootGoods(rng, template.reroll) : []
  return [...random, ...fixed]
}
// runtime-tasks.ts:143-158 ensureStaticTaskLists → templates.map(... entryFor(template, rng))
```

**差异**：同一 reroll 模板（当前 `ddw[3]`、`ddw[4]`、`growth[1]`、`growth[3]`、`travel[1]`，见证据 A）两边都抽 `reroll` 个物品、池子都是 `content/pool.json`（与 `renderer/pet/data/pool.json` 逐字节相同），但**抽样结果是两条独立随机序列**。UI 在首次领奖/重置之前展示的图标，与点击后 `commandResultGoods` 实际弹出的奖励几乎必然不同。

**为什么属于 S2**：A 的「奖励是什么」是**本地随机推测**；权威端在完全相同的 blob 状态下由 `entry.good` 决定。与本次修复的根因同构——修复只解决了「条目不存在→拒绝」，没有解决「条目内容本地猜测→展示不符」。修复后该窗口缩短为「首次领奖/06:00 重置之前」，但**并未消失**（每次导入/切换后、当日首次领奖前均存在）。

**建议动态验证**：导入 `fixtures/imported-shared.json`（`task` 为空）→ 打开活动列表截图奖励图标 → 点击领奖 → 比对 `settle`：`taskList.ddw[i].good` 与截图是否一致；重复 3 次统计不一致率。或在 `loot()` 打点，记录本地抽取的 `id`，与服务端 `entry.good` 对比。

---

#### UD-02 命令回执不落本地缓存 → 重复提交被拒（**S2，server 模式为主**）

**UI 入口 / 现象**
- `src/renderer/ui/task.ts:27-33`：`claimRuntime(...).then(() => { render(); showResult(...) })` —— `render()` 立刻重读 `tasks()`，而 `progress` 只在**投影到达后**才被 `registerProjectionCacheInvalidator('tasks', …)`（`tasks.ts:137`）重建；
- `src/renderer/ui/email.ts:41-45`：领取后 `setTimeout(render, 0)`，`live()` 仍读旧 `saveJsonData.email`（`email.ts:27`）；
- `src/renderer/ui/signin.ts:119-127`：`refresh()` 读旧 `signin` 缓存，`signBtn` 的 `disable` 与点击前的 `signedToday()` 守卫（`:118`）都还是旧值。

**C**：`task.claim` / `mail.claim` / `signin.sign`。每次点击都由主进程新生成 opId（`src/main/renderer-runtime.ts:238-241`，`remote-repository.ts:487-491`），**同一按钮的第二次点击不会被幂等去重**。

**B**：
- `handlers-c.ts:153` `if (entry.take) reject('already_claimed', 'task reward has already been claimed')`；
- `handlers-d.ts:148` `if (mail.r === true) reject('already_claimed', ...)`；
- `handlers-d.ts:39` `if (days.includes(today.timestamp)) reject('already_claimed', ...)`；
- server 模式还多一条：`remote-repository.ts:492-497`

```ts
if (this.projectionRefreshPending) return this.rejected(command, opId, 'server_catching_up', ...)
if (this.pendingCommand !== null)    return this.rejected(command, opId, 'busy', 'another command is already in flight')
```

**差异**：在**投影到达之前**（server 模式 = 一次网络往返；local-v2 模式投影在命令返回前已 `emitProjection()`，见 `src/main/local-repository.ts:813`，窗口很窄）用户第二次点击 → `already_claimed`（错误弹窗「已经领取过了」）或 `busy`（「宠物正忙」）。

**为什么属于 S2**：可操作性来自**未被权威确认的本地缓存**，而不是投影。这是本次缺陷的「时序版」：修复前是「条目根本不存在」，修复后（server 模式）仍有「条目已变、界面未变」的窗口。

**建议动态验证**：server 模式，弱网（`tc qdisc`/代理延迟 300ms+）下对同一任务连点两次；断言第二次返回 `already_claimed`，且第一次投影到达后按钮变为「✓ 已领取」。对照 local-v2 模式同操作（应几乎不可复现）。

---

#### UD-03 签到「今天」由本地时钟+本地时区决定（**S2**）

**UI 入口**
- `src/renderer/ui/signin.ts:247` `signBtn.classList.toggle('disable', signedToday())`；`:118` 点击守卫 `if (signedToday()) return`；
- `src/renderer/ui/signin.ts:61-75` 月历 `const today = dayStart()`、`:71` `t === today && 'nowDay'`；
- `src/renderer/pet/signin.ts:47-51`

```ts
export function signedToday(): boolean {
  const today = dayStart()
  const d = new Date(today * 1000)
  return monthSigns(d.getFullYear(), d.getMonth() + 1).includes(today)
}
```

`dayStart()`（`src/renderer/pet/vip.ts:11-16`）用 `Date.now()` + **渲染进程本地时区**的 06:00 边界。

**B**：`handlers-d.ts:33-40` → `signedTimestamp()`（`:27-31`）→ `currentBoundarySeconds(context.ctx.gameTimeMs, context.state.timeZone)`（`runtime-helpers.ts:545-548`），`timeZone` 来源：local-v2 = 桌面进程 `Intl` 解析（`src/main/renderer-runtime.ts:90`），**server 模式 = `snapshot.settings.timeZone`（`server/src/config.ts:81`：`--time-zone` / `QQPET_SYNC_TIME_ZONE` / 服务器机器时区）**。

**差异**：当权威时区 ≠ 客户端时区（远程服务器在别的时区，或运维显式配了 `QQPET_SYNC_TIME_ZONE`），06:00 边界与「本月的第几天」都可能错开一天：
- 客户端认为「未签到」→ 按钮可点 → 服务端 `already_claimed`（`:39`）；
- 反向：客户端认为「已签到」→ 按钮置灰 → 服务端其实可以签（少领一次）。

**为什么属于 S2**：A 用本地时钟/时区**推测**了权威的「今日」，而投影里其实带着权威 `gameTimeMs/timeZone`（`store.ts:164` `currentViewState`），渲染层没用。

**建议动态验证**：server 模式把服务端 `QQPET_SYNC_TIME_ZONE` 设为与客户端不同的时区（如客户端 Asia/Shanghai、服务端 UTC），在本地 06:00–14:00 之间打开签到页，观察 `disable` 与服务端返回。

---

#### UD-04 在线礼包：报价与可领性都不看元宝（**S2**）

**UI 入口**：`src/renderer/ui/signin.ts:184-205`

```ts
if (signin.isOnlineLastTime > 0) return                     // 只判倒计时（权威值，OK）
...
const runtimeCost = giftCost()                              // onlineGiftNum*100（本地解析的权威 blob，OK）
if (runtimeCost === 0) return claim()
windowView({ msg: `...确定花费${runtimeCost}元宝领取...`, ok: () => claim() })
```

`giftCost()`（`pet/signin.ts:91`）不比较 `info.yb`。

**B**：`handlers-d.ts:91-93`

```ts
if (state.isOnlineLastTime > 0) reject('cooldown', 'the online gift is not ready')
const cost = state.onlineGiftNum * 100
if (cost > 0) payYb(context.state.save, cost)
```

`payYb`（`runtime-helpers.ts:476-479`）`if (save.petInfo.yb < amount) reject('insufficient_funds', 'not enough yuanbao')`。

**差异**：元宝不足时 UI 仍然弹「确定花费 X 元宝」→ 确认 → `insufficient_funds`（「元宝不足」）。legacy 路径在同一处有 `pay(cost)` 兜底（`ui/signin.ts:218`），runtime 分支把它换成了「先问再发命令」，同时丢掉了余额判定。

**为什么属于 S2**：可领性由**本地对余额的默认假设**（假设够）决定，权威端以余额拒绝。
**同类**：`ui/state.ts:145-176`（粉钻 `buyPinkDiamond` 弹窗同样不校验元宝，服务端 `handlers-b.ts:225` `payYb(days*300)`）、`ui/state.ts:100-115`（贴心宝贝 `buySweetheart` → `handlers-b.ts:260` `payYb(days*300)`）、`ui/setup.ts:378-381`（作弊页「粉钻 30天/年费」也走同一命令，元宝不足时作弊按钮失效）。

**建议动态验证**：把 `petInfo.yb` 降到 50（作弊页 `grantCheat` 不能减，可用存档构造 fixture），点在线礼包 → 期望 `insufficient_funds`；同法验证粉钻 30 天。

---

#### UD-05 商城：`buy()` 恒成功 → 购物车清空 + 道谢（**S2**）

**UI 入口**
- `src/renderer/pet/items.ts:206-213`

```ts
export function buy(g: Good, n = 1, quiet = false): boolean {
  if (runtimeProjectionMode) {
    void dispatchRuntimeCommand(uiCommands.buy(g.type, g.id, n)).then((result) => {
      if (quiet || commandSucceeded(result) === false) return
      speak({ c: 'pay', s: g.type, now: true }, 'speak')
    })
    return true                       // ← 命令还没回来就宣布成功
  }
```

- `src/renderer/ui/shop.ts:303-313` `checkout()`：只比 `info.yb`（权威投影，✔）后 `for (...) buy(g,n,quiet)`，恒返回 `true`；
- `src/renderer/ui/shop.ts:337-349`「确认支付」：`checkout(...)` 为真 → `cart.clear()`、关面板、`speak('谢谢[host],帮我清空了购物车~~')`。

**B**：`handlers-b.ts:46-61`

```ts
if ((good.needLevel ?? 0) > save.petComputedlInfo.level) reject('not_available', 'pet level is too low')
if (good.PD === true && save.petInfo.pinkDiamond === false) reject('not_available', 'pink diamond membership required')
const unit = memberPrice(save, good)
if (unit < 0) reject('not_available', 'this good is not for sale')
payYb(save, unit * payload.quantity)          // ← insufficient_funds 可能在这里
```

**差异**：
1. 购物车是多条独立命令：第 1 条成功、第 2 条 `insufficient_funds` → **部分成交**，但 UI 已清空购物车并道谢；
2. 「余额够」用的是**发命令前**的 `info.yb`，N 条命令串行扣款期间余额变化（另一设备、自动补货）会让预检失效；
3. `unit < 0`（下架/不可售）与 PD 规则只在服务端，客户端 `blocked()`（`ui/shop.ts:90`）另有缺陷（见 L-02）。

**为什么属于 S2**：客户端把「可购买且已买到」当成本地结论（返回值恒真），权威端在相同状态下返回拒绝 → 界面与结果不符。

**建议动态验证**：构造 `yb = 100` 的存档，商品单价 60，购物车放 2 个 → 确认支付；期望第 2 条 `insufficient_funds`，UI 仍显示「清空购物车」。检查道具是否只到账 1 个。

---

#### UD-06 看病：弹窗报价 ≠ 实际扣费（**S2**）

**UI 入口**：`src/renderer/pet/items.ts:229-250`

```ts
if (runtimeProjectionMode) {
  ...
  if (line === null) return speak({ s: '[host],我不需要看病的~', now: true }, 'speak')
  const fee = (5 - info.health) * 10
  windowView({
    title: '看病',
    msg: `当前需要花费${fee}元宝，点击确认进行看病~`,
    ok: (close) => { close(); void dispatchRuntimeCommand(uiCommands.treatDoctor()) ... }
  })
```

**B**：`handlers-b.ts:168-181`

```ts
if (payload.mode === 'doctor') {
  if (save.petInfo.health > 0) {
    const fee = (5 - save.petInfo.health) * 10
    payYb(save, fee)                                     // ① 诊疗费（= 界面报价）
  }
  if (inventoryCount(save, 'medicine', medicine.id) > 0) {
    takeGood(save, 'medicine', medicine.id, 1)
  } else {
    const price = medicine.price === undefined ? 50 : medicine.price
    payYb(save, Math.round(price * 1.2))                 // ② 界面从未提到的药费
  }
  applyGood(save, medicine)
  save.petInfo.health = 5
```

**差异**
- 未持有对症药（**默认情况**：legacy 流程会先 `prescribe()` 让用户看到「花费 X 元宝」再买，runtime 分支把这段整个删了）：界面报 `fee`，实际扣 `fee + ceil(price*1.2)`；
- `health === 0`（死亡）：`doctor()` runtime 分支直接 `treatDoctor`（`items.ts:232-236`），**没有任何报价**，服务端按 `health > 0 === false` 跳过诊疗费、直接扣 `price*1.2` 复活。
- 余额不足时 `payYb` 抛 `insufficient_funds`，界面已经承诺「花费 fee」。

**为什么属于 S2**：价格与可支付性由**本地公式推测**，权威端规则更宽/更贵。这是「点击后结果与界面不符」的教科书案例。

**建议动态验证**：构造 `health=3`、背包无对症药、`yb=40` 的存档：界面显示 20 元宝；点击后看 `petInfo.yb` 实际减少（期望 20 + ceil(price*1.2)），以及是否返回 `insufficient_funds`。再构造 `health=0` 验证「无报价扣钱」。

---

#### UD-07 农场：施肥/高级种子永远可点（S2′）

**UI 入口**：`src/renderer/ui/farm.ts:149-173`（`plotAction` 只在 `selected.size === 0` 时拦截）、`:120-131`（种子/化肥按钮只显示库存，不禁用）。

**B**
- `farm-runtime.ts:301-309`：

```ts
if (land.crop === undefined || land.harvest !== undefined || Number(land.state ?? 0) >= 5) continue
const fertilizer = FARM_FERTILIZERS.find(item => burdenCount(farm, item.item) > 0)
if (fertilizer === undefined) break
...
if (done === 0) reject('not_available', 'no selected farm plot needs that care action')
```

- `farm-runtime.ts:346` `if (seed.rank > Number(farm.rank)) reject('not_available', 'farm rank is too low for this seed')`。

**差异**：没有化肥时点「施肥」→ `not_available`；农场等级不足时点「买1种子」→ `farm rank is too low`。UI 明明已经渲染了 `有0`/`Lv{rank}`，却没有据此禁用。

**分类说明**：判定源是投影（`state.rank`、`state.burden`），**不是本地默认值**，所以不满足 README 的 S2 定义；但「可点性」仍是本地「没禁用」的默认，症状与 S2 一致 → 标 S2′。

**建议动态验证**：`farm.burden` 清空后点「施肥」；`rank=1` 时选 rank≥2 的种子点「买1种子」。

---

#### UD-08 池塘投放：选 N 条，权威只买 room 条（**S2**）

**UI 入口**：`src/renderer/ui/fishing.ts:85-108`

```ts
if (data.paytype === 1) {
  const room = pondRoom()                                  // 本地缓存算空位
  const fry = FRIES.find(...)
  if (fry === undefined || room <= 0) return void send(4, { result: 5, msg: '已经满了' })
  windowView({ msg: `投放${fry.name}，空位 ${room}，每条 ${fry.price_yb} 元宝`, max: room, init: 1,
    ok: (close, num) => { ... dispatchRuntimeCommand(uiCommands.fishingBuy(fry.fryid, num)) ... } })
```

**B**：`fishing-runtime.ts:95-99`

```ts
const room = pondCap(context) - pond.fishs.length
if (room <= 0) reject('busy', 'the pond is full')
const quantity = Math.min(payload.quantity, room)          // ← 静默降级
const cost = fry.price_yb * quantity
payYb(context.state.save, cost)
```

**差异**：用户在弹窗里选 3 条、界面承诺「投放 3 条 / 每条 X 元宝」，权威端只投放 `min(3, room)` 条并只收对应费用，命令返回 `applied` → SWF 显示成功，用户以为买了 3 条。触发条件：弹窗与命令之间空位被占（贴心宝贝/另一台设备/同账号 server 会话）。

**为什么属于 S2**：数量与总价是**本地算式 + 本地缓存**的结论，权威端另有 clamp 规则，结果与界面不符。

**建议动态验证**：room=2 时在弹窗选 3 → 断言 `fishs.length` 只 +2、扣费 2×单价、返回 `applied`。

---

#### UD-09 企鹅岛「刷新新闻」：dayKey 本地推断（**S2，低**）

**UI 入口**：`src/renderer/ui/island-runtime.ts:191-193, 228-231`

```ts
function viewState(): IslandViewState {
  return currentProjectionView() ?? { gameTimeMs: Date.now(), timeZone: 'UTC' }
}
function refreshNews(): void {
  const view = viewState()
  void dispatchIsland(islandCommands.refreshNews(dayKeyAt(view.gameTimeMs, view.timeZone)))
}
```

**B**：`island-runtime.ts:497-500`

```ts
const expectedDayKey = dayKeyAt(context.ctx.gameTimeMs, context.state.timeZone)
if (payload.dayKey !== expectedDayKey) reject('not_available', 'news refresh is for a stale day')
```

**差异**：正常情况下 `currentProjectionView()` 给出权威 `gameTimeMs/timeZone`，两边一致；**只有在首帧投影到达之前**打开面板（fallback `Date.now()` + `'UTC'`）时，dayKey 与权威不同 → 拒绝。server 模式跨时区时，fallback 的 UTC 一定错。

**为什么属于 S2**：`viewState()` 的 fallback 就是「本地默认值」；只是窗口很窄，故严重度低。

**建议动态验证**：在 `window.__qqpetBufferedProjections` 为空、`currentViewState === null` 时（如首次启动立刻点菜单），点击「刷新新闻」，断言返回 `news refresh is for a stale day`。

---

#### UD-10 旅游：忙/元宝未判定（S2′）

**UI 入口**：`src/renderer/ui/travel.ts:96-110`

```ts
const city = activity('trip')
...
const disabled = travelStopDisabled(city, pending)   // = city === null || pending
go.classList.toggle('disable', Boolean(city))        // ← 只按 trip 判忙
stop.classList.toggle('disable', disabled)
...
finish.style.display = visited.length === PROVINCES.length ? '' : 'none'   // ← 只看省份数
```

**B**
- `handlers-c.ts:30-37, 113-114`：

```ts
function cannotStartActivity(save) {
  if (save.petInfo.health === 0) return 'pet_dead'
  if (save.petInfo.health !== 5) return 'not_available'
  if (save.settings.paused) return 'paused'
  if (save.petInfo.mood <= 0) return 'not_available'
  if (isBusy(save)) return 'busy'       // ← work/study/trip 都算
  return null
}
...
if (blocker !== null) rejectActivityBlocker(blocker)   // startTravel
```

- `handlers-b.ts:284-286`：

```ts
if (save.gameSaveDatas.travel_china.length !== TRAVEL_PROVINCES.length) reject('not_available', 'not every province has been visited')
if (isBusy(save)) reject('busy', 'the pet is busy')
payYb(save, 8888)                        // ← 界面从未校验 8888
```

**差异**：打工/上课中点「去旅行」→ `busy`；生病（health 1-4）/暂停/心情 0 时点「去旅行」→ `not_available`/`paused`；省份集齐但正在忙/元宝不足时点「完成旅游成就」→ `busy`/`insufficient_funds`。legacy 路径这些都在 `jobs.cannot()`（`pet/jobs.ts:53-62`）里说人话，runtime 分支跳过了它。

**分类**：判定源是投影里的 `activity`（不是本地默认），缺的是**前置条件的覆盖**，故 S2′。

**建议动态验证**：让宠物打工，打开旅游面板点「去旅行」；再让 `travel_china` 集齐、`yb<8888`，点「完成旅游成就」。

---

#### UD-11 小游戏启动：paused/授权未判定（S2′）

**UI 入口**：`src/renderer/ui/smallgame.ts:239-249`

```ts
export function playSmallGame(g) {
  if (root || playingDesk()) return
  const st = stage()
  if (st === 'Egg') return speak(...)
  if (busy()) return speak(...)
  if (runtimeProjectionMode) { void startRuntimeSmallGame(g); return }
```

**B**：`sessions.ts:95-101, 104-110`

```ts
function requirePlayable(state, ctx) {
  requireLivingPet(state)                              // health <= 0 才拒
  if (state.save.settings.paused) reject('paused', 'the pet is paused')
  const stage = ...
  if (stage === 'Egg') reject('not_available', 'the pet is still an egg')
  if (isBusy(state.save)) reject('busy', 'the pet is busy')
  requireActor(ctx)                                    // actorDeviceId 为空 → unauthorized
}
```

**差异**：暂停成长时 UI 仍允许开局 → `paused`；未认证 actor → `unauthorized`；`health===0` 时菜单本来就只剩「商城/埋葬」（`ui/runtime-menu.ts:48-50`），不可达。对照：`diudiule` 反而多判了 `info.health < 5`（`ui/diudiule.ts:144`），两条玩法不对称。

**分类**：S2′（判定源是投影的 stage/busy，漏了 paused/actor）。
**建议动态验证**：`settings.paused=true` 时打开「游戏 → 陪我玩」，点任一局；断言 `paused`。

---

#### UD-12 暂停成长态：农场/池塘/企鹅岛入口全可点（S2′）

**UI 入口**：`ui/farm.ts:149-173`（所有 `farmAct` 按钮）、`ui/fishing.ts:77-128`（cmd 2/4/5/7/8 全部无条件转发）、`ui/island-runtime.ts:260-355`（全部 `commandButton`）。

**B**
- `farm-runtime.ts:139-146` `requireFarmReady`：`if (context.state.save.settings.paused) reject('paused', 'the pet is paused')`（还有 `actorDeviceId === null → unauthorized`）；
- `fishing-runtime.ts:58-65` `requirePondReady`：同上；
- `island-runtime.ts:46-51` `requireIslandReady`：同上。

**差异**：`settings.paused` 是**共享权威值**（`data-boundary.ts:24` `SHARED_SETTINGS_KEYS`），投影里就有；三个面板都没读它。暂停期间玩家点任何操作 → `paused`（弹窗「宠物处于暂停成长状态」），或 `unauthorized`（从机角色）。
**分类**：S2′（不是本地默认值，而是漏用权威值）。
**建议动态验证**：暂停成长 → 打开农场点「浇水」、池塘点「收获」、企鹅岛点「领宝藏」，三条都应 `paused`。

---

## 3. 已排除（判定确实只读投影 · 安全）

> 这些路径的 A 直接取投影/命令结果，或运行时整体 no-op；**不要重复排查**。

| 编号 | 主题 | 证据（结论） |
|---|---|---|
| E-01 | `store.ts` 的 `update()` 在 projection 模式的总闸 | `store.ts:207-218` 一律走 `assertDeviceLocalSavePatch`；canonical 键直接抛（见 §4）。这是**保护**，不是判定源。 |
| E-02 | 投影写入范围 | `data-boundary.ts:77-79` `SHARED_SAVE_JSON_KEYS = ['email','task','signin','fishs','farm','activity','album','island']`；`renderer-projection.ts:132-136` 只保留非 shared 的本地键 → `task/signin/fishs/farm/island/email` 不会被本地值覆盖，**也不会有陈旧本地副本冒充权威**。 |
| E-03 | 缓存失效顺序 | `store.ts:165-185`：hydrate → notify → `invalidateProjectionCaches` → `dispatchOrderedEvents` → projection listeners。面板在事件里重绘时缓存**已**失效（`projection-cache.ts:12-18, 59-65`）。UD-02 只是「命令回执早于投影」，不是失效顺序错。 |
| E-04 | 签到本地默认值 | `pet/signin.ts:30-39` 的 `?? 20` / `?? true` 与权威 `runtime-helpers.ts:281-294` **逐字段相同**（`isOnlineLastTime: 20`、`getBirthDayGift: true`）。默认值本身不分叉；分叉只在「哪一天」（UD-03）。 |
| E-05 | `canDrawGrowth()` | `pet/signin.ts:69` `!getGrowth || (PD && !getGrowth[1])` ≡ `handlers-d.ts:59-61` 的拒绝条件取反。等价。 |
| E-06 | 邮箱列表与领取 | `ui/email.ts:27` runtime 分支直接 `readMails()`（投影）；`mail.claim/claimAll/delete/deleteAll` 的前置（`handlers-d.ts:143-212`）与按钮语义一致；「一键删除」只删已领取（服务端同规则），不产生拒绝。 |
| E-07 | 任务可领性（完成度） | `ui/task.ts:18` `!t.take && t.done >= t.num`：`take`、`doNums`、`travel_china.length` 都来自投影（`tasks.ts:142,151`）；与服务端 `handlers-c.ts:153-155` 同规则。**只有奖励内容**分叉（UD-01）。 |
| E-08 | 宠物岛面板数据 | `ui/island-runtime.ts:37-60` 只解析投影 blob；`selectGiftItems`（`:146-155`）读 `save.selfGoodDatas`（投影）；送礼/交付的库存校验与 `island-runtime.ts:335-366,428-448` 同源。 |
| E-09 | 农场地块/仓库标签 | `ui/farm.ts:76-97`：blob 缺 `farmland` 时合成的默认布局（6 `FarmlandS` + 12 `Wasteland`）与权威 `farm-runtime.ts:54-60` `freshFarm()` **同构**；缺条目渲染「未导入」且禁止选中（`:133`）。 |
| E-10 | `farmNews()` 投影分支 | `ui/farm.ts:306-336` 明确不 roll 灾害、只用投影时钟与 `state/progress`；legacy 的 `Math.random` 病灶（`:337-360`）在 projection 不可达。 |
| E-11 | `runFarmCare()`（本地随机产量） | `pet/farm-care.ts:63-69` 用 `Math.random`，唯一调用链 `sweetcare.ts:116` ← `careTick()` ← legacy `tick()`（`pet.ts:429`）；projection 不启动 `tick()`（`main.ts:543-551` → `beginProjection`）。**不可达**。权威端产量由 `farm-runtime.ts:112-115` 的 rng 决定。 |
| E-12 | 鱼塘 SWF 的读写通道 | `ui/fishing.ts:77-79` cmd 1/3 只读本地缓存；所有变更走命令（`:80-127`），且 `pet/fishing.ts:259-264` 在 runtime 模式直接拒绝本地变更（`result:5`）。`pondState()` 返回的是投影缓存。 |
| E-13 | 小游戏/丢丢乐的奖励 | `ui/smallgame.ts:117-126`（奖励只 `call(w,'TICKLE_OnResult')` 展示）、`ui/games.ts:23-38`（用命令结果播报）、`ui/diudiule.ts:45-60`（同）——真正的数值由 `sessions.ts` 结算。 |
| E-14 | 拜访好友 | `ui/visit.ts:44-45` 的 `Egg`/`busy`/`health<5` 判定与 `island-runtime.ts:258-265` `socialCompleteLanVisit` 完全对齐（含 `isBuried` 由菜单屏蔽）。 |

---

## 4. 次要类别：本地写入口未迁移（不属 S1/S2 主表）

> 机制：projection 模式下 `update()` → `assertDeviceLocalSavePatch()`（`store.ts:209`）→ `CanonicalMutationBlockedError`（`renderer-projection.ts:38-45, 262-267`）。能被归类为「设备本地」的只有：
> `petInfo.lastX/lastY`（`data-boundary.ts:58`）、`DEVICE_LOCAL_SETTINGS_KEYS`（`:60-66`）、`PRESENTATION_ONLY_SAVE_JSON_KEYS = ['community','weather']`（`:81`）。
> 其余一律抛异常。异常在点击回调里**同步抛出**，不进 `qqpet-command-error` 通道 → 玩家只看到「点了没反应」+ 控制台红字。

| 编号 | UI 入口（文件:行） | 触发函数 → 写入 | projection 下会抛？ | 玩家可见后果 | 可达性 |
|---|---|---|---|---|---|
| W-01 | `ui/setup-sections.ts:493`「冻结状态」开关 | `setFrozen()`（`pet/pet.ts:375`）→ `update('saveJsonData',{freeze})` | **会**（`freeze` 不在任何白名单） | 抛 `CanonicalMutationBlockedError: freeze`，开关状态不变；`frozen()`（`pet.ts:374`）仍读旧本地键 | **不可达**：该表单位于 `cheatSection()`，projection 下被替换为 `CHEAT_OPTIONS`（`ui/setup.ts:523`）；`cheatSection` 只被 `setup.ts:24` 导入 |
| W-02 | `ui/setup-sections.ts:487-490`「时间快进」 | `skipTime()`（`pet/pet.ts:377-382`）→ `tick()` | **不会抛**：`lastTick === null`（projection 从不启动 `tick`）→ `:379` 直接 return | 静默无操作（文案仍说「时间过去了 N 小时」） | 不可达（同上） |
| W-03 | `ui/setup-sections.ts:153,260-261` 托管队列 | `setCustody()`（`pet/custody.ts:20`）→ `update('saveJsonData',{custody})` | **会** | 抛异常，设置不生效 | 不可达（`runtimeSweetSection` 替换，`setup.ts:485`） |
| W-04 | `ui/setup-sections.ts:174-207` 贴心宝贝表单 | `setCare()`（`custody.ts:25`）→ `saveJsonData.care` | **会** | 抛异常 | 不可达（同上） |
| W-05 | `ui/setup-sections.ts:280`「清空日志」 | `clearCareLog()`（`pet/sweetcare.ts:15`） | **会** | 抛异常 | 不可达（同上） |
| W-06 | 间接：`pet/jobs.ts:149,261`、`sweetcare.ts:51,70-87` | `logCare()`（`sweetcare.ts:18-19`）→ `saveJsonData.careLog` | **会** | 抛异常会中断调用链 | 不可达：`examPrompt` 有 `runtimeProjectionMode === false`（`jobs.ts:147`）；`studySubject` 仅由 `custody.tickCustody`（legacy `tick()`）调用 |
| W-07 | 间接：`sweetcare.ts:38` | `payCare()` → `saveJsonData.careSpent` + `setInfo('yb')` | **会** | 抛异常 | 不可达（`careTick()` 仅 legacy） |
| W-08 | 间接：`sweetcare.ts:118` | `autoFarm()` → `update('saveJsonData',{farm})` | **会** | 抛异常 | 不可达（同上） |
| W-09 | 间接：`jobs.ts:226` 旅游明信片 | `takePhoto()` → `addShot()`（`pet/album.ts:36`）→ `saveJsonData.album` | **会** | 抛异常 | 不可达（`back()` 只在 legacy `tripTask.end`） |
| W-10 | `ui/setup-sections.ts:461`「点亮全部省份」 | 直接 `update('gameSaveDatas',{travel_china})` | **会** | 抛异常 | 不可达（`cheatSection`） |
| W-11 | `ui/setup-sections.ts:494`「不会死亡」 | `update('settings',{undying})` | **会**（`undying ∈ SHARED_SETTINGS_KEYS`） | 抛异常 | 不可达（runtime 用 `setSharedSetting()` 命令，`setup.ts:360-364`） |
| W-12 | `ui/island.ts:869`（`store()`） | 社区/岛世界所有写 | **会** | 抛异常 | 不可达：唯一入口 `openCommunity`（`control.ts:129`）在 runtime 菜单被替换成「企鹅岛」并过滤（`control.ts:136-149`） |
| W-13 | `ui/face.ts:36`、`pet/activity.ts:51,92`、`pet/vip.ts:19-30`、`ui/travel.ts:53`、`ui/adopt.ts:79`、`pet/goods.ts:43-72`、`ui/farm.ts:32` | 各种 canonical 写 | 均有 `runtimeProjectionMode` 前置 return | — | **已守卫**（列出以示穷举：`face.ts:22/32`、`activity.ts:52/70/89`、`vip.ts:34/45/66/77`、`travel.ts:41`、`adopt.ts:76`、`goods.ts:43/57/65/72`、`farm.ts:30`） |

**补充观察（不计入 W-x）**
- `pay()` 有 projection 守卫并返回 `false`（`pet/items.ts:14-15`），但 **`payDiamond()`（`items.ts:25-32`）没有任何守卫**；当前调用方 `ui/state.ts:93`（`buySweetHeartWithDiamond`，仅 `setup-sections.ts:164` 可达）都在不可达分支，属潜伏不一致。
- `clearPinkDiamond`/`openPinkDiamond`/`addSweetHeart`/`newDay`/`resetSignIn`/`resetTasks`/`rollDaily`/`resetTour`/`settle` 均有前置 return，符合「投影模式渲染层不写 canonical」的设计。
- `custody/care/careLog/careSpent/freeze/album` 这类本地键**不在** `SHARED_SAVE_JSON_KEYS` 也不在 `PRESENTATION_ONLY_SAVE_JSON_KEYS`：投影时作为 `localOnlyJson` 存活（可读），但 `classifySavePatch` 判它们 canonical（不可写）。这个「可读不可写」的不对称是 W-01…W-11 的根因，建议后续统一（要么加进 presentation 白名单，要么补命令）。

**结论**：按当前代码，**上述写入口在 projection 模式下均不可达**（`setup.ts:485,523` 与 runtime 菜单是两道有效闸门）；但它们**没有自身守卫**，一旦有人把某个 section 重新挂到 runtime 菜单/新增入口，就会立刻变成「点击无反应 + 控制台异常」。风险等级：中（潜伏），不是当前缺陷。

---

## 5. 边界 / 潜伏（当前不算缺陷，但需知会）

| 编号 | 内容 | 说明 |
|---|---|---|
| L-01 | 任务表双份定义 | `pet/tasks.ts:34-108` 的 `TASKS` 与 `content/tasks.json` 的 `STATIC_TASKS` 当前**逐字段相同**（证据 A）；但 UI 的 `num/label/obj` 取自本地常量，权威 `num` 取自共享表。任何一侧漂移即变成「显示 X/N、服务端按 Y/N 校验」。建议加一条表一致性测试（本次已提供检查脚本）。 |
| L-02 | `shop.blocked()` 的 `else` | `ui/shop.ts:90`：`needLevel ? (needLevel 不足 ? 1 : 0) : PD && !PD会员 ? 2 : 0` —— 一旦某商品**同时**有 `needLevel` 与 `PD`，等级满足时 PD 判定被短路。当前 goods.json 中无此组合（已验证：PD+needLevel = 0 条），故**今日不可触发**。 |
| L-03 | 邮箱并发命令 | `ui/email.ts:36-41` 的 `Promise.all(commands.map(dispatch))` 在「混合已领/未领」列表时会并发；server 模式 `remote-repository.ts:492-497` 只允许一条在飞 → 其余 `busy`。当前两个底部按钮的过滤（`:107-108`）保证列表同质，**现有 UI 走不到该分支**；但 `act()` 是公共函数，属潜伏。 |
| L-04 | `ripeFish()` 无 runtime 守卫 | `pet/fishing.ts:126-130` 用 `Date.now()` 推进本地缓存 stage。唯一调用 `pet/harvest.ts:15` ← `grow()`（legacy）。**不可达**；若将来在 projection 提醒里复用，会让「可收获」超前于权威。 |
| L-05 | 收藏/图鉴写入 | `goods.addGood()` 在 projection 直接 return（`goods.ts:43`），但 `illustrated` 的更新随之丢失 → 图鉴「已见」只随投影变化。不是拒绝类缺陷，仅说明图鉴计数依赖权威实现（服务端 `grantGoods`）。 |
| L-06 | 签到月历的月份桶 | `ui/signin.ts:245-246` 用本地 `new Date(dayStart())` 选「本月」；跨月 + 时区偏移时可能统计到上/下月（与 UD-03 同源，表现更轻）。 |
| L-07 | 生日礼自动领取 | `ui/signin.ts:262-273` 用本地 `today.getDate() !== born.getDate()` 守卫，权威 `handlers-d.ts:115-117` 用 `localDate(gameTimeMs, timeZone)`；跨时区时可能在「不是生日」的日子发命令 → `not_available`（错误弹窗在打开签到页时出现）。 |
| L-08 | `commandResultGoods` 只信 id | `runtime-command.ts:68-93` 用本地 goods 表还原奖励图标；若权威返回本地表没有的 id，会被**静默丢弃**（不会假造），但 UI 的「你领取了…」会少显示。 |
| L-09 | 农场 `checked` 字段 | `farmNews()`（projection 分支）不读 `checked`；权威 `settleFarm` 用它算灾害概率。仅影响提醒文案的「新」判定，不影响命令。 |

---

## 6. 证据与复现

### 6.1 证据文件

- `audit/similar-errors/findings/ui-divergence/evidence/check-task-tables.mjs` —— 只读脚本：从 `src/renderer/pet/tasks.ts` 抽出 `TASKS` 字面量，与 `src/shared/pet-runtime/content/tasks.json` 的 `tasks` 逐 tab 比对，并统计 reroll 模板。
- `audit/similar-errors/findings/ui-divergence/evidence/check-task-tables.out` —— 运行输出：

```
ddw: IDENTICAL (renderer 5 entries, canonical 5 entries)
growth: IDENTICAL (renderer 4 entries, canonical 4 entries)
travel: IDENTICAL (renderer 9 entries, canonical 9 entries)
tabs with reroll templates (local Math.random loot at load): ddw=2 growth=2 travel=1
RESULT: tables identical; no static drift
```

复现：`node audit/similar-errors/findings/ui-divergence/evidence/check-task-tables.mjs`

（说明：本目录只写审计产物；脚本只读 `src/`，不导入渲染层模块图，不写任何存档。）

### 6.2 已核对的静态事实（可 grep 复核）

| 事实 | 位置 |
|---|---|
| 渲染层用 `Math.random` | `pet/loot.ts:7-19`、`pet/rand.ts:1-2` |
| 权威端用 runtime RNG | `runtime-helpers.ts:526-543`（`lootGoods`）、`pet-runtime/rng.ts` |
| 修复只补「条目存在性」，不补「内容一致性」 | `runtime-tasks.ts:143-158` ↔ `tasks.ts:126` |
| `update()` 的 projection 分支 | `store.ts:207-218` |
| 抛错点 | `renderer-projection.ts:262-267` |
| 共享键白名单 | `data-boundary.ts:24, 58, 60-66, 77-81` |
| 各命令每次新 opId（不去重） | `main/renderer-runtime.ts:238-241`、`main/remote-repository.ts:487-491` |
| server 模式并发命令直接拒 | `main/remote-repository.ts:492-497` |
| local-v2 在命令返回前已发投影 | `main/local-repository.ts:813`（`emitProjection()` 位于 `executeCommandNow` 内） |
| projection 模式不启动 legacy `tick()` | `main.ts:543-551`、`pet/runtime-boot.ts:15-34` |
| legacy 菜单/设置被替换 | `control.ts:136-149`、`setup.ts:485, 523` |

---

## 7. 建议的动态验证矩阵（交给 repro-auditor / verifier）

存档基座：`audit/similar-errors/fixtures/imported-shared.json`（`task/farm/fishs/island/email` 为空）。

| 用例 | 前置状态 | 操作 | 期望断言 |
|---|---|---|---|
| R-01 (UD-01) | `task` 为空 | 打开活动列表 → 领 `ddw[3]` | 截图奖励 id 集合 ≠ 投影后的 `taskList.ddw[3].good`；重复 3 次 |
| R-02 (UD-02) | server 模式，注入 300ms 延迟 | 连点同一任务领奖 | 第 2 次 `already_claimed`/`busy`；legend：local-v2 不可复现 |
| R-03 (UD-03) | server `QQPET_SYNC_TIME_ZONE=UTC`，客户端 Asia/Shanghai | 在本地 06:00–14:00 打开签到 | `disable` 状态与服务端 `already_claimed` 不一致 |
| R-04 (UD-04) | `yb=50`，`onlineGiftNum=1` | 点在线礼包并确认 | `insufficient_funds`；确认弹窗仍显示「花费 100 元宝」 |
| R-05 (UD-05) | `yb=100`，购物车 2×60 | 确认支付 | 到账 1 个；`insufficient_funds`；购物车被清空 |
| R-06 (UD-06) | `health=3`，无对症药，`yb=40` | 点「看病」并确认 | 界面 20；实扣 20+ceil(price×1.2)；或 `insufficient_funds` |
| R-07 (UD-06b) | `health=0`，无还魂丹 | 点「看病」 | 无任何报价，直接扣 `ceil(price×1.2)`；查看 `yb` 前后差 |
| R-08 (UD-07) | `farm.burden=[]`，`rank=1` | 点「施肥」/「买1种子(rank≥2)」 | `not_available` / `farm rank is too low` |
| R-09 (UD-08) | `room=2` | 弹窗选 3 条投放 | `fishs.length +2`，扣 2×单价，返回 `applied` |
| R-10 (UD-09) | 首帧投影前（`currentViewState===null`） | 打开企鹅岛点「刷新新闻」 | `news refresh is for a stale day`（或 server 跨时区必现） |
| R-11 (UD-10) | 工作中 / `travel` 集齐但 `yb<8888` | 「去旅行」/「完成旅游成就」 | `busy` / `insufficient_funds` |
| R-12 (UD-11/12) | `paused=true` | 开局小游戏、农场浇水、池塘收获、岛屿领宝藏 | 全部 `paused` |
| R-13 (W 类) | projection 模式 | 逐页打开设置（含 5 连点版本号显示作弊页）、贴心宝贝页 | 控制台**不应**出现 `CanonicalMutationBlockedError`（验证闸门有效） |

---

## 8. 覆盖范围与缺口

**已读并覆盖**
`src/renderer/pet/`：`tasks.ts`、`signin.ts`、`mail.ts`、`items.ts`、`farm-care.ts`、`fishing.ts`、`pet.ts`、`store.ts`、`projection-cache.ts`、`runtime-command.ts`、`command-map.ts`、`jobs.ts`、`activity.ts`、`goods.ts`、`album.ts`、`custody.ts`、`sweetcare.ts`、`readiness.ts`、`vip.ts`；
`src/renderer/ui/`：`task.ts`、`signin.ts`、`email.ts`、`shop.ts`、`items`(via pet)、`farm.ts`、`fishing.ts`、`island-runtime.ts`、`box.ts`、`result.ts`、`window-view.ts`、`control.ts`、`menu.ts`、`runtime-menu.ts`、`state.ts`、`petinfo.ts`、`setup.ts`、`setup-sections.ts`、`travel.ts`、`games.ts`、`smallgame.ts`、`diudiule.ts`、`visit.ts`、`face.ts`、`chat.ts`、`adopt.ts`；
`src/shared/pet-runtime/`：`handlers-a..d`、`handlers-server`、`sessions.ts`、`farm-runtime.ts`、`fishing-runtime.ts`、`island-runtime.ts`、`runtime-tasks.ts`、`runtime-helpers.ts`、`tick.ts`、`self-care.ts`、`content/index.ts`；
`src/main/`：`renderer-runtime.ts`、`local-repository.ts`、`remote-repository.ts`；`server/src/config.ts`。

**未覆盖（说明理由）**
- `src/renderer/ui/island.ts`（70KB legacy 岛世界）、`island-talk.ts`、`community.ts`、`lan-visit.ts`、`mstx.ts`、`exam.ts`：projection 模式菜单不可达（`control.ts:136-149`、`runtime-boot.ts:37-39`）；`island.ts` 仅经 `community.ts` 引用。
- 移动端 `src/ios/**`、`src/android/**`、`src/harmony/**`、`src/mobile/**`：桌面端范围外（本任务指定 `src/renderer/**` 桌面端）。
- `blob` 归一化/导入（`portable-import.ts`、`serialization.ts`）：blob-auditor 职责；本报告只在 UD-01 交叉引用。
- `server/` 调度器与投影下发时序（`server/src/scheduler.ts`）：只用于确认 `timeZone` 来源（UD-03）。

**未做**
- 未运行任何动态用例（R-01…R-13 只是设计好的验证矩阵）；
- 未跑现有测试套件（按要求）；只运行了 6.1 的只读表比对脚本。
