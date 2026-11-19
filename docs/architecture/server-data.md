# 服务端数据与恢复世代

> 结论：宠物权威数据只存在一个 SQLite 文件里，schema 版本固定为 1，迁移只做加法并在未知状态下失败关闭；一个数据库同时只能有一个写者，由进程生命周期锁（SQLite `BEGIN EXCLUSIVE`）保证；备份走 SQLite 在线备份 API，恢复走「校验候选副本 → 在暂存副本里提升世代并轮换 authority → 先发布外部世代栅栏 → 原子 rename 安装」的固定顺序，任何一步失败都不会让线上库停在半成品状态。

## 1. 范围

代码位置写作 `path:line`。为控制宽度，本文中 `db.ts`、`db-lock.ts`、`coverage.ts`、`portable-import.ts`、`cli.ts`、`config.ts`、`index.ts`、`command-service.ts`、`session.ts` 均指 `server/src/` 下的同名文件；每个小节首次出现时给出完整路径。

本文描述服务端（`server/`）独占的持久化层：SQLite 打开方式、schema 与迁移、单写者锁、备份文件、恢复世代栅栏、恢复安装/回滚，以及便携包导入在数据层的边界。协议层（WebSocket 帧、命令语义）见 `sync-protocol.md`；部署与运行参数见 `docs/guides/server-deployment.md`；故障处置步骤见 `docs/runbooks/server-recovery.md`。

数据库路径、备份目录、恢复世代文件路径都由 `server/src/config.ts` 从环境变量解析（`config.ts:70-96`），默认库在 `~/.local/share/qqpet-sync/qqpet.sqlite`，备份目录是同级的 `backups/`。

## 2. 打开数据库时确定的行为

`DatabaseStore` 的构造函数是唯一入口（`server/src/db.ts:359-372`）：

- 非只读打开时依次执行 `PRAGMA busy_timeout = 5000`、`foreign_keys = ON`、`journal_mode = WAL`、`synchronous = FULL`，然后才迁移（`db.ts:364-369`）。这四条 PRAGMA 是打开即生效的，不依赖调用方记得设置。
- 只读打开改用 `immutable=1` 的 file URL（`db.ts:327-331`、`db.ts:361-363`）。这一点是恢复流程的前提：校验候选备份时不能因为打开动作生成 `-wal`/`-shm` 侧车文件，否则校验会修改被校验对象。
- 构造结束无条件调用 `assertHealthy()`（`db.ts:371`），它会跑 `PRAGMA quick_check`、`PRAGMA integrity_check`，并要求 `schema_migrations` 恰好一行且等于 `SCHEMA_VERSION`，再逐表核对必需表存在（`db.ts:399-413`）。缺表、版本不符、页损坏都在这里直接抛错，不会带着半可用状态继续服务。

## 3. schema 与「迁移只增」

`SCHEMA_VERSION = 1`（`db.ts:14`），建表 SQL 集中在 `MIGRATION_SQL`（`db.ts:18-166`），必需表清单在 `MIGRATION_1`（`db.ts:168-172`）。两类结构必须同时改：`MIGRATION_SQL` 负责建表，`MIGRATION_1` 负责健康检查时的存在性核对。

表按其职责分组：

| 表 | 职责 | 关键约束 |
| --- | --- | --- |
| `pets` | 每个宠物一行权威快照：`revision`、`command_seq`、`event_seq`、`save_json`、`engine_json` | 主键 `id`，`schema_version` 必须等于当前版本 |
| `pet_settings` | 与引擎快照分离的设置（时区、空置推进、天气城市） | 外键级联删除 |
| `pet_authority` | 权威归属与恢复世代：`authority_id`、`restore_generation`、`epoch`、`owner`、`state` | `owner IN ('server','local')`、`state IN ('active','archived','reset')` |
| `commands` / `events` | 命令幂等记录与有序 UI 事件 | `UNIQUE (pet_id, device_id, op_id)`；事件主键 `(pet_id, event_seq)` |
| `scheduled_jobs` / `game_sessions` | 调度队列与小游戏会话 | 状态列带 CHECK 枚举 |
| `session_coverage` / `coverage_operations` | 在线覆盖区间与跨端覆盖修复操作 | `coverage_operations.state IN ('pending','suspended','completed')` |
| `devices` / `pairing_codes` | 设备令牌哈希与一次性配对码 | `UNIQUE (token_hash)`；只存 SHA-256 哈希 |

迁移入口是 `migrate()`（`db.ts:374-397`），行为分三种：

