# 宠物运行时与存档

> 结论：游戏规则全部收敛为 `src/shared/pet-runtime/**` 里的纯函数——给定 `EngineState`、命令与 `RuntimeContext`，输出新的 `EngineState` 加有序事件，没有任何宿主依赖；RNG 游标、游戏时间与调度锚点都属于持久状态，因此同一份存档在任何宿主上重放同一操作会得到同一结果。存档是「规范共享态 + 设备本地浮层 + 权威标记 + 幂等缓存」四件套，落在 `save.v2.json`，旧 `save.json` 与上游 `config.json` 只作为迁移输入；崩溃、损坏、跨版本都在写入前拦截并保留原始字节，不静默丢弃。

## 1. 分层：纯函数运行时、宿主、文档

| 层 | 职责 | 位置 |
| --- | --- | --- |
| 规则 | `executeCommand`、`advanceMinute`、`advanceMinutes`、`advanceSchedulerChunk` 纯函数 | `src/shared/pet-runtime/runtime.ts:169-315`、`src/shared/pet-runtime/tick.ts:421-441`、`src/shared/pet-runtime/scheduler.ts:55-151` |
| 便携宿主 | 加载/迁移/持久化/幂等/追赶/投影，禁止 import Node、Electron、DOM、WebSocket | `src/shared/local-repository/host.ts:353-358` |
| 桌面宿主 | 同上语义，另加 Node 文件与备份/回滚快照 | `src/main/local-repository.ts:231-300` |
| 服务端宿主 | 无状态适配器，每次从权威快照重算 | `server/src/runtime-host.ts:29-59` |
| 状态文档 | `EngineState` + 幂等缓存 + 权威标记 | `src/shared/pet-runtime/types.ts:209-235`、`src/shared/pet-runtime/idempotency.ts:33-38` |

`EngineState` 的持久字段包括 `gameTimeMs`、`lastSchedulerWallMs`、`nextDailyBoundaryMs`、`lastProcessedDayBoundaryKey`、`rng`、`scheduledJobs`、`gameSessions`、`sessionCoverage`、`advanceWhileEmpty`、`timeZone`、`weatherLocation`、`environment`（`src/shared/pet-runtime/types.ts:209-235`）。凡是影响结果的量都在这里，不存在「宿主自己记一份」的隐式状态。

## 2. 确定性推进

命令执行三步固定（`src/shared/pet-runtime/runtime.ts:150-163`）：深拷贝引擎 → 用拷贝出的 `rng` 游标建 `RuntimeRng` → 调用 handler；handler 若没有替换 `engine.rng`（`pet.reset` 会替换），就把游标写回。收尾统一 `recomputePetComputed(save)` + `save.nowTimeLine` + `assertEngineState(state)`（`src/shared/pet-runtime/runtime.ts:143-148`），任何非法状态在提交前抛错而不是落盘。

一分钟 tick 的顺序是契约，不能重排（`src/shared/pet-runtime/tick.ts:380-419`）：

1. 合并宿主给的环境输入（日历/天气）。
2. `gameTimeMs += 60000` 并同步 `save.nowTimeLine`。
3. 暂停/死亡/埋葬分支：把所有 `scheduledJobs.dueAtGameMs`、`startedAtGameMs`、活动会话的 `startedAt/expiresAt`、`nextDailyBoundaryMs` 整体平移一分钟并**不产出任何事件**（`src/shared/pet-runtime/tick.ts:385-401`）。
4. 从 `state.rng` 建立本 tick 的 RNG。
5. 解析当日天气：先查 `environment.weatherByDay[dayKey]`，缺失才用 `seedHex + dayKey` 派生（`src/shared/pet-runtime/tick.ts:55-62`）——天气消耗的是确定性派生，不是随机游标。客户端展示用的 `GET /v1/client/weather` 与 `GET /v1/client/calendar`（见 [同步协议](sync-protocol.md) §12）只是展示数据，不写入 `engine.environment`；服务端引擎仍用 `seedHex + dayKey` 的确定性 fallback，本次不改变存档 schema。
6. 处理跨过的每日边界，单 tick 最多 4 个（`src/shared/pet-runtime/tick.ts:43`、`src/shared/pet-runtime/tick.ts:406-414`）。
7. 处理到期任务，排序键为 `dueAtGameMs` 再 `id`（`src/shared/pet-runtime/tick.ts:177-180`）。
8. 被动分钟结算，内部顺序固定：心情/饥饿/清洁三项抽签 → 成长 → 自我照料 → 活动投影 → 旅行早归掷骰 → 定时道具衰减 → 在线时长 → 疾病 → 农场 → 钓鱼 → `pet.statsChanged`（`src/shared/pet-runtime/tick.ts:324-378`）。
9. `state.rng = rng.state` 写回（`src/shared/pet-runtime/tick.ts:417`）。

以上顺序被打乱会改变抽签次数，从而改变同一存档的未来。仓库用行为测试固定这些顺序（例如 `scripts/tests/pet-runtime-c3.test.mjs` 里的「fresh static task rewards replay renderer load-then-reset RNG order」「mixed due travel/study jobs process in dueAt then jobId order」）。

## 3. RNG 契约

