# 服务端故障恢复手册

> 结论：服务端恢复只有一条安全路径——先让写者停下来（优雅停服，确认锁已释放），再校验备份，再用会推进恢复世代的 `restore` 命令替换数据库，最后启动并验证就绪与客户端权威重置。任何"直接覆盖 sqlite 文件""删 WAL""跳过 `--accept-rollback`"的做法都会绕过世代栅栏，导致回滚后的旧权威被继续服务。

## 1. 适用场景与决策

| 现象 | 判定 | 首个动作 |
| --- | --- | --- |
| `/readyz` 返回 503，`databaseReady=false` | 数据库不可写或 `quick_check` 不通过 | 第 3 节只读诊断；不要重启"试试看" |
| 启动日志出现 `database restore is older than the recorded restore generation` | 库被回滚但栅栏仍是新世代，或上次恢复在发布栅栏后崩溃 | 第 5.2 节：重跑 restore 推进世代 |
| 启动日志出现 `database restore generation fence is missing` | 栅栏文件丢失而库内世代 > 0 | 先找回栅栏文件，找不到则按 5.2 重跑恢复 |
| 启动日志出现 `database is in use by a running server or another restore` | 还有写者持有生命周期锁 | 第 2 节确认进程，未停就停 |
| 启动日志出现 `sqlite quick_check failed` / `integrity_check failed` / `missing required table` | 库损坏或 schema 不完整 | 第 5.1 节：保留现场 + 恢复最近已验证备份 |
| 调度器不就绪（`ready=false` 且 `scheduler.*`） | 追赶阻塞或调度异常 | 读 owner 认证的 `/health/detail`，见第 6 节 |
| 磁盘写满 | 写入失败、备份失败 | 先释放非库空间，见第 7 节；不要删 WAL 或备份充数 |

恢复不是"重启服务"的同义词：普通重启不改变恢复世代，也不校验备份。只有 `restore` 子命令会推进世代并轮换 authority。

## 2. 第一步：停止写入并确认

服务端的写者只有服务进程本身（`server/src/index.ts:184` 在启动时取生命周期锁），以及 `restore` 命令（`server/src/cli.ts:318`）。两者互斥，所以"停服务"是恢复的前置条件，而不是建议。

### 2.1 systemd 部署

```bash
# 优雅停止：SIGTERM → 停调度器 → 收尾覆盖区间 → 关会话 → checkpoint WAL → 关库
sudo systemctl stop qqpet-sync.service
systemctl is-active qqpet-sync.service          # 期望 inactive
systemctl status qqpet-sync.service --no-pager  # 末尾应看到正常退出
```

单元配置 `TimeoutStopSec=30`、`Restart=always`（`server/deploy/qqpet-sync.service:13-15`）：`stop` 是受支持的停止方式，不要用 `kill -9`；强杀会跳过覆盖收尾与 WAL checkpoint。

### 2.2 Docker Compose 部署

```bash
cd server
docker compose stop qqpet-sync      # 不要用 docker kill / docker rm -f
docker compose ps                   # qqpet-sync 应为 exited
```

`stop` 发送 `SIGTERM` 并等待同一优雅关闭路径（`server/README.md:593-596`）。

### 2.3 不要用 WAL 大小判断"已停"

服务端在关闭时执行 `PRAGMA wal_checkpoint(TRUNCATE)`（`server/src/db.ts:511-517`），但不代表 `-wal` 为零就一定是停着的；反过来，空闲服务的 WAL 也可能是 0 字节而进程仍在跑。真正的判据是 `systemctl is-active` / `docker compose ps`，以及锁的实际占用——`restore` 抢不到锁时会给出固定文案：

```text
database is in use by a running server or another restore; stop it and retry
```

这句话来自 `server/src/db-lock.ts:34-37`，含义是"锁文件被别的进程持有"，不是文件损坏。

## 3. 只读诊断（不改动任何文件）

以下命令都不写库；`--db` 指向线上库时也只触发只读打开。

```bash
# 宠物、revision、事件序号、设置、authority（会打开库并做完整性检查）
node /opt/qqpet-sync/dist/server/src/index.js status \
  --db /var/lib/qqpet-sync/qqpet.sqlite

# 就绪/存活（服务在跑时）
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/readyz
curl -sS http://127.0.0.1:8787/healthz

# 详细健康（必须 owner 设备令牌，不要放进 URL）
curl -sS -H "Authorization: Bearer $(cat /etc/qqpet-sync/owner-admin-credential)" \
  http://127.0.0.1:8787/health/detail
```

