# 后端规范

> 结论：qqpet 后端由 Electron 主进程（本地权威）与 `server/` 独立权威端组成，两者共享 `src/shared/**` 的运行时与协议代码。服务端是单进程、单 SQLite、单宠物家族的权威实现；所有边界输入必须校验，所有缺失配置必须显式失败，所有状态变更必须可重放、可对账、可恢复。

## 1. 技术栈与运行时约束

- `server/package.json` 要求 Node.js >= 22；使用内置 `node:sqlite`（`server/src/db.ts:4`），不编译原生 SQLite 插件；运行时依赖只有 `ws`。
- 服务端是 ESM，构建产物入口为 `server/dist/server/src/index.js`；`npm --prefix server test` 先构建再跑 `server/test/*.test.ts` 编译产物。
- 服务端构建直接导入仓库根的 `src/shared/**`，因此 Docker 必须从仓库根构建（`server/README.md`），不能只把 `server/` 当独立上下文。
- 一个部署只服务一个宠物家族：一个 SQLite 数据库、一个服务进程。不支持多租户、水平扩展、多写、Postgres/Redis 或客户端模拟兜底。
- 移动端不提供 server mode：`src/main/renderer-runtime-flags.ts:61` 对 Android/iOS 返回 `mobile_server_mode_forbidden`；服务端能力仅桌面使用。

## 2. 目录与职责

| 路径 | 职责 | 变更注意 |
|---|---|---|
| `src/shared/pet-runtime/**` | 宠物规则引擎、tick、RNG、会话、覆盖度 | 改动会同时影响本地与服务端权威结果 |
| `src/shared/sync/**` | 协议类型、命令校验、数据边界、portable 导入 | 协议版本/字段变更属重大变更 |
| `src/shared/local-repository/**` | 本地 v2 权威宿主与存储适配 | 桌面默认权威；回滚标志见 `src/main/renderer-runtime-flags.ts:8` |
| `src/main/storage-controller.ts` | 本地/服务端权威切换、配对、导入导出、备份 | 必须保持单一写入者，禁止双写 |
| `src/main/save.ts`、`src/main/atomic-write.ts` | 旧版本地存档与原子写 | 旧写手不得与 v2 权威共存 |
| `server/src/index.ts` | 服务装配、HTTP/WS、启动/关闭 | 健康检查与失败关闭入口 |
| `server/src/session.ts` | WebSocket 会话、hello、投递计划 | 首帧、超时、重连语义 |
| `server/src/command-service.ts` | 命令串行化、幂等、权限、事件 | `opId` 与 revision 语义 |
| `server/src/auth.ts` | 配对码/设备 token 哈希校验、吊销 | 不记录明文凭据 |
| `server/src/db.ts` | SQLite schema、事务、权威、备份 | schema 迁移与锁顺序 |
| `server/src/db-lock.ts` | 数据库生命周期排他锁 | 恢复必须停服并持锁 |
| `server/src/scheduler.ts` | 空场推进、追赶、定时任务 | 游戏时间与随机性可重放 |
| `server/src/portable-import.ts`、`server/src/cli.ts` | 迁移导入、init/pair/backup/restore/revoke | 恢复世代校验 |

## 3. 权威与数据不变量

- **服务端权威**：客户端只提交语义命令，服务端串行执行并下发完整投影（`snapshot`/`projection`）；客户端不得自行推进规范化状态。
- **单调性**：revision 与 eventSeq 单调递增；客户端发现缺口、权威 stamp 不匹配或恢复回滚时触发 `resync`，服务端返回完整快照。
- **命令幂等**：`opId` 由调用方生成且稳定；同一设备重复 `opId` 返回已存结果（`duplicate`），不重复执行、不消耗 RNG（`server/src/command-service.ts:148`）。`not_applied` 不得盲目重试，UI 必须水合最新投影后用新 `opId` 重试。
- **串行执行**：命令按到达顺序执行；`observedRevision` 只是诊断，不是 compare-and-swap 守卫（`server/src/command-service.ts:130`）。
- **权威 fencing**：authority 由 `authorityId`、`epoch`、`restoreGeneration` 标识；恢复/回滚必须推进 generation 并更换 authority UUID。数据库与外部 restore-generation 文件必须一致，否则启动失败关闭（`server/src/cli.ts:323`）。
- **数据边界**：`src/shared/sync/data-boundary.ts:70` 定义永不上传的设备本地键（`aiKey`、`searchKey`、`webhookToken` 等）；服务端不得向客户端返回存档 JSON、配对码、设备 token、会话答案、答案键或其它设备 token（`server/README.md` 的 health/protocol 契约）。
- **认证边界**：配对码与设备 token 只在首帧 `hello` 传输；服务端只存哈希，明文只返回一次；吊销在每条命令前复核（`server/src/auth.ts`）。
- **健康检查分级**：`/healthz` 只证明 HTTP 可响应；`/readyz` 要求 DB、scheduler、canonical state、authority 就绪；公开 `/health` 与 `/readyz` 只返回聚合字段，详细诊断需 owner token。