- 算法固定 xoshiro128\*\*，状态是 32 位十六进制四字；`stateHex` 全零被拒，`draws` 必须是非负安全整数（`src/shared/pet-runtime/rng.ts:39-64`）。
- 种子必须由宿主 CSPRNG 产生，运行时从不自己造种子：桌面用 `randomBytes(16).toString('hex')`（`src/main/renderer-runtime.ts:89`），便携宿主在缺种子时直接抛 `local repository seed is not available`（`src/shared/local-repository/host.ts:882-887`）。
- 三种抽样语义互不替代：
  - `randIntInclusive` 用 `Math.round`，与旧前端 `rand` 行为一致，用于数值区间（`src/shared/pet-runtime/rng.ts:96-103`）。
  - `randomIndex` 用 `Math.floor(unit * count)`，用于集合选择；`rng.ts:105-110` 明确写了「round 会把三选一偏成 1/4、1/2、1/4」，因此掉落类逻辑必须走这里。
  - `chance` 即使概率为 0 或 1 也消耗一次抽取（`src/shared/pet-runtime/rng.ts:187-191`）。
- 每次都推进游标：这是「同存档同结果」的唯一保证，任何绕过 `RuntimeRng` 直接用 `Math.random` 的代码都会破坏重放。

## 4. 事件有序流

两类事件严格区分（`src/shared/pet-runtime/events.ts:47-74`）：

- `DomainEvent` 只有 `type` + `payload`，由运行时产出，不含序号。
- `OrderedEvent` 由提交方补 `eventSeq`、`revision`、`gameTimeMs`，可选 `commandSeq`；`assertOrderedEventStream` 要求 `eventSeq` 严格递增、`revision` 非递减且非负、`commandSeq` 非负、`gameTimeMs` 为安全整数（`src/shared/pet-runtime/events.ts:103-120`）。

宿主的分派规则（`src/shared/local-repository/host.ts:1438-1452`）：

- `revision` 只在命令被接受时 +1；被拒绝不改 `revision`（`src/shared/local-repository/host.ts:1438`）。
- `eventSeq` 累加本批事件条数，起点是 `baseEventSeq + 1`。
- 事件历史只保留最近 512 条（`src/shared/local-repository/host.ts:56`、`src/shared/local-repository/host.ts:1451-1452`），超出后旧事件淘汰，但 `eventSeq` 不回退。
- 追赶分片里，同一分片的所有事件共用一个 `revision`（`src/shared/local-repository/host.ts:1594-1600`）。
- 命令路径在统一出口 `toOutcome` 重算等级；若等级变化且本批事件尚未包含 `pet.levelChanged`，补发一条 `{ previousLevel, level }`（`src/shared/pet-runtime/runtime.ts:143-183`）。被动分钟 tick 已在自身路径发同一事件，因此不会重复。该事件只用于表现，权威等级仍以投影里的 `petComputedlInfo.level` 为准。
- 心情耗尽取消进行中的活动时，`activity.completed` 的 `kind` 为 `all`，并携带 `kinds` 数组标明被取消的 `work`/`study`/`travel`；表现层据此选择原版 `stopWorkFoMood0`/`stopStudyFoMood0`/`overTripUpFoMood0` 台词（`src/shared/pet-runtime/tick.ts:333-343`）。

## 5. 存档结构与边界

| 层次 | 内容 | 位置 |
| --- | --- | --- |
| `SaveData` | 上游 `config.json` 的同名字段与拼写（含 `petComputedlInfo` 的拼写错误）原样保留 | `src/shared/save.ts:1-3`、`src/shared/save.ts:161-178` |
| `SharedSaveData` | 规范共享态：去掉 `lastX/lastY`，`settings` 只保留 `paused`/`difficulty`/`undying` | `src/shared/sync/data-boundary.ts:24-33` |
| `DeviceLocalOverlay` | 设备本地态：位置、缩放、音视频、AI key 等 | `src/shared/sync/data-boundary.ts:35-66` |
| `PortablePetBundleV1` | `qqpet-portable-v1` + `schemaVersion: 1`，含 `authority: AuthorityStamp`、`shared`、`engine` | `src/shared/sync/portable.ts:50-51`、`src/shared/sync/portable.ts:79-88` |
| `LocalPetDocumentV2` | `qqpet-local-v2` + `schemaVersion: 1`，含 `revision`/`eventSeq`/`authority{state,stamp}`/`bundle`/`runtime`/`device`/可选 `idempotency`/`eventHistory` | `src/shared/sync/portable.ts:52-53`、`src/shared/sync/portable.ts:109-125` |
| `RemoteProjectionCacheV2` | 服务端投影缓存，含 `petId`/`deviceId`/游标/权威/`shared`/`device` | `src/shared/sync/portable.ts:127-142` |

永不外发的字段有独立名单：`NEVER_UPLOAD_SETTING_KEYS`（`aiKey`、`searchKey`、`webhookToken`）与 `NEVER_UPLOAD_KEYS`（`src/shared/sync/data-boundary.ts:70-76`），服务端投影边界会二次校验（`server/src/validation.ts:9-19`）。

## 6. schema 与兼容迁移