1. 没有 `schema_migrations` 表（全新库）：在一个 `BEGIN IMMEDIATE` 事务里执行整个 `MIGRATION_SQL`，写入 `version = SCHEMA_VERSION`，失败则 `ROLLBACK`。
2. 已有表且最高版本等于 `SCHEMA_VERSION`：直接返回，不做任何 DDL。
3. 已有表但最高版本小于 `SCHEMA_VERSION`，或迁移表为空：当前实现会再执行一遍完整 `MIGRATION_SQL`，其中 `CREATE TABLE` 没有 `IF NOT EXISTS`，因此在既有库上会失败并回滚。

因此当前分支的真实约束是：**只支持版本 1；要引入版本 2，必须同时新增一段只增的增量迁移（例如 `ALTER TABLE ... ADD COLUMN`）并改写 `migrate()` 的分支，不能只改常量。** 递增版本时还要同步改 `MIGRATION_1`，否则 `assertHealthy()` 会在启动时因缺表报错（`db.ts:406-412`）。

两个失败关闭点固定在代码里：

- 已应用的最高版本大于 `SCHEMA_VERSION`（旧程序打开新库）→ `unsupported migration state`（`db.ts:380-381`）。
- 健康检查发现迁移行数不是 1 或版本不等于 `SCHEMA_VERSION` → 同样报错（`db.ts:404-405`）。

## 4. 单写者：进程生命周期锁

`server/src/db-lock.ts` 实现 `DatabaseLifetimeLock`：在 `<数据库路径>.server-lock.sqlite` 上以 `busy_timeout = 0` 打开独立数据库并执行 `BEGIN EXCLUSIVE`（`db-lock.ts:18-25`）。锁的语义依赖 SQLite 持有的 OS 文件锁：

- 进程退出（包括崩溃）时 OS 释放锁，不会留下需要人工清理的陈旧锁文件（`db-lock.ts:3-9`）。
- 抢不到锁时把 SQLite 的 `SQLITE_BUSY`（`errcode & 0xff === 5`）翻译成固定文案 `database is in use by a running server or another restore; stop it and retry`（`db-lock.ts:34-37`）。运维看到这句话应理解为「还有进程在用这个库」，而不是文件损坏。
- `release()` 只 `ROLLBACK` 并关闭锁库（`db-lock.ts:42-51`），重复调用无副作用。

持有者有两类：服务进程启动时（`server/src/index.ts:184`），以及 `restore` 子命令（`server/src/cli.ts:318`）。两者互斥，因此不可能出现「服务在跑、同时有人换库」的窗口。`stop()` 在 `finally` 里关闭 store 并释放锁（`index.ts:232-236`）。

注意锁文件是独立文件，不是 WAL 文件：`WAL` 大小为 0 不代表服务已停（`server/README.md:520-523` 明确要求不要用 WAL 大小判断「已停」）。

## 5. 事务与写路径

所有多语句写操作走 `transaction()`（`db.ts:491-505`）：`BEGIN IMMEDIATE` → 回调 → `COMMIT`，抛错时 `ROLLBACK` 并保留原始错误。`BEGIN IMMEDIATE` 而不是 `BEGIN` 是刻意的：在事务开头就取得写锁，避免读事务升级写锁时返回 `SQLITE_BUSY`。

关闭时若非只读会先 `PRAGMA wal_checkpoint(TRUNCATE)` 再 `close()`，checkpoint 失败被吞掉以保证关闭总是可行（`db.ts:507-519`）。这就是优雅停机（`SIGTERM`/`docker compose stop`）后 WAL 归零的原因。

## 6. 备份

备份只有一条实现：`DatabaseStore.backup()` 调用 `node:sqlite` 的在线备份 API（`db.ts:1524-1526`），文件名由 `createBackupPath()` 生成，格式 `<backupDir>/<petId>-<ISO 时间，冒号替换为短横线>.sqlite`（`server/src/index.ts:538-539`）。

三个入口共用这条路径：

- CLI：`backup` 子命令，`--output` 缺省时用 `createBackupPath`（`server/src/cli.ts:244-255`）。
- 服务内：`SyncServer.backup()` 成功/失败分别累加 `backup.success` / `backup.failure` 计数器，失败会写 `backup.failed` 结构化日志（`index.ts:402-410`）。
- 导入前自动备份：`beforePortableImportCommit` 钩子在提交事务前触发，失败直接抛错并让导入失败（`server/src/session.ts:592-600`、`session.ts:678-693`），因此「导入没有前像备份」不会被静默允许。

备份文件是完整权威快照，包含哈希后的设备凭据与会话元数据，因此按敏感数据处理；命令/事件保留策略（默认各 10000 条）裁剪的是库内行，不影响备份完整性。

## 7. 恢复世代栅栏

恢复必须回答一个问题：把一个旧库装回去之后，怎么防止曾经见过更新世代的客户端继续按旧谱系读写？实现是双份记录：