`status` 输出中的 `authority.restoreGeneration`、`authority.authorityId`、`authority.epoch` 是后续判断恢复是否生效的关键字段（`server/src/cli.ts:257-276`、`server/src/db.ts:1743-1758`）。`/health/detail` 提供宠物级 `petHealth`、`catchingUp`、`wallLagMs`、`lastError`（`server/README.md:269-283`、`server/src/index.ts:432-480`）。

## 4. 备份校验（恢复前必做）

恢复源必须是经过校验的备份，而不是"看起来像备份的文件"。

```bash
# 1) 列出备份，按时间挑选候选
ls -lt /var/lib/qqpet-sync/backups/

# 2) 结构校验：quick_check 与 foreign_key_check 都必须干净
node --disable-warning=ExperimentalWarning -e \
  "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA quick_check').get()); console.log(db.prepare('PRAGMA foreign_key_check').all()); db.close()" \
  /var/lib/qqpet-sync/backups/default-2026-10-22T03-15-00.000Z.sqlite
```

判定标准：

- `quick_check` 只有一个 `ok` 键值。
- `foreign_key_check` 返回空数组。
- 文件非空、mtime 合理、不是被 `cp` 到一半的副本。

`restore` 自己还会做更严格的校验（第 5 节）：外键、至少一个宠物、`pets.schema_version` 等于当前版本、authority 世代/epoch 合法、owner 凭据哈希命中库内未撤销 owner 设备（`server/src/db.ts:1661-1711`）。手工校验通过不代表 `restore` 一定通过，但手工校验失败就一定不要用这份备份。

## 5. 执行恢复

### 5.1 常规回滚恢复

前提：服务已停（第 2 节），备份已校验（第 4 节），你持有 owner 凭据文件路径，且知道要推进到的世代。

```bash
# 0) 记录当前状态，便于事后对照
date -Is
ls -l /var/lib/qqpet-sync/qqpet.sqlite* /var/lib/qqpet-sync/restore-generation.txt 2>/dev/null
cat /var/lib/qqpet-sync/restore-generation.txt 2>/dev/null

# 1) 保留现场：库、WAL/SHM、栅栏文件都复制一份到独立目录
sudo install -d -o qqpet-sync -g qqpet-sync -m 0700 /var/lib/qqpet-sync/recovery-$(date +%Y%m%dT%H%M%S)
sudo cp -a /var/lib/qqpet-sync/qqpet.sqlite* /var/lib/qqpet-sync/recovery-*/
sudo cp -a /var/lib/qqpet-sync/restore-generation.txt /var/lib/qqpet-sync/recovery-*/ 2>/dev/null || true

# 2) 恢复：--accept-rollback 必填；世代必须严格大于当前/已记录值
sudo -u qqpet-sync /usr/bin/node /opt/qqpet-sync/dist/server/src/index.js restore \
  --db /var/lib/qqpet-sync/qqpet.sqlite \
  --from /var/lib/qqpet-sync/backups/default-2026-10-22T03-15-00.000Z.sqlite \
  --accept-rollback \
  --restore-generation 4 \
  --owner-admin-credential /etc/qqpet-sync/owner-admin-credential

# 3) 启动并验证
sudo systemctl start qqpet-sync.service
curl --fail http://127.0.0.1:8787/readyz
```

`restore` 的固定顺序是（`server/src/cli.ts:293-443`）：

1. 取数据库生命周期锁；抢不到立即失败，线上库零改动。
2. 只读校验候选库与 owner 凭据。
3. 计算下一个世代：`max(候选库世代, 栅栏记录, 线上库世代) + 1`；显式 `--restore-generation` 必须严格大于该值。
4. 复制候选库为暂存文件，只对暂存副本重置 authority（新 UUID、新世代、`epoch+1`、`owner=server`、`state=active`），并二次校验。
5. 先原子写入外部栅栏文件（临时文件 + fsync + rename），再原子 `rename` 安装数据库；旧库留在 `<db>.restore-previous`。
6. 任何一步失败：未提交则用前像回滚库与栅栏；回滚也失败会同时报告两条错误。

恢复成功时会输出 JSON：