- **旧档修复**：`save-logic.ts` 用字段级 `RULES` 表把非法值替换成上游的同一兜底（例如 `health` 夹到 0..5、`zoom` 夹到 1..2、`sound` 缺失时为 `true`），并把修复过的字段名 `console.warn` 出来（`src/shared/save-logic.ts:27-129`、`src/shared/save-logic.ts:228-242`）。上游 `config.json` 通过 `petInfoData` 取出，并删除 `machineId`/`oId`（`src/shared/save-logic.ts:245-250`）。
- **旧单档 → 文档**：无 `save.v2.json` 时依次尝试 legacy `save.json`、注入的 `initialSave`、全新存档（`src/shared/local-repository/host.ts:995-1000`）；迁移前先备份原始字节（`src/shared/local-repository/host.ts:1010-1012`）。
- **文档内版本修补**：载入时识别三类旧形态并在备份后补齐，同时给出 `notice`（`src/shared/local-repository/host.ts:951-992`）：`runtime.localDeviceId` 重复、缺 `idempotency`、事件历史缺 `revision`/`gameTimeMs`。`runtime.localDeviceId` 与 `device.localDeviceId` 不一致时直接失败关闭（`src/shared/local-repository/host.ts:958-967`）。
- **幂等缓存 v1→v2**：v1 用 `result: null` 表示「无返回值成功」，v2 用 `resultPresent` 区分；迁移把 v1 的 `null` 映射成 `resultPresent: false`（`src/shared/pet-runtime/idempotency.ts:104-140`）。
- **可携带包 v0→v1**：`migratePortablePetBundle`（`src/shared/sync/portable.ts:758`）与 `LegacyEngineStateV0` 的可选字段补齐（`src/shared/sync/portable.ts:144-163`）。
- **活动账本/常客字段**：`TaskProgress.festivalClaims`/`festivalStreak`/`festivalBadges` 是 `task` blob 内的可选字段，旧档缺失按 `{}` 读取；空字段不落盘，产生领取/常客记录后旧版本 `assertTaskBlob` 才会因未知键拒绝（详见 §13.2）。
- **损坏处理**：解析失败先 `backupDocument(text, 'corrupt')` 再 `preserveCorruptDocument(text)`，然后抛错并把状态切到 `read_only`，绝不覆盖（`src/shared/local-repository/host.ts:944-950`、`src/shared/local-repository/storage.ts:109-116`）。

## 7. 空档追赶

调度器以「整分钟」为单位推进：`due = wholeFixedTicksBetween(anchor, wallNow)`，`ticks = min(due, maxChunkTicks)`，默认分片 1440 分钟（`src/shared/pet-runtime/scheduler.ts:8-10`、`src/shared/pet-runtime/scheduler.ts:79-81`）；`advanceWhileEmpty === false` 且该分钟没有活跃客户端时冻结，并把锚点直接跳到下一个活跃时刻（`src/shared/pet-runtime/scheduler.ts:120-127`）。

宿主侧必须自己保证「不足一个整分钟不调用」：`advanceSchedulerChunk` 在 `due === 0` 时虽然 `ticks: 0`，仍会把 `lastSchedulerWallMs` 赋成传入的 `wallNowMs`（`src/shared/pet-runtime/scheduler.ts:140`）。便携宿主据此提前返回（`src/shared/local-repository/host.ts:1565-1569`，注释明说「1 秒轮询会持续吞掉整分钟 tick」）。

追赶的提交粒度：每一轮 clone 文档 → 推进一个分片 → 有 tick 才 `revision += 1` → 事件补 `eventSeq` → 原子写盘 → 让出事件循环，任一写盘失败立刻转 `read_only` 并停止调度器（`src/shared/local-repository/host.ts:1573-1623`）。轮询周期 1 秒、心跳落盘 10 秒（`src/shared/local-repository/host.ts:50-53`）。

> **已知缺陷**：桌面宿主 `src/main/local-repository.ts:969-976` 只有 `target <= anchor` 判断，而它的调度器是 1 秒 `setInterval`（`src/main/local-repository.ts:41`、`src/main/local-repository.ts:500-503`），按上一段契约，每个轮询都会把锚点推到 `now`，使 `wholeFixedTicksBetween` 恒为 0，游戏时间不前进。最小复现：固定时钟，`load()` 后每次把时钟 +1000ms 再调 `pump()`，`bundle.engine.gameTimeMs` 三次都不变，而 `lastSchedulerWallMs` 每次都跟着 `now` 走；把同样时钟推进喂给便携宿主 `src/shared/local-repository/host.ts` 则锚点不动。该路径无测试覆盖（`scripts/tests/local-repository.test.mjs:451-453` 用的是 2 分钟跳变）。修法与便携宿主一致：不足 `GAME_TICK_MS` 直接返回。

### 宿主状态机与命令准入

状态集合固定为 `loading | ready | catching_up | read_only | handoff_pending | suspended | stopped`（`src/shared/local-repository/host.ts:58-66`）。

| 状态 | 进入条件 | 能否 tick | 能否收命令 | 拒绝码 |
| --- | --- | --- | --- | --- |
| `loading` | 文档尚未载入 | 否 | 否 | `authority_not_active` |
| `ready` | 载入成功且权威 `active` 且 `owner === 'local'` | 是 | 是 | — |
| `catching_up` | 正在追赶空档分片 | 是（分片内） | 否 | `server_catching_up` |
| `read_only` | 权威非 active、迁移失败、写盘失败 | 否 | 否 | `authority_not_active` |
| `handoff_pending` | 权威交接中，本地被冻结 | 否 | 否 | `authority_not_active` |
| `suspended` | 显式 `suspend()` | 否 | 否 | `not_available` |
| `stopped` | 显式 `stop()` | 否 | 否 | `authority_not_active` |