## 4. 协议约束

- `PROTOCOL_VERSION = 1`（`src/shared/sync/protocol.ts:12`）；客户端首帧必须是 `hello`，5 秒内到达，不允许 query-string token 或 Authorization 头 token。
- 客户端消息：`hello`、`command`、`commandStatus`、`exportBundle`、`resync`、`ping`；服务端消息：`welcome`、`snapshot`、`replay`、`ready`、`projection`、`commandResult`、`commandStatusResult`、`portableBundle`、`deviceRevoked`、`authorityResetRequired`、`error`、`pong`（`src/shared/sync/protocol.ts:441-442`）。
- 关闭码固定：`4000` 认证失败、`4001` 版本不匹配、`4002` 会话被取代/吊销/权威重置、`4003` 限流、`4004` 非法帧、`4005` 负载过大、`4006` 服务错误。
- 帧/命令/快照上限、命令速率、连接数、心跳与空闲超时是代码默认值（`server/README.md`）；修改需要评审，不能只改环境变量就宣称生效。
- 协议字段、消息类型、关闭码、错误语义任一变化都属于重大变更，必须同步 `docs/architecture/sync-protocol.md` 和 `docs/architecture/server-data.md`。

## 5. 持久化与恢复

- 打开数据库时强制 `PRAGMA busy_timeout = 5000`、`foreign_keys = ON`、`journal_mode = WAL`、`synchronous = FULL`（`server/src/db.ts:365`）。
- schema 由 `schema_migrations` 管理（`server/src/db.ts:19`），宠物文档带 `schemaVersion`（`server/src/db.ts:14`）；不支持的版本必须拒绝，而不是猜测迁移。
- 服务进程持有数据库生命周期排他锁（`server/src/db-lock.ts:18`）；恢复在锁被占用时以 `database is in use` 失败，不能凭 WAL 大小判断服务是否停止。
- 备份只用 SQLite online backup API（CLI `backup` 或 `SyncServer.backup`）；禁止 `cp` 活跃 `.sqlite`。备份包含哈希凭据与游戏状态，按敏感数据保护。
- 恢复/回滚必须停服、保留原库、用 `--accept-rollback` 与递增 `--restore-generation`、校验 owner 凭据、原子换库；恢复后验证 `/readyz`、authority、revision、eventSeq、一次无害命令与二次投影。
- 命令/事件保留行数可与备份保留独立；裁剪日志不改变备份的完整性。

## 6. 失败策略

- 配置错误在进程启动时抛出：绝对路径、端口范围、时区、整数/布尔取值不合法都显式报错（`server/src/config.ts`）。未知环境变量忽略，但必需项缺失不提供生产默认凭据。
- 未初始化宠物、数据库不可写、scheduler 未就绪、authority 不一致时，服务必须 not-ready 或拒绝命令，不得返回空投影假装正常。
- 认证失败、设备吊销、限流、负载过大、协议不匹配必须以对应关闭码结束；不得用通用 `500` 或静默断线掩盖。
- 任何 catch 都必须保留错误语义与可观测性；日志不得包含载荷、存档正文、token、配对码、答案键。

## 7. 验证命令

| 命令 | 覆盖 |
|---|---|
| `npm --prefix server run typecheck` | 服务端类型检查 |
| `npm --prefix server test` | 构建 + 服务端集成测试（协议、认证、幂等、调度、备份恢复） |
| `npm --prefix server run build` | 产物构建 |
| `npm run smoke:compose` | Compose 缺凭据/缺文件失败关闭 |
| `npm run smoke:docker` | 镜像启动、readyz、非 root、备份/恢复 |
| `npm run smoke:proxy` | TLS/WSS 反代与全部 HTTP 路由 |
| `npm run test:compat` | 共享协议/运行时兼容测试 |

## 8. 变更影响

- 改 `server/src/**`、`src/shared/sync/**`、`src/main/storage-*` 时，至少更新 `docs/architecture/sync-protocol.md`；涉及持久化/恢复时同时更新 `docs/architecture/server-data.md`。
- 改部署、配置、TLS、secret 挂载时更新 `docs/guides/server-deployment.md` 与 `docs/runbooks/server-recovery.md`。
- 新增代码域时在 `docs/doc-map.json` 增加规则；不得留死 glob 或把目标指向 `docs/reviews/**`。