- 库内：`pet_authority.restore_generation`，`maxRestoreGeneration()` 取全库最大值（`db.ts:1451-1454`）。
- 库外：操作员维护的世代文件（路径来自 `QQPET_SYNC_RESTORE_GENERATION_FILE`），内容是一个非负整数的十进制文本。`readRestoreGenerationRecord()` 只读不建文件，`ENOENT` 视为「未记录」（`db.ts:333-347`）。

两者必须严格一致，检查在 `verifyRestoreGeneration()`（`db.ts:1461-1474`），服务启动时于监听端口之前调用（`index.ts:186`）：

| 状态 | 结果 |
| --- | --- |
| 记录值 > 库内值 | 抛错，提示 `run restore --accept-rollback` |
| 记录值 ≠ 库内值 | 抛错（同提示） |
| 配置了栅栏文件路径、文件不存在且库内世代 > 0 | 抛错（栅栏丢失同样失败关闭） |

「记录值大于库内值」正是「先发布栅栏、再换库」之间崩溃留下的状态：库还是旧的，栅栏已经是新的，启动拒绝服务，直到重跑 restore。

## 8. 恢复安装：暂存、校验、原子替换

`restore` 子命令（`server/src/cli.ts:293-443`）的顺序是固定的，且每一步都在动线上库之前完成校验：

1. 取锁（`cli.ts:318`）。抢不到锁直接失败，不做任何写入。
2. 用 `inspectRestoreSource()` 只读校验候选库：`PRAGMA foreign_key_check` 必须为空、至少一个宠物、每个 `pets.schema_version` 等于 `SCHEMA_VERSION`、authority 的世代/epoch 是合法非负安全整数（`db.ts:1661-1711`）。
3. 若提供 owner 凭据，必须哈希命中该候选库内一条未撤销的 owner 设备记录，且哈希长度 32 字节（`db.ts:1689-1701`）。随机字符串在这里必然失败——凭据不是「格式对就行」的门禁。
4. 世代推进：取「候选库世代、栅栏记录、线上库世代」三者最大值，再加 1；显式 `--restore-generation` 必须严格大于该最大值（`cli.ts:323-341`）。线上库损坏到读不出世代时按「无记录」处理，这是恢复损坏库的入口（`cli.ts:104-117`）。
5. 把候选库复制成暂存文件（`COPYFILE_EXCL`，`cli.ts:353-355`），只对暂存副本执行 `resetAuthoritiesAfterRestore()`：先校验全部前置条件（authority 存在、世代可推进、epoch 未到上限），再在一个事务内把 `authority_id` 换成新 UUID、`restore_generation` 写成新世代、`epoch + 1`、`owner = 'server'`、`state = 'active'`、清空 handoff 相关列（`db.ts:1485-1522`）。任一只宠物不满足 → 整批不写。
6. 重新打开暂存副本做第二轮 `inspectRestoreSource()` 并逐项断言：宠物集合不变、owner 设备不变、`maxRestoreGeneration` 等于新世代、每只宠物的 authority 已轮换且 epoch 恰好 +1（`cli.ts:368-388`）。
7. `fsync` 暂存文件，然后**先把新世代写进外部栅栏**（临时文件 + fsync + rename，`cli.ts:163-178`、`cli.ts:395-399`），再安装数据库（`cli.ts:401`）。
8. 安装函数 `installStagedDatabase()`（`cli.ts:119-137`）：先把线上库硬链接（不支持时退化为 `COPYFILE_EXCL` 复制）到 `<db>.restore-previous` 并 fsync，删除线上库的 `-wal`/`-shm`，再 `rename(staged → live)`，最后尽力 fsync 目录。
9. 失败回滚按逆序：库已安装但未提交则用 `.restore-previous` 换回（无前像则删除线上库），栅栏已发布则用先前快照恢复（`cli.ts:416-436`）。回滚本身失败会把两条错误一起抛出，不会只报原始错误。

`writeFileDurably()`（`cli.ts:163-178`）是所有外部文件写入的统一实现：同目录临时文件、`mode 0o600`、fsync、rename、尽力 fsync 目录。恢复结束后暂存文件和侧车文件都会被清理（`cli.ts:437-439`）。

## 9. 便携包导入的数据层边界

导入不是「把 JSON 灌进库」，而是一段可单独测试的纯规划 + 一次事务提交：

