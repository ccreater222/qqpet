# 同步协议（服务端权威）

> 结论：桌面版与 `qqpet-server` 之间只有一条 JSON over WebSocket 的语义通道，协议版本固定为 `1`（`src/shared/sync/protocol.ts:12`）。服务端是唯一权威：客户端上行只允许 `hello`、`command`、`commandStatus`、`exportBundle`、`resync`、`ping` 六种帧（`src/shared/sync/protocol.ts:441`），业务状态只能由服务端下行；鉴权、协议版本、权威代次（epoch）、恢复世代（restoreGeneration）、连续事件游标任何一个不匹配都直接关闭连接或整体重发快照，不做部分修补。客户端展示数据（更新检查、天气、农历/节假日、内容包索引与文件）不占用这条通道，走服务端公开只读的 `GET /v1/client/*` HTTP 端点（见第 12 节）。

## 1. 传输与端点

- 端点只接受 `/sync` 与 `/v1/sync`，其它路径在 HTTP Upgrade 阶段回 404 并断开（`server/src/index.ts:155-160`）。
- 预鉴权连接数超过 `maxPreAuthConnections`（默认 64）时回 429，不进 WebSocket（`server/src/index.ts:161-165`、`server/src/config.ts:141-146`）。
- `ws` 层 `maxPayload = maxFrameBytes + 1`，禁用 `perMessageDeflate`（`server/src/index.ts:146-154`）。多出的 1 字节是为了让应用层先看到超限帧并给出协议级关闭码，而不是被解析器直接掐断。
- `ws` 的 `1009` 关闭码被重写成协议默认的 `4005 payload_too_large`（`server/src/index.ts:170-185`）。
- 桌面客户端用运行时全局 `WebSocket`（Electron 主进程的 Node 22），**不 import `ws`**，移动端因此可以整块摇掉远程路径（`src/main/remote-websocket-transport.ts:26-33`）；连接前先用 `assertRemoteServerUrl` 校验 URL（`src/main/remote-websocket-transport.ts:35-37`）。
- TLS/WSS 由反向代理终止，代理链路契约由 `npm run smoke:proxy` 覆盖（见 `docs/reviews/c12-final-gate/2026-11-18-c12-final-gate.md`）。

## 2. 协议版本

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `PROTOCOL_VERSION` | `1` | `src/shared/sync/protocol.ts:12` |
| `SAVE_SCHEMA_VERSION` | `1` | `src/shared/sync/protocol.ts:13` |
| `PORTABLE_BUNDLE_SCHEMA_VERSION` | `1`（格式 `qqpet-portable-v1`） | `src/shared/sync/portable.ts:50-51` |
| `LOCAL_DOCUMENT_SCHEMA_VERSION` | `1`（格式 `qqpet-local-v2`） | `src/shared/sync/portable.ts:52-53` |

版本不合的处理是**关闭连接**而不是降级：`hello.v !== PROTOCOL_VERSION` 直接以 `4001 protocol_mismatch` 关闭（`server/src/session.ts:392-395`）；已鉴权后收到版本不合的帧同样以 `4001` 关闭（`server/src/session.ts:312-320`）。服务端在 `welcome` 里回传自己的 `protocolVersion` 与服务端 `saveSchemaVersion`，客户端据此记录（`server/src/session.ts:458-459`）。

协议校验器 `parseClientMessage`/`parseServerMessage` 是唯一入口：它检查方向、消息类型白名单、需要 `requestId` 的消息是否带 `requestId`、事件流是否单调、payload 是否 JSON 安全且不含禁止字段（`src/shared/sync/protocol-validation.ts:34-44`、`src/shared/sync/protocol-validation.ts:60-94`）。客户端发帧前也先自检一次（`src/main/remote-repository.ts:763-769`），避免把非法帧送到线上。

## 3. hello 与鉴权

`ClientHello`（`src/shared/sync/protocol.ts:204-217`）字段：`v`、`requestId`、可选 `petId`/`deviceId`、可选 `lastRevision`/`lastEventSeq`、`appVersion`、可选 `cachedAuthority{authorityId,restoreGeneration,epoch}`、`auth`。

`auth` 两条互斥路径：