```json
{
  "ok": true,
  "restoredFrom": "/var/lib/qqpet-sync/backups/default-2026-10-22T03-15-00.000Z.sqlite",
  "pets": ["default"],
  "restoreGeneration": 4,
  "authority": [{ "petId": "default", "authorityId": "…", "epoch": 3, "state": "active" }]
}
```

把 `restoreGeneration`、`authorityId`、`epoch` 记进运维日志；下一次恢复的世代必须比它大。

### 5.2 上次恢复在"发布栅栏后、换库前"崩溃

现象：启动失败并提示 `database restore is older than the recorded restore generation` 或 `database restore generation does not match the recorded restore fence`（`server/src/db.ts:1461-1474`）。

处理：不要手工改栅栏文件凑数。直接重跑第 5.1 节的 `restore`，世代取「比错误信息所对应的当前值再大 1」。`restore` 会把候选库世代、栅栏记录、线上库世代一起纳入最大值计算（`server/src/cli.ts:323-341`），因此重跑一定推进到一致状态。

若线上库在崩溃中损坏到读不出世代，`readLiveRestoreGeneration()` 会按"无记录"处理（`server/src/cli.ts:104-117`），这正是恢复损坏库的入口；此时栅栏记录仍是下限，不能把世代回退。

### 5.3 栅栏文件丢失

现象：启动失败并提示 `database restore generation fence is missing`（配置了栅栏路径、文件不存在、库内世代 > 0）。

处理顺序：

1. 先找回文件（备份介质、上一台主机、配置管理系统的历史版本）。
2. 找不回时，仍走 `restore`：它会用候选库与线上库的最大世代继续推进，并重新写出栅栏文件。
3. 绝不允许手工写一个较小的数字让服务启动——那等于允许已回滚的权威继续服务。

### 5.4 库损坏（无法只读打开）

```bash
# 1) 停服（若还在跑）
sudo systemctl stop qqpet-sync.service

# 2) 整个目录级保留现场：库、侧车、栅栏、备份清单
sudo install -d -m 0700 /var/lib/qqpet-sync/recovery-$(date +%Y%m%dT%H%M%S)
sudo cp -a /var/lib/qqpet-sync/qqpet.sqlite* /var/lib/qqpet-sync/recovery-*/ 2>/dev/null || true

# 3) 从最近一份已校验备份恢复到同一路径
sudo -u qqpet-sync /usr/bin/node /opt/qqpet-sync/dist/server/src/index.js restore \
  --db /var/lib/qqpet-sync/qqpet.sqlite \
  --from <最近一份通过第 4 节校验的备份> \
  --accept-rollback \
  --restore-generation <当前世代 + 1> \
  --owner-admin-credential /etc/qqpet-sync/owner-admin-credential
```

损坏库不需要先删除：`restore` 会把无法读取的线上库视为"无世代记录"，安装阶段用 `.restore-previous` 保留前像并覆盖。保留现场是为了事后查磁盘/文件系统原因，不是恢复步骤的一部分。

## 6. 启动后验证清单

按顺序执行，任一项不通过就停在第 6 节排查，不要继续放流量。

1. 进程活着：`systemctl is-active qqpet-sync.service` → `active`；或 `docker compose ps` → `running (healthy)`。
2. 就绪：`curl --fail http://127.0.0.1:8787/readyz` → HTTP 200，体里 `ready=true`、`databaseReady=true`（`server/src/index.ts:427-430`、`:452-463`）。
3. 存活：`curl --fail http://127.0.0.1:8787/healthz` → 200；该端点不碰数据库，200 不代表可服务。
4. 数据面：`status` 输出的 `revision`、`eventSeq`、`gameTimeMs` 与恢复目标一致；`authority.restoreGeneration` 等于本次 `--restore-generation`。
5. 权威轮换：`authority.authorityId` 与恢复前不同，`epoch` 比备份内值大 1（`server/src/cli.ts:368-388`）。
6. 客户端：任一持有旧权威的客户端应被要求重置（服务端发 `authorityResetRequired` 并关闭旧 socket，`server/README.md:557-561`）；客户端丢弃投影缓存、重新全量快照后命令才可用。不要用"旧客户端还能读"当作恢复正常。
7. 写入冒烟：用一台已配对设备发一条无害命令（如喂食），确认 `commandResult` 成功、`revision` 前进。
8. 新备份：恢复后立刻做一次备份，作为新的回滚点。