- `planPortableImport()` 是纯函数，产出 `ImportPlan`（`server/src/portable-import.ts:20-30`、`portable-import.ts:103-245`），不写数据库。
- 只接受 `owner === 'local'` 的 bundle（`portable-import.ts:109`）；普通导入要求目标 authority `active`，`resumeServer` 要求目标 `archived`（`portable-import.ts:110-115`）。
- 谱系判断：`authorityId` + `restoreGeneration` 相同才算同谱系；只有「目标是全新占位谱系（epoch 0、generation 0）且没有任何已应用命令」时才允许采纳来件谱系（`portable-import.ts:116-130`）。设备管理类命令（`device.list`、`device.revoke`）不算「已应用命令」，不会被误判成谱系已定（`server/src/command-service.ts:513-518`）。
- epoch 必须不后退；相等 epoch 只接受「正在恢复的那次 archived handoff」（`portable-import.ts:134-142`）。
- 时钟锚点窗口：过去 48 小时、未来 5 分钟（`portable-import.ts:15-16`）。超出窗口必须显式 `allowClamp`，钳制时整体平移 `gameTimeMs`、调度截止时间、会话起止时间，并重新规范化日界元数据（`portable-import.ts:168-197`）。
- 导入的覆盖区间会被物化成已关闭历史：未关闭区间按「最后心跳 + 30 秒崩溃宽限」截断并标注 `import_replaced`（`portable-import.ts:248-264`）；终端 survivor 用自身 active 结束时间，已持久化的结束时间与关闭原因永远优先（`portable-import.ts:277-324`）。这条规则与 `finalizeSurvivor()` 的「已持久化的结束时间不可被重放延长」一致（`server/src/coverage.ts:50-57`）。
- 提交在 `executePortableImport()` 的一次 `transaction()` 内完成：应用权威快照、推进 command seq、补发会话结算事件（`command-service.ts:541-574`）。提交前先做导入前备份（第 6 节）。

## 10. 不变量清单

1. 一个库文件同一时刻只有一个写者，由 `<db>.server-lock.sqlite` 上的 `BEGIN EXCLUSIVE` 保证；读取方（校验、只读打开）不持锁，但也绝不写。
2. 打开即校验：`quick_check`、`integrity_check`、迁移版本、必需表，任一不符则进程不进入服务状态。
3. 迁移只增：已应用版本高于代码版本 → 失败关闭；新增版本必须同时改增量迁移、`SCHEMA_VERSION`、`MIGRATION_1`。
4. 世代只增：`restore_generation` 每次恢复必须严格增大；authority UUID 每次恢复必须重新生成；epoch 每次恢复恰好 +1。
5. 库内世代与外部栅栏文件必须相等，且栅栏先于数据库落盘。
6. 恢复只对暂存副本做权威重置，线上库只经历一次 `rename`；替换前的前像保存在 `.restore-previous`。
7. 导入的谱系采纳只发生在「无已应用命令的空占位谱系」上；其余谱系不符一律视为 fork 拒绝。
8. 导入前备份失败即导入失败；不存在「先导入、备份稍后补」的路径。

## 11. 验证命令

以下命令在仓库根执行，均只读写本地文件：

```bash
# 类型检查（含 server 包）
npm --prefix server run typecheck

# 服务端集成测试（会构建 dist 后跑 server/test/*.test.ts）
npm --prefix server test

# 查看库内宠物、revision、事件序号、设置与 authority（只建库不改数据）
node server/dist/server/src/index.js status --db /var/lib/qqpet-sync/qqpet.sqlite

# 校验一个备份文件：完整性 + 外键
node --disable-warning=ExperimentalWarning -e \
  "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA quick_check').get()); console.log(db.prepare('PRAGMA foreign_key_check').all()); db.close()" \
  /var/lib/qqpet-sync/backups/default-2026-10-22T03-15-00.000Z.sqlite
```

`status` 需要 `server/dist` 已构建；`npm --prefix server test` 会先执行 `npm run build`（`server/package.json:13-16`）。

## 12. 变更影响

- 改 `MIGRATION_SQL` 或 `SCHEMA_VERSION`：影响所有既有库的可打开性。必须新增增量迁移分支，并给出「旧库升级后 `assertHealthy()` 通过」的证据；只改常量会让旧库在启动时抛 `unsupported migration state` 或 `CREATE TABLE` 冲突。
- 改表结构：同步核对 `MIGRATION_1`、`mapPet`/`mapAuthority`/`mapCoverageOperation` 等行映射函数（`db.ts:1713-1760`），否则读出的字段与类型会静默错位。
- 改 `DatabaseLifetimeLock` 的锁文件命名或获取方式：`restore` 与 `start` 的互斥依赖同一个路径推导（`dbPath + '.server-lock.sqlite'`），两边必须一起改。
- 改恢复顺序（例如先换库再写栅栏）：会让「两次操作之间崩溃」变成可服务状态，直接破坏第 10 节第 5 条不变量。
- 改 `planPortableImport` 的谱系/窗口判定：会影响本地到服务端的迁移路径与 `authorityResetRequired` 传播，必须同时更新 `sync-protocol.md` 中导入说明与相关测试。