1. `{ kind: 'token', token }`：用设备 token 全局定位设备；设备不存在、已撤销、或 `hello.petId`/`hello.deviceId` 与记录不一致都算认证失败（`server/src/auth.ts:23-40`）。撤销的设备抛专用 `RevokedDeviceError`，服务端记 `auth.revoked` 指标（`server/src/auth.ts:26-30`）。
2. `{ kind: 'pairing', code, deviceLabel }`：配对码必须存在、未使用、未过期，且此时 `hello` 不得带 `deviceId`（`server/src/auth.ts:41-56`）。消费配对码与创建设备在**同一事务**内完成，明文 token 只在这一帧返回一次（`server/src/auth.ts:69-80`、`src/shared/sync/protocol.ts:240-241`）。

握手顺序是刻意的（`server/src/session.ts:403-445`）：`identify`（只读）→ 每宠物连接上限 → `loadCanonical` → 权威问题判定 → 才 `authenticate`（配对码在这一步才被消费）→ 开覆盖区间 → 入 hub → 发 `welcome`。也就是说权威异常的连接不会消耗掉一个配对码。

每条命令执行前还会重新检查设备（`server/src/command-service.ts:147`、`server/src/auth.ts:83-91`），撤销后的下一帧即失效，不必断开连接也能兜住。

## 4. 命令权限

- 命令角色表由 `COMMAND_ROLES` 决定，`commandRole(type)` 返回 `player | owner`（`src/shared/sync/command-validation.ts:236-242`）。
- 服务端先拒 `owner` 命令的非 owner 设备：`unauthorized`（`server/src/command-service.ts:177-183`）。
- 运行时再拒一次（`src/shared/pet-runtime/runtime.ts:181-187`），这是纵深防御，不是冗余：本地/服务端共用同一份规则，任何一侧漏判都不会让 owner 命令被执行。
- `observedRevision > 服务端 head` 视为客户端看到了不存在的未来，返回 `invalid_payload` 并要求刷新投影（`server/src/command-service.ts:225-231`）。
- 追赶期间整条命令被拒：`server_catching_up` 且 `refreshProjection: true`（`server/src/command-service.ts:184-190`）。
- 权威非 `active`：`authority_not_active`（`server/src/command-service.ts:218-224`）。
- `device.list` / `device.revoke` 属于服务端设备治理，不进入游戏运行时（`server/src/command-service.ts:232-239`）。
- 命令有独立限流：默认 10 次/秒、突发 20（`server/src/config.ts:122-123`），超限以 `4003 rate_limited` 关闭连接（`server/src/session.ts:358-372`）。

## 5. revision / eventSeq / commandSeq

- 每个宠物行携带 `revision`、`eventSeq`、`commandSeq`；`commandSeq` 用乐观并发写入：`UPDATE pets SET command_seq = ? WHERE id = ? AND command_seq = ?`，`changes !== 1` 即抛 `command_sequence_conflict`（`server/src/command-service.ts:255-259`）。
- 命令成功后服务端把本批事件按 `eventSeq` 递增写入事件表，并通过 hub 广播 `projection`，同时携带这批事件（`server/src/hub.ts:78-103`）。
- `eventSeq` 必须连续：客户端只有在「本次投递的事件刚好把游标填满且末位等于 `projection.eventSeq`」时才应用，否则升级成全量 `resync`；比当前游标更旧的投递判 `stale` 丢弃（`src/shared/renderer-api.ts:216-256`）。
- 重复命令（同 `opId` 同类型）返回原结果并标记 `duplicate`，**不推进** `revision`/`eventSeq`（`server/src/command-service.ts:148-175`）；同 `opId` 不同命令返回 `op_id_conflict`。
- 客户端把 `commandSeq` 当成「该设备在该宠物上的第几条命令」的展示序号，由服务端回填，不能让客户端自增。

## 6. 权威代次、交接与恢复世代

权威身份由两层结构描述：

- `AuthorityStamp`：`owner`、`authorityId`（血缘 UUID，只在操作员恢复/回滚时变）、`epoch`、`restoreGeneration`、`revision`、`eventSeq`、`handoffId`、`detachedAtWallMs`（`src/shared/sync/portable.ts:59-69`）。
- `WireAuthority`：`owner`、`authorityId`、`restoreGeneration`、`epoch`、`state: 'active' | 'archived' | 'reset'`（`src/shared/sync/portable.ts:71-77`）。