拒绝逻辑逐状态短路（`src/shared/local-repository/host.ts:1306-1333`），只读判定集中在 `isReadOnly()`（`src/shared/local-repository/host.ts:860-869`）。任何一次写盘失败都会把状态切到 `read_only` 并停掉调度器（`src/shared/local-repository/host.ts:1454-1466`、`src/shared/local-repository/host.ts:1605-1613`），因此「只读」是失败关闭的终点，而不是可恢复的中间态——恢复要重新载入文档。

## 8. 幂等

- 键是 `(petId, deviceId, opId)`，记录只保存结果或错误，不复制引擎状态（`src/shared/pet-runtime/idempotency.ts:16-31`）。
- 同 `opId` 换命令类型 → `op_id_conflict`；同类型重放 → `duplicate`，并回放原始结果（成功或失败）（`src/shared/pet-runtime/idempotency.ts:258-281`）。
- 引擎与缓存必须**同一次写入**落盘：`persistDocument` 同时校验文档与 `PersistedRuntimeState`（`src/shared/local-repository/host.ts:1689-1695`）。分开写会造成「命令生效但重放被判重复/未生效」。
- 命令串行：`SerializedIdempotentExecutor` 显式拒绝重入（`BUSY`）并串行化并发调用（`src/shared/pet-runtime/idempotency.ts:304-341`）。
- 本地宿主的重复判定还要求记录的作用域与当前设备一致，跨设备同 `opId` 视为冲突（`src/shared/local-repository/host.ts:1344-1362`）。

## 9. 不变量

1. 运行时不持有宿主状态；同一 `EngineState` + 同一命令/上下文必得同一 `RuntimeOutcome`。
2. RNG 只会经 `RuntimeRng` 推进，且游标随文档持久化（`src/shared/pet-runtime/rng.ts:39-64`）。
3. 命令被拒绝时 `revision` 不变、`eventSeq` 不变（`src/shared/local-repository/host.ts:1438-1439`）。
4. 提交前必须通过 `assertEngineState` 与 `assertLocalPetDocumentV2`（`src/shared/pet-runtime/runtime.ts:146`、`src/shared/local-repository/host.ts:1690`）。
5. 暂停/死亡/埋葬期间活动与边界整体延后，不产生事件（`src/shared/pet-runtime/tick.ts:385-401`）。
6. 追赶只按整分钟推进，锚点不得停在非整分钟（便携宿主 `src/shared/local-repository/host.ts:1565-1569`；桌面宿主当前不满足，见 §7）。
7. 权威非 `active` 时宿主进入只读：不 tick、不收命令（`src/shared/local-repository/host.ts:860-869`、`src/shared/local-repository/host.ts:1334-1343`）。
8. 设备本地字段永不进入共享态（`src/shared/sync/data-boundary.ts:24-81`）。

## 10. 失败模式

| 现象 | 触发 | 表现 | 定位 |
| --- | --- | --- | --- |
| 启动后宠物数值不动 | 锚点被非整分钟轮询推走（§7） | `gameTimeMs` 不变、无事件 | `src/main/local-repository.ts:969-976` |
| 命令返回 `invalid_payload` | 载荷/opId 形状非法 | 不写盘、不改 revision | `src/shared/pet-runtime/idempotency.ts:62-65` |
| 命令返回 `op_id_conflict` | 同 opId 换了命令类型 | 原记录保留 | `src/shared/pet-runtime/idempotency.ts:259-270` |
| 命令返回 `server_catching_up` | 追赶进行中 | 需等追赶结束再试 | `src/shared/local-repository/host.ts:1320-1326` |
| 进入 `read_only` 且 `notice` 指向迁移 | 文档损坏/身份不一致/写盘失败 | 保留 `save.v2.json.corrupt-N` | `src/shared/local-repository/host.ts:944-967`、`src/shared/local-repository/host.ts:1454-1466` |
| 存档字段被悄悄改值 | 命中 `RULES` 兜底 | 控制台打印 `repaired save fields:` | `src/shared/save-logic.ts:253-257` |
| 关闭后数据回退 | 未等 `flush()` 完成就退出 | 最后一批命令丢失 | `src/shared/local-repository/host.ts:468-483` |

## 11. 验证命令

预期退出码 `0`。

```bash
# 纯函数运行时的行为固定（抽签顺序、事件顺序、任务结算）
node --experimental-strip-types --test scripts/tests/pet-runtime-c3.test.mjs
node --experimental-strip-types --test scripts/tests/pet-runtime-c4a.test.mjs
node --experimental-strip-types --test scripts/tests/pet-runtime-c4b.test.mjs

# 存档文档、迁移、幂等、追赶
node --experimental-strip-types --test scripts/tests/local-repository.test.mjs
node --experimental-strip-types --test scripts/tests/save-write.test.mjs

# 疯狂星期四：日期规则、任务注入、邮件、领奖账本
node --experimental-strip-types --test scripts/tests/pet-runtime-festival.test.mjs

# 疯狂星期四体验补强：菜单/台词/分享卡/四周常客/渲染层接线
node --experimental-strip-types --test scripts/tests/pet-runtime-festival-v2.test.mjs
node --experimental-strip-types --test scripts/tests/festival-ui.test.mjs

# 类型与全量
npm run typecheck
npm run test:compat
```

通过标准：每个测试文件 `fail 0`，且 `pass` 数等于用例数；`npm run typecheck` 无输出。历史验收记录见 [C12 final gate](../reviews/c12-final-gate/2026-11-18-c12-final-gate.md)。

## 12. 变更影响

