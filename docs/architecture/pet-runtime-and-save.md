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

历史设计取径见冻结文档 [local-or-server pet data design](../reviews/legacy/2026-10-20-local-or-server-pet-data-design.md)（只读）。