握手时客户端把缓存的三元组放进 `cachedAuthority`，服务端据此判定（`server/src/session.ts:739-752`）：

| 判定 | 条件 | 结果 |
| --- | --- | --- |
| `cache_newer` | 客户端 epoch > 服务端 epoch | 发 `authorityResetRequired` 后以 `4002 authority_reset_required` 关闭 |
| `restore_rollback` | `restoreGeneration` 不等，或服务端 `state === 'reset'` | 同上 |
| `authority_mismatch` | `authorityId` 不同 | 同上 |
| 正常 | 三项都匹配 | 进入投递计划 |

`authorityResetRequired` 帧带 `reason`、`requireFullSnapshot: true` 和新权威戳（`server/src/session.ts:754-781`）。客户端收到后清掉缓存权威并以 `discardCachedAuthority: true` 重连/重同步（`src/main/remote-repository.ts:1682-1692`、`src/main/remote-repository.ts:1809`）；即使连接先断，`4002` 的 `authority_reset_required`/`superseded` 也会保留「下次 hello 不带 cachedAuthority」的意图（`src/main/remote-repository.ts:1916-1921`）。

交接（本地 ↔ 服务端）会推进 epoch：`nextEpoch = authority.epoch + 1` 并生成新的 `handoffId`（`server/src/command-service.ts:451`、`server/src/command-service.ts:540-548`）。因此 epoch 只增不减，客户端拿到更大的 epoch 就必须整体重放，不能沿用旧缓存。

## 7. 投递计划与 resync

`hello` 之后服务端给出四选一的 `delivery`（`server/src/session.ts:486-523`）：

| 条件 | delivery |
| --- | --- |
| 权威 `archived` | `none`（只允许状态帧，不给存档/事件） |
| 权威 `reset` | `snapshot` |
| 客户端游标与 head 一致 | `none` |
| `lastEventSeq >= head` | `snapshot` |
| 缺失事件数 > `maxReplayEvents`（默认 10000） | `snapshot` |
| 事件不连续或回放帧超 `maxFrameBytes` | `snapshot` |
| 其余 | `replay`；`revision` 不齐时是 `replay+snapshot` |

关键约束写在代码注释里：`ready` 绝不能让客户端越过被截断回放里省略的事件（`server/src/session.ts:480-485`）。回放事件逐条过 `assertPublicEvent`（`server/src/session.ts:525-540`），不合规就不会被发出去。

主动重同步：客户端发 `resync{lastRevision?,lastEventSeq?,discardCachedAuthority?}`，服务端回 `snapshot` + `ready`；权威 `archived` 时只回 `ready`，不允许用 resync 绕过握手期的投影闸门（`server/src/session.ts:578-588`）。`resync` 与 `exportBundle` 走更严的限流（2 次/秒、突发 4，`server/src/session.ts:38-41`、`server/src/session.ts:334-353`）。

## 8. 失败关闭