- **改 tick 顺序或抽签次数**：等于改历史结果，必须同时更新 `scripts/tests/pet-runtime-*.test.mjs` 的期望值，并在文档里记录新顺序；旧存档会从改动点开始产生不同未来。
- **新增 `EngineState` 字段**：要同时改 `src/shared/pet-runtime/types.ts`、`assertEngineState`（`src/shared/sync/portable.ts:494`）、`src/shared/sync/portable.ts` 的 `ENGINE_STATE_KEYS`，否则新字段会被序列化校验拒绝。
- **新增存档字段**：`SaveData`（`src/shared/save.ts:161-178`）、`RULES` 兜底（`src/shared/save-logic.ts:27-129`）、`SHARED_/DEVICE_` 白名单（`src/shared/sync/data-boundary.ts:51-81`）三处必须一起改，否则字段要么被修复表丢掉，要么跨设备泄漏。
- **改幂等语义**：会动 `src/shared/pet-runtime/idempotency.ts` 的 schema 版本与 `src/shared/sync/protocol.ts` 的错误码，需同步服务端 `server/src/command-service.ts` 的重复判定。
- **改追赶分片**：`CATCHUP_CHUNK_TICKS`（`src/shared/pet-runtime/scheduler.ts:10`）与服务端 `catchupChunkTicks`（`server/src/config.ts:132`）需一致，否则两端追赶进度不可比。
- **修 §7 的桌面锚点缺陷**：属于运行时契约修正，需补一条「1 秒轮询 60 次后 `gameTimeMs` 前进 60 秒」的回归测试。
- **改节日规则/任务或邮件注入**：`src/shared/pet-runtime/festival.ts` 是唯一规则源；改动会改变每日任务表长度、邮件生成、宠物台词、分享卡或常客进度，必须同步 `scripts/tests/pet-runtime-festival.test.mjs`、`scripts/tests/pet-runtime-festival-v2.test.mjs`、`scripts/tests/festival-ui.test.mjs` 与本文 §13；`TaskProgress` 字段变化还必须同步 `src/shared/sync/data-boundary.ts` 的 `assertTaskDefinitionBlob`/`assertTaskBlob`/`assertFestival*Blob`。

历史设计取径见冻结文档 [local-or-server pet data design](../reviews/legacy/2026-10-20-local-or-server-pet-data-design.md)（只读）。

## 13. 节日规则（KFC 疯狂星期四）

> 结论：`src/shared/pet-runtime/festival.ts` 是 KFC 疯狂星期四的唯一规则源——纯函数只吃调用方切好的 `dayKey`，输出 `preview`/`active` 阶段、周序号、四变体任务、本周菜单、宠物台词、分享卡 SVG、邮件定义与活动物品；活动不新增 `CalendarInput`/`CalendarDay`/IPC 字段，local v2 与服务端共用同一规则，legacy 渲染层回退不承载活动。

### 13.1 纯函数与日期规则