```bash
# 4~5 可一次看到
node /opt/qqpet-sync/dist/server/src/index.js status --db /var/lib/qqpet-sync/qqpet.sqlite

# 8 在线备份
sudo -u qqpet-sync /usr/bin/node /opt/qqpet-sync/dist/server/src/index.js backup \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default
```

## 7. 常见故障处置顺序

| 故障 | 处置顺序 | 禁止动作 |
| --- | --- | --- |
| 就绪 503 / `databaseReady=false` | 读 `/health/detail` → 看 `lastErrorEvent` → 只读 `status` → 决定是否按 5.4 恢复 | 反复重启、删 WAL、直接覆盖库 |
| 磁盘写满 | 停服 → 清理日志/临时文件/旧容器层 → 校验剩余备份 → 再启动 | 删备份、删库文件、`docker system prune` 连带卷 |
| 备份失败（`backup.failed`） | 检查备份目录权限与磁盘 → 手工执行一次 CLI backup → 校验产物 | 把"没备份"当成没发生 |
| 调度器不就绪 | 读 `/health/detail` 的 `petHealth`/`catchingUp`/`wallLagMs` → 确认是否追赶中 → 保留库与备份后重启 | 为了"看起来正常"关掉 `advanceWhileEmpty` |
| 设备鉴权异常 | 查 auth/限流计数器与撤销状态 → 用 `ctl revoke-device` 处理丢设备 | 把 token 贴进日志或 URL |
| 恢复锁冲突 | 确认进程确实在跑 → 停服 → 重跑 restore | 删除 `*.server-lock.sqlite` 绕过锁 |

## 8. 回滚本次恢复

`restore` 在自己失败时会自动回滚（库用 `.restore-previous` 换回，栅栏用快照恢复，`server/src/cli.ts:416-436`）。如果恢复已成功但事后判定不合适（例如恢复到了错误备份），不要手工搬文件，而是再执行一次 `restore`，把"恢复前保留的现场副本"作为来源，并把世代再 +1。理由：世代栅栏只接受前进，手工回退会让库内世代与栅栏不一致，启动直接失败。

现场副本的读取方式与普通备份相同（第 4 节校验），但注意它可能包含 `-wal`/`-shm` 侧车；恢复只需要主库文件，`restore` 会复制并清理暂存目录，不会读取现场目录里的侧车。

## 9. 备份与验证节奏

- 定时备份：`qqpet-sync-backup.timer` 每天 03:15，`Persistent=true`（错过会在开机后补跑一次），随机延迟最多 600 秒（`server/deploy/qqpet-sync-backup.timer:4-7`）。
- 备份实现是 SQLite 在线备份 API（`server/src/db.ts:1524-1526`），不是文件复制；用 `cp` 复制运行中的库可能拿到不一致快照或丢 WAL。
- 建议保留：至少 7 份日备、4 份周备、3 份月备；每次恢复/迁移前的现场副本保留到变更被确认。
- 至少一份备份放到不同主机/存储；备份内含哈希后的设备凭据与会话数据，按敏感数据保护。
- 定期演练恢复：用临时目录与临时端口演练完整流程（init → 备份 → 命令 → restore → 起服 → `/readyz`），不要把生产库当练习对象。
- 导入便携包前会自动创建前像备份（`server/src/session.ts:678-693`），失败即导入失败——这条路径不需要额外手工备份，但也不能跳过校验。

## 10. 相关证据与规则

- 历史验收报告与 artifacts 在 `docs/reviews/c12-final-gate/`（只读，含恢复栅栏的端到端证据）；历史设计在 `docs/reviews/legacy/2026-10-20-local-or-server-pet-data-design.md`（只读）。
- 新的恢复演练证据写到 `.agent-reports/acceptance/`（报告 `<YYYY-MM-DD>-c12-final-gate.md`，artifacts 在 `artifacts/c12-*/`）；纯排查过程的临时输出放 `tmp/reports/`，不作为交付证据。
- 数据层不变量与恢复实现说明见 [服务端数据与恢复世代](../architecture/server-data.md)；部署参数与健康端点语义见 [服务端部署指南](../guides/server-deployment.md)；门禁命令与证据校验见 [质量门禁与证据](../guides/quality-gates.md)。