- 服务端启动前先校验恢复世代文件、把所有宠物的权威状态解码一遍，任一损坏就不监听端口（`server/src/index.ts:193-209`）。
- 投影出口做终检：`assertPublicSave` 拒绝设备本地字段与任何 never-upload 字段，`assertPublicEvent` 拒绝事件里的同类内容；失败时记 `projection.boundary_rejected` 并**丢弃该次广播**（`server/src/hub.ts:82-88`、`server/src/validation.ts:9-19`）。
- 下行帧超过 `maxFrameBytes` 时直接以 `4005` 关闭连接，不发截断内容（`server/src/session.ts:787-795`）。
- 客户端把认证/协议错误视为终态：`auth_failed`/`protocol_mismatch` 立即 `terminalFailure` 并断开，不重试（`src/main/remote-repository.ts:1730-1734`）；关闭码 `4000`/`4001` 同样终态（`server/src/session.ts:31-32`、`src/main/remote-repository.ts:1897-1907`）。
- 设备被撤销：服务端广播 `deviceRevoked` 并以 `4002 revoked` 关闭该设备的连接（`server/src/hub.ts:109-124`）；客户端丢弃投影缓存并标记 `device_revoked`（`src/main/remote-repository.ts:1908-1915`）。
- 缓存只读启动：server 模式已配对且存在通过校验的 `RemoteProjectionCacheV2` 时，`RemoteRepository.start()` 不等待 ready，直接返回缓存投影并继续后台拨号/重连（`src/main/remote-repository.ts:412-444`、`src/main/remote-repository.ts:669-674`）。缓存不是权威：状态 `readOnly` 为真，`command()` 在 online 前仍返回 `offline`/`server_catching_up`，也不会写规范状态；没有缓存时保持原有的等待 ready 语义。
- 空闲与心跳：`pingIntervalMs` 默认 20s，`idleTimeoutMs` 默认 60s；超过空闲以 `4002 idle_timeout` 关闭，`alive === false` 的连接直接 `terminate()`（`server/src/session.ts:144-162`、`server/src/config.ts:119-121`）。
- 预鉴权阶段有独立预算：单帧超过 16 KiB 直接 `4005`（`server/src/session.ts:269-273`），预鉴权速率 5 次/秒、突发 10（`server/src/session.ts:38-39`），`helloTimeoutMs` 默认 5s，超时按 `4000 auth_failed` 关闭（`server/src/session.ts:219-222`）。

### 关闭码

| 码 | 含义 | 客户端动作 |
| --- | --- | --- |
| `4000` | `auth_failed` | 终态，不重试 |
| `4001` | `protocol_mismatch` | 终态，不重试 |
| `4002` | `superseded` / `revoked` / `idle_timeout` / `authority_reset_required` / `too_many_connections` | 按 reason 区分：`revoked` 终态；`authority_reset_required` 清缓存后重连；其余重连退避 |
| `4003` | `rate_limited` | 退避重连 |
| `4004` | `invalid_frame` | 退避重连 |
| `4005` | `payload_too_large` | 退避重连 |
| `4006` | `server_error` | 退避重连 |

## 9. 不变量

1. 服务端是唯一权威：客户端不得在 server 模式下改规范状态（`src/main/storage-controller.ts:1002-1007`）。
2. `hello` 的 `cachedAuthority` 只能来自本机缓存，且必须与服务端血缘一致才允许增量投递（`server/src/session.ts:739-752`）。
3. `epoch` 与 `restoreGeneration` 单调不减；任何回退都会触发整体重同步（`src/shared/renderer-api.ts:216-256`）。
4. `eventSeq` 连续；`replay` 必须完整覆盖客户端到 head 的缺口，否则改发 `snapshot`（`server/src/session.ts:500-523`）。
5. 同 `opId` + 同命令类型幂等，结果可重放；同 `opId` 换类型一律 `op_id_conflict`（`server/src/command-service.ts:148-175`）。
6. 明文 token 只在 `welcome.issuedToken` 出现一次，之后只在服务端以哈希比对（`server/src/auth.ts:69-80`、`src/shared/sync/protocol.ts:240-241`）。
7. 投影出口永不含设备字段、密钥与答案键（`server/src/validation.ts:9-19`）。
8. 预鉴权连接有上限、有超时、有限速，未完成 `hello` 的连接不占用宠物连接配额（`server/src/session.ts:114-116`、`server/src/session.ts:219-222`）。

## 10. 失败模式

| 现象 | 原因 | 可观察行为 | 定位 |
| --- | --- | --- | --- |
| 连上即断、reason `protocol_mismatch` | `hello.v` 与服务端不一致 | 关闭码 `4001` | `server/src/session.ts:392-395` |
| 连上即断、reason `auth_failed` | token 撤销/不匹配，配对码已用或过期 | 关闭码 `4000`，客户端终态 | `server/src/auth.ts:23-56`、`src/main/remote-repository.ts:1730-1734` |
| 反复重连且每次拿全量快照 | 回放缺口超过 `maxReplayEvents` 或帧过大 | `delivery: 'snapshot'` | `server/src/session.ts:500-523` |
| 命令全部 `server_catching_up` | 服务端追赶空档未完成 | 客户端进入 `catching_up` 并等待 | `server/src/command-service.ts:184-190` |
| 命令全部 `authority_not_active` | 权威归档/交接中 | 只读 + 状态提示 | `server/src/session.ts:486-496` |
| 打开面板即提示权威被重置 | epoch/restoreGeneration 回退 | `authorityResetRequired` + 清缓存重同步 | `server/src/session.ts:739-781` |
| 命令返回 `op_id_conflict` | `opId` 复用但命令变了 | 不改 revision | `server/src/command-service.ts:148-172` |
| 大量 `4003 rate_limited` | 单设备命令过快或 resync 过频 | 连接被关，需退避 | `server/src/session.ts:358-372` |