- `festivalDayForDayKey(dayKey, options?)`（`src/shared/pet-runtime/festival.ts:181-193`）：星期由 `parseDayKey` + `Date.UTC` 计算（`src/shared/pet-runtime/time.ts:77-90`），不读系统时间/时区数据库。周四且 `dayKey >= enabledFrom` 返回 `active`；周三且 `addDaysToDayKey(dayKey, 1) >= enabledFrom` 返回 `preview`；其余返回 `null`。`enabledFrom = '2026-12-03'`，所以 2026-12-02 是 preview、2026-12-03 是 active、2026-12-04（周五）与其他普通日期是 null；`CRAZY_THURSDAY.enabled === false` 时任何日期都返回 null。
- `options.rehearsal` 只供测试/演练：2026-11-25 返回 preview、2026-11-26 返回 active；默认调用不传。
- `weekAnchorDayKey(dayKey)`（`src/shared/pet-runtime/festival.ts:196-198`）：返回该日所在周的周四，周起点固定为周一（`getUTCDay() || 7`，偏移 `4 - weekday`）。`festivalWeekIndex(dayKey)`（`festival.ts:201-206`）先用 `weekAnchorDayKey` 归到目标周四，再从首跑周四 2026-12-03 起每 7 天 +1，对 4 取模后 +1 得 1-4；周三是 preview 日时 `weekAnchorDayKey` 会映射到次日周四；负差用 `((x % 4) + 4) % 4` 修正，跨年（2026-12-31）仍是第 5 次循环 → 第 1 变体。
- `CRAZY_THURSDAY`（`festival.ts:101-151`）固定 `activityId = 'EVT-T2-20261203-01'`、`codeKey = 'weekly-special-day'`、`name = 'KFC 疯狂星期四 · 企鹅特供日'`、`weekday = 4`、`enabledFrom = '2026-12-03'`、`loginMail = { yb: 30, food: 2, toy: 0 }`、`taskReward = { yb: 100, food: 3, toy: 1 }`、`maxBoxValue = 400`、`enabled = true`、`streakWeeks = 4`、`badgeTitle = '疯狂星期四常客'`、`badgeGoodId = '900001'`。玩家可见名、四变体任务文案、台词与徽章标题从这里派生。
- 四个快动作变体按 `festivalWeekIndex` 轮换（`festivalVariantForDayKey`，`festival.ts:209-212`）：`eat-3`（`Eat` 3 次，第 1 周）、`amuse-20`（`Amusing` 20 次，第 2 周）、`toy-3`（`Toy` 3 次，第 3 周）、`clean-2`（`Clean` 2 次，第 4 周）；四变体无等级门槛，`fallbackVariantId = 'amuse-20'` 当前是配置常量。
- `festivalMenuForDayKey(dayKey, options?)`（`festival.ts:218-239`）：preview 取次日周四的变体、active 取当日变体，返回 `{ dayKey, phase, variantId, label, obj, num, food: 3, toy: 1, text }`；`text` 形如「本周菜单：<label>。KFC 疯狂餐盒含 3 食物 + 1 玩具…」，普通日期返回 null。邮件正文、任务预览与分享卡共用这份菜单文案。
- `festivalLineForDayKey(dayKey, options?)`（`festival.ts:251-260`）：preview 返回周三预告台词、active 按当周变体返回四条任务进行中台词之一，其余 null；`festivalLingerLineForDayKey(dayKey)`（`festival.ts:263-268`）：周五且 `weekAnchorDayKey(dayKey) >= enabledFrom` 返回余韵台词，其余 null。
- `festivalTaskForDayKey(dayKey, save, rng)`（`festival.ts:334-353`）：仅 `active` 日返回 `TaskDefinition`，`label/msg/obj/num` 取自当周变体，另带 `festivalId = activityId`、`festivalIssueWeek = weekAnchorDayKey(dayKey)`；`good` 在生成时固定为 `_yb*N` + 3 个食物 + 1 个玩具（食物/玩具每项 `num=1`），`N = scaleYbForDifficulty(save, 100)`：easy 100、standard `max(1, round(100 × 0.4)) = 40`（`src/shared/pet-runtime/runtime-helpers.ts:498-500`）。奖励生成后不随难度切换变化。
- `festivalMailGoods(save, spec, rng)`（`festival.ts:315-331`）：按 `{ yb, food, toy }` 抽附件；食物池为 `5 <= price <= 150`、玩具池为 `16 <= price <= 120`，均排除 `outOfPrint`/`PD`，食物/玩具每项 `num=1`；物品总价超过 `maxBoxValue` 时最多重抽 3 次，仍超则取池内最低价组合；元宝走 `scaleYbForDifficulty`。
- `festivalMailForDayKey(dayKey, options?)`（`festival.ts:356-378`）：preview 返回无附件预告（`goodsSpec: null`），active 返回登录礼（`goodsSpec = loginMail`）；key 分别为 `crazy-thursday-preview-<dayKey>` 与 `crazy-thursday-<dayKey>`；标题是 `festival.ts` 内的字面量，`moodMessage` 在原有心情文案后追加 `festivalMenuForDayKey` 的菜单正文，标题不因补正文而改变。
- `festivalShareCardSvg(input)`（`festival.ts:465-493`）：返回 600×800 的 SVG 字符串，含活动标题、宠物名、台词与逐件物品名/数量；宠物名按约 16 字宽、台词按约 26 字宽拆 `<tspan>` 多行，超长物品名用 `textLength` 压缩，所有玩家文本做 XML 转义，不依赖 DOM/canvas。`festivalMilestoneGood()`（`festival.ts:496-499`）返回 `goodOf('toy', '900001')`，即 `goods.json` 的非卖品「疯狂星期四纪念玩具」（`price = -1`）。
- 本模块只 import `SharedSaveData`、`content`、`runtime-helpers`、`time`；不 import `CalendarInput`、IPC 或宿主能力。`CalendarInput`/`CalendarDay` 契约保持不变，`src/shared/pet-runtime/index.ts:5` 导出该模块供宿主使用。

### 13.2 `TaskDefinition` / `TaskProgress` 扩展与常客进度

- `TaskDefinition`（`src/shared/pet-runtime/runtime-helpers.ts:153-165`）新增两个可选字段：`festivalId?: string`、`festivalIssueWeek?: string`；普通每日/静态任务不带这两个字段，仍按原逻辑生成与领取。
- `TaskProgress`（`:167-178`）新增三个可选字段：`festivalClaims?: Record<string, Record<string, true>>`（activityId → issueWeek → 已领取）、`festivalStreak?: Record<string, number>`（activityId → 连续参与周数，正整数）、`festivalBadges?: Record<string, string>`（activityId → 徽章标题）。
- `defaultTaskProgress()`（`:255-265`）返回三个空对象；`readTaskProgress()`（`:267-284`）对缺失字段回填 `{}`；`writeTaskProgress()`（`:286-299`）序列化前删除空的 `festivalClaims`/`festivalStreak`/`festivalBadges`——空字段不落盘，普通存档字节与旧 golden 保持一致，产生记录后才写入。
- `resetDailyTasks()`（`src/shared/pet-runtime/runtime-tasks.ts:192-214`）构造 `next` 时复制三个字段：每日 06:00 重掷 `daily`、重置 `entry.take` 不丢账本，这是同一 `issueWeek` 不能重复领奖、连续四周不被日切打断的关键。
- `festivalStreakForClaim(previousStreak, claimedWeeks, issueWeek)`（`festival.ts:505-518`）：以 `festivalClaims` 账本为唯一权威，从 `issueWeek` 的前一周开始逐周回数，断周重置为 1；`previousStreak` 仅为旧档兼容保留、不参与计算（避免缓存值高于账本时提前授勋）；旧档没有 `festivalStreak` 时也能按账本补算（例如已有 12-03/12-10/12-17 三周连续记录、streak=0，12-24 领取后为 4）。
- `claimTaskReward`（`src/shared/pet-runtime/handlers-c.ts:148-222`）：在 `entry.take` 检查后、发奖前，若 `definition.festivalId` 存在则检查 `progress.festivalClaims[activityId][issueWeek] === true`，命中返回 `already_claimed`；领取成功写本周账本并按 `festivalStreakForClaim` 更新 `festivalStreak`。当 `streak >= CRAZY_THURSDAY.streakWeeks`（4）且该活动尚无徽章时，写入 `festivalBadges[activityId] = '疯狂星期四常客'` 并通过 `festivalMilestoneGood()` 发放 1 个 `toy/900001`；`task.claimed` payload 在特供任务上带 `festivalId`、`festivalStreak`，首次授勋时带 `festivalBadge`。重复领取被 `entry.take`/账本拦截，纪念物不重复发；`reward.granted` 对任务本体按 `entry.good.length` 计数，第四周纪念物另发一条 `{ source: 'festival-milestone', count: 1 }`，避免审计少计。
- `toy/900001`「疯狂星期四纪念玩具」在 `src/shared/pet-runtime/content/goods.json` 与 `src/renderer/pet/data/goods.json` 的 `toy` 段：`type=toy`、`price=-1`、`needLevel=0`、`mood=100`，复用现有铃铛图标；只作为第四周常客奖励直接 `grantGoods`，不进入商店与活动奖池，也不计入活动餐盒预算。
- 边界校验：`assertTaskDefinitionBlob`（`src/shared/sync/data-boundary.ts:762-775`）的 allowlist 接受两个新键并校验为可选字符串；`assertTaskBlob`（`:810-836`）接受 `festivalClaims`/`festivalStreak`/`festivalBadges`，`assertFestivalClaimsBlob`（`:783-792`）要求两层 `Record` 且叶子严格为 `true`，`assertFestivalStreakBlob`（`:794-801`）要求正整数，`assertFestivalBadgesBlob`（`:803-808`）要求字符串。
- 旧档兼容：缺少三个字段的旧档按 `{}` 读取（`festivalStreak` 缺失时由 `festivalClaims` 补算）；`daily` 多出的第 5 条任务对通用读取方只是普通 `TaskDefinition`（`ensureTaskTables` 只检查 `daily.length === 0`、`taskList.daily.length < daily.length` 或 `dailyDay` 不一致，`src/shared/pet-runtime/runtime-tasks.ts:172-190`）。空字段不写入 `task` blob，普通存档字节与旧 golden 保持一致；一旦产生活动领取记录，`task` blob 会带非空 `festivalClaims`/`festivalStreak`/`festivalBadges`，旧版本运行时的 `assertTaskDefinitionBlob` allowlist 不认识 `festivalId`/`festivalIssueWeek`，活动日 `daily` 中的第 5 条会以 `forbidden_field` 被拒绝；`assertTaskBlob` 也不认识非空的活动字段（`src/shared/sync/schema.ts:152-156`）。回滚到旧版本前需清理活动任务/账本字段或使用包含兼容校验的版本；本实现让普通存档保持旧字节，`RUNTIME_SCHEMA_VERSION` 仍为 1（`src/shared/pet-runtime/types.ts:4`）。

### 13.3 每日任务注入顺序

- `rollDailyTasks(save, gameTimeMs, timeZone, rng, calendarDay?)`（`src/shared/pet-runtime/runtime-tasks.ts:66-113`）先用 `dayKeyAt(gameTimeMs, timeZone)` 得到当日 `dayKey`，再固定按以下顺序组装 `daily`：4 条日常任务 →（若 `festivalTaskForDayKey` 返回非 null）特供任务 →（若 `calendarDay.holiday.off`）法定节假日额外任务。因此活动日特供任务固定落在 `daily[4]`，同时是节假日时假日任务落在 `daily[5]`。
- 无活动日期（普通日、周五、首跑前）`festivalTaskForDayKey` 返回 null，`daily` 仍为 4 条（节假日 5 条）；preview 日不生成任务。
- `daily` 与 `taskList.daily` 同步写入：`daily[4].good` 的 `_yb*N` 与物品 code 在生成时解析成 `TaskEntry.good`（`runtime-tasks.ts:106-109`），任务预览与实际发奖同源。
- `ensureTaskTables()`（`:172-190`）在首次 tick/领取时补齐缺失表，`resetDailyTasks()`（`:192-214`）在每日 06:00 边界重掷；两者都走同一 `rollDailyTasks`，注入顺序只有一处。
- legacy 回退：`src/renderer/pet/tasks.ts:250-269` 的 `rollDaily` 不 import `festival.ts`，不生成特供任务；`src/renderer/pet/mail.ts:67-82` 的 `deliverMails` 也不生成活动邮件。legacy 只保证普通任务/邮件不回归，活动奖励与活动账本（`festivalClaims`/`festivalStreak`/`festivalBadges`）只在 shared 运行时（local v2/server）生效。

### 13.4 邮件注入