## 11. 验证命令

预期退出码 `0`。

```bash
# 协议帧、命令目录、事件流单调性
node --experimental-strip-types --test scripts/tests/sync-protocol.test.mjs
node --experimental-strip-types --test scripts/tests/sync-protocol-types.test.mjs
node --experimental-strip-types --test scripts/tests/sync-data-boundary.test.mjs

# 服务端集成（真实 SQLite、真实 WSS、失败关闭）
npm --prefix server test

# 客户端远程仓库与模式切换
node --experimental-strip-types --test scripts/tests/remote-repository.test.mjs
node --experimental-strip-types --test scripts/tests/storage-c11.test.mjs

# 真实服务端 + 两个 Electron 的端到端
npm run test:e2e
```

通过标准：每个测试文件 `fail 0`；`npm --prefix server test` 汇总行 `fail 0`；`npm run test:e2e` 退出码 `0` 且报告断言真实服务端、真实 WebSocket、渲染层覆盖为真。历史验收记录（含 TLS/WSS 代理与 Docker 备份恢复）见 [C12 final gate](../reviews/c12-final-gate/2026-11-18-c12-final-gate.md)。

## 12. 客户端数据 HTTP 端点（与 WS 协议并列）

客户端展示数据不经过上面的 WebSocket 语义通道，而是走 `server/src/index.ts` 的 `/v1/client/*` HTTP 端点。它们与 `/v1/sync` 并列，但性质不同：**公开、只读、无认证**，不占用预鉴权或宠物连接配额，也不参与权威代次、恢复世代与事件游标。路由在健康检查之前分派（`server/src/index.ts:471-474`、`server/src/index.ts:483-541`）。

通用约定：

- 只接受 `GET`，其它方法返回 405 且带 `allow: GET`（`server/src/index.ts:437-441`）。
- 成功响应 `content-type: application/json; charset=utf-8`、`cache-control: no-store`；出错统一 `{ "ok": false, "error": "<code>" }`，绝不回传上游原始错误体（`server/src/index.ts:551-553`、`server/src/index.ts:601-609`）。
- `client-data` 目录在启动时 `mkdir`（`server/src/index.ts:192`），布局见部署指南。

| 端点 | 成功 | 失败码 |
| --- | --- | --- |
| `GET /v1/client/release` | 200 `{version, url}`（version 去掉前导 `v`，url 必须是绝对 `http(s)`） | 404 `release_unavailable`；503 `release_invalid` |
| `GET /v1/client/weather?city=` | 200 `Weather`，`hours` 为当天完整 8 个 3 小时时段 | 400 `invalid_city`（city > 64 字符）；502 `weather_upstream_failed`；504 `weather_upstream_timeout`；503 `weather_unavailable`（city 为空且无法定位） |
| `GET /v1/client/calendar?from=YYYY-MM-DD&days=31` | 200 `CalendarDay[]`（`{date, lunar, term, holiday}`） | 400 `invalid_range`（日期/天数非法） |
| `GET /v1/client/packs.json` | 200 `PackIndex`，每个 `url` 改写为 `/v1/client/packs/<name>` | 404 `packs_unavailable`；503 `packs_invalid` |
| `GET /v1/client/packs/<name>.qqpetpack` | 200 文件流（`application/octet-stream`、`content-length`、`etag`、`cache-control: immutable`） | 400 `invalid_pack_name`；404 `pack_not_found` |

关键契约：