- `tick.ts` 的 `deliverMails(state, boundaryMs, dayKey, rng)`（`src/shared/pet-runtime/tick.ts:83-129`）在每个 06:00 日边界调用；普通欢迎/生日/法定节假日邮件保持原有顺序与奖励（`tick.ts:88-98`），之后追加 `festivalMailForDayKey(dayKey)` 的返回项。`DueMail.goodsSpec` 区分三种附件：缺省走普通 `mailGoods`、`null` 无附件、对象走 `festivalMailGoods`（`tick.ts:74-81`、`:120-122`）。
- preview 邮件 key 为 `crazy-thursday-preview-<dayKey>`（如 `crazy-thursday-preview-2026-12-02`），`glb: []`，无奖励，`moodMessage` 带本周菜单预告；active 邮件 key 为 `crazy-thursday-<dayKey>`（如 `crazy-thursday-2026-12-03`），`glb = festivalMailGoods(save, loginMail, rng)` = easy 30 / standard 12 元宝 + 2 份活动食物（每份 1 个），无玩具，正文为心情文案加本周菜单。
- 邮件去重沿用 `deliverMails` 的「同 `k` 不重发」检查（`tick.ts:110-127`）：删除邮件保留 `k`，不会复活；同一天多次边界检查只投一封。离线追赶按每个跨过的 06:00 边界分别调用，`dayKey` 按边界日期生成对应 key。
- 桌面邮件列表用 `e_body` 显示 `m` 正文（`src/renderer/ui/email.ts:90`、`src/renderer/ui/css/email.css:40-52`），手机详情同源读取（`src/renderer/ui/mobile/phone-email.ts:166`）；单封领取 active 活动邮件会进入开餐盒结果面板，`fromBulk` 触发的批量领取/删除不弹窗（见 §13.6）。
- `mail.claim` 仍用 `mail.r` 幂等（`src/shared/pet-runtime/handlers-d.ts:143-159`），活动邮件无特殊分支。
- legacy 回退的 `src/renderer/pet/mail.ts` 不调用 `festivalMailForDayKey`，不生成活动邮件；普通邮件逻辑不变。

### 13.5 旧档兼容与回滚

| 场景 | 行为 |
| --- | --- |
| 旧档无 `festivalClaims`/`festivalStreak`/`festivalBadges` | `readTaskProgress` 全部回填 `{}`；空字段不落盘，首次活动领取后才写入；`festivalStreak` 缺失时按 `festivalClaims` 的连续周补算。 |
| 旧档 `daily` 只有 4 条 | 通用 `ensureTaskTables` 按 `dailyDay` 判断是否需要重掷；非活动日仍 4 条。 |
| 活动日 `daily` 有 5/6 条 | 第 5 条带 `festivalId`/`festivalIssueWeek`，通用读取方按普通任务显示/领取；`task.claim` 索引路径不变。 |
| 第四周领取 | `festivalClaims` 写入第 4 周、`festivalStreak = 4`、`festivalBadges` 写入「疯狂星期四常客」，背包新增 1 个 `toy/900001`；同一任务重领返回 `already_claimed`，纪念物不重复发。 |
| 新档给旧版本读 | 活动日的第 5 条任务带 `festivalId`/`festivalIssueWeek`，领取过的存档带非空 `festivalClaims`/`festivalStreak`/`festivalBadges`；旧版 allowlist 不认识这些键，报 `forbidden_field`；跨版本回滚需清理活动任务/账本或带兼容 shim。 |
| `CRAZY_THURSDAY.enabled = false` | `festivalDayForDayKey` 对任何日期返回 null，不再生成新任务/邮件；已生成任务当天仍可按普通 `TaskDefinition` 领取，已发奖励保留。 |
| 删除活动邮件 | `k` 保留，不再重发。 |

### 13.6 渲染层体验接线

- 开餐盒演出：`showResult(host, goods, msg, options)`（`src/renderer/ui/result.ts:26-57`）在 `options.festival === true` 时给容器加 `festival-result`，`src/renderer/ui/css/result.css:6-25` 用 `@keyframes festival-box-open` 做轻量弹入（`prefers-reduced-motion` 下关闭），并在有物品时追加「晒餐盒」按钮；普通任务/邮件不传 options，行为不变。
- 任务领取接线：`src/renderer/ui/task.ts:32-45` 与 `src/renderer/ui/mobile/phone-task.ts:49-65` 只在 `festivalId` 存在时传 `{ festival: true, shareText: msg }`；`TaskRow.festival` 由 `src/renderer/ui/mobile/phone-pages-model.ts:165-182` 派生。
- 邮件领取：`src/renderer/ui/email.ts:34-67` 只有单封领取且 key 为 active 活动邮件（`result.ts:15-23` 的 `isFestivalActiveMailKey`，排除 preview 前缀）时弹结果面板；`phone-email.ts:68-116` 同语义。一键领取/删除通过 `fromBulk` 参数排除单个结果面板，不逐个弹窗。
- 晒餐盒分享卡：`openFestivalShareCard(line, goods)`（`src/renderer/ui/share-card.ts:13-32`）用 `festivalShareCardSvg` 生成 SVG data URL，经 `windowView` 的 `image` 大图分支（`src/renderer/ui/window-view.ts:10-11`、`:35-36`，样式 `src/renderer/ui/css/window.css:166-207`）按 600×800 等比展示（长按/右键保存），不再走 50×50 物品缩略图；纯本地、不接社交平台，宠物名为空时兜底「企鹅」。
- 宠物台词：`src/renderer/pet/calendar.ts:72-108` 的 `festival()` 先查 `festivalLineForDayKey` / `festivalLingerLineForDayKey`，命中即优先于普通节日/节气文案；若 `task` blob 的 `festivalBadges[activityId]` 存在则改说常客自我介绍（`calendar.ts:58-70`）。