- **release**：原样读取 `client-data/release.json` 的 `{version, url}`，`version` 去掉 `v` 前缀，`url` 必须是绝对 `http(s)`（`server/src/client-data.ts:141-165`）。
- **weather 是展示代理**：`city` 可选，最长 64；为空时请求上游根路径，由 wttr.in 按**服务端出口 IP** 定位，不读取宠物设置。服务端请求 `${QQPET_SYNC_WEATHER_UPSTREAM}/<city>?format=j1`，超时 `weatherTimeoutMs`，按 `city` 进程内缓存 `weatherCacheMs`（命中不请求上游、不持久化）（`server/src/client-data.ts:167-192`、`server/src/client-data.ts:337-376`）。
- **天气完整 8 段由客户端过滤**：服务端返回 wttr.in 当天全部 8 个 3 小时时段，不做本地小时裁剪；客户端 `filterWeatherHours` 按自己的本地当前小时过滤（`src/shared/weather.ts:62-70`、`src/shared/weather.ts:78-84`）。
- **calendar 纯计算**：`from` 缺省为服务端当前本地日期，`days` 1..31 默认 31；无网络、无缓存，调用共享 `computeCalendarDays`（`server/src/client-data.ts:194-212`）。
- **packs 相对 URL**：`packs.json` 的每个 `url` 必须是裸文件名（拒绝 `/`、`\`、`..`、协议前缀），服务端改写为 `/v1/client/packs/<encodeURIComponent(name)>`，保证客户端只从本服务器下载；出现绝对 URL 视为非法并回 503 `packs_invalid`（`server/src/client-data.ts:300-335`、`server/src/index.ts:505-508`）。
- **packs 文件**：文件名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.qqpetpack$`，解析后必须留在 `client-data` 目录内；支持 `If-None-Match` 命中回 304（`server/src/index.ts:509-539`、`server/src/index.ts:555-569`、`server/src/client-data.ts:239-264`）。

这些端点只输出公告文件、上游代理或纯计算得到的展示数据，不含任何宠物状态；服务端引擎的天气仍是 `seedHex + dayKey` 确定性兜底，与这些端点无关（见 [宠物运行时与存档](pet-runtime-and-save.md) §2）。

## 13. 变更影响

- **改协议版本**：必须同时改 `src/shared/sync/protocol.ts:12`、`parseClientMessage`/`parseServerMessage` 的版本判定、`server/src/session.ts:392-395` 的 `4001` 分支，以及客户端终态处理（`src/main/remote-repository.ts:1897-1907`）。旧客户端不会被兼容，属于破坏性变更。
- **新增消息类型**：要同时进 `CLIENT_MESSAGE_TYPES`/`SERVER_MESSAGE_TYPES`（`src/shared/sync/protocol.ts:441-445`）、校验器、`src/main/remote-repository.ts:806-850` 的分发 switch，漏掉会命中 `unknown_message_type`。
- **新增命令**：`CommandPayloadMap`、`ResultDataMap`、`COMMAND_ROLES` 三张表缺一不可（`src/shared/sync/protocol.ts:20-101`、`src/shared/sync/command-validation.ts:236-242`），并要同步服务端 `server/src/command-service.ts` 的分支与本地运行时 handler（`src/shared/pet-runtime/runtime.ts:189-262`）。
- **改权威语义**：`epoch`/`restoreGeneration` 任何变化都会波及 `server/src/session.ts`、`src/main/remote-repository.ts`、`src/main/storage-controller.ts` 与 `scripts/tests/storage-c11.test.mjs`；这类改动属于重大变更，必须先过规格门禁。
- **改限流/帧上限**：`server/src/config.ts:136-153` 是唯一来源，改完要跑 `npm --prefix server test` 与 `npm run test:e2e`，否则客户端会把新的关闭码当成未知错误。
- **改投影出口**：只能在 `server/src/validation.ts` 与 `src/shared/sync/data-boundary.ts` 的名单里改，不要在 `hub.broadcastProjection` 里加特例。
- **改客户端数据端点**：`server/src/index.ts` 的 `handleClientHttp`、`server/src/client-data.ts`，以及客户端 `src/shared/{upstream,update,weather,calendar}.ts` 需同步；这些端点必须保持公开只读，客户端展示数据不得回退到任何第三方域名。

历史设计取径见冻结文档 [local-or-server pet data design](../reviews/legacy/2026-10-20-local-or-server-pet-data-design.md)（只读，勿改）。
