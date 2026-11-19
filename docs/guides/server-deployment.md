# 服务端部署指南

> 结论：服务端是一个非 root 运行的 Node 进程，只监听 loopback 上的明文 HTTP/WebSocket，由前置代理（Caddy 或 Nginx）终结 TLS；对外只应暴露 `wss://`。配置全部来自 `QQPET_SYNC_*` / `QQPET_OWNER_ADMIN_CREDENTIAL*` 环境变量且必须是绝对路径，缺项、相对路径、非法整数一律在启动时抛错——没有隐式默认兜底。容器采用只读根文件系统、tmpfs、`no-new-privileges`，owner 凭据经 secret 挂载后在入口脚本里降权落到 tmpfs。

## 1. 部署拓扑

代码位置写作 `path:line`。省略前缀的约定：`config.ts`、`db.ts`、`index.ts`、`logging.ts`、`metrics.ts` 在 `server/src/`；`Caddyfile`、`nginx.conf.example`、`qqpet-sync*.service`、`qqpet-sync-backup.timer` 在 `server/deploy/`；`Dockerfile`、`docker-compose.yml`、`docker-entrypoint.sh`、`.env.example` 在 `server/`。

```
客户端 wss:// ──► Caddy / Nginx (TLS, 443) ──► 127.0.0.1:8787 (qqpet-server, plain ws/http)
                                                    │
                                                    └─ /var/lib/qqpet-sync/{qqpet.sqlite, backups/, restore-generation.txt, client-data/}
```

- 服务端本身不实现 TLS：`server/src/index.ts` 用 `node:http` + `ws` 监听 `bind:port`，WebSocket 路径固定 `/sync` 与 `/v1/sync`（`index.ts:155-169`）。
- `server/deploy/Caddyfile` 是推荐路径：自动申请证书、代理 WebSocket 升级、把 `/healthz`、`/health`、`/health/detail`、`/readyz` 显式转发（`Caddyfile:5-20`）。
- `server/deploy/nginx.conf.example` 是等价示例：`/v1/sync`、`/sync` 显式 `Upgrade`/`Connection` 头、`proxy_http_version 1.1`、3600 秒读写超时、`client_max_body_size 20m`（`nginx.conf.example:28-55`）；健康端点单独转发（`nginx.conf.example:57-79`）；公开只读客户端数据走 `location ^~ /v1/client/`，`proxy_read_timeout 3600s`、`proxy_send_timeout 3600s`、`proxy_buffering off`，不缓存大包（`nginx.conf.example:85-93`）。
- 生产环境不要直接发布 8787 到公网；Compose 里也只映射到 `127.0.0.1:8787`（`docker-compose.yml:51-52`）。

明文 `ws://` 只在受信网络成立：桌面客户端仅对 loopback 与私有/本机地址字面量（RFC1918、IPv4 link-local、CGNAT/Tailscale `100.64.0.0/10`、IPv6 ULA/link-local）接受明文连接，远程或路由网络必须 TLS（`server/README.md:600-604`）。这是客户端的判定，不是服务端的放行策略——服务端始终只讲明文，由代理负责加密。

## 2. 配置项（全部有代码出处）

配置解析只发生在 `createServerConfig()`（`server/src/config.ts:87-157`）。路径类参数统一经 `absolutePath()`，非绝对路径直接抛 `must be an absolute path`（`config.ts:65-68`）。

| 变量 / 输入 | 代码默认 | 约束与说明 |
| --- | --- | --- |
| `QQPET_SYNC_BIND` | `127.0.0.1` | 监听地址；`config.ts:107` |
| `QQPET_SYNC_PORT` | `8787` | 整数 `0..65535`；`config.ts:108` |
| `QQPET_SYNC_DB` | `$HOME/.local/share/qqpet-sync/qqpet.sqlite` | 绝对路径；`config.ts:89` |
| `QQPET_SYNC_BACKUP_DIR` | 库同级的 `backups/` | 绝对路径；`config.ts:90-93` |
| `QQPET_SYNC_CLIENT_DATA_DIR` | 库同级的 `client-data/` | 绝对路径；客户端数据目录，启动时 `mkdir`；`config.ts:98-101` |
| `QQPET_SYNC_RESTORE_GENERATION_FILE` | 未设置 | 绝对路径；设置后启动强校验世代栅栏；`config.ts:104`、`:113-115` |
| `QQPET_ADMIN_SOCKET` | 库同级 `admin-<hostname>.sock` | 绝对路径；本版本为预留项，控制面走 loopback WebSocket；`config.ts:94-97` |
| `QQPET_OWNER_ADMIN_CREDENTIAL` | 未设置 | 指向 `0600` 凭据文件的绝对路径；`config.ts:105`、`:116-118` |
| `QQPET_SYNC_TIME_ZONE` | 宿主时区 | 必须是合法 IANA 时区，`assertTimeZone` 校验；`config.ts:102-103` |
| `QQPET_SYNC_WEATHER_LOCATION` | 空 | 初始天气城市（宠物引擎用，`/v1/client/weather` 不读它）；`config.ts:120` |
| `QQPET_SYNC_WEATHER_UPSTREAM` | `https://wttr.in` | `/v1/client/weather` 的代理上游，必须是绝对 `http(s)` URL；`config.ts:121-124` |
| `QQPET_SYNC_WEATHER_TIMEOUT_MS` | `10000` | 天气上游请求超时，整数 `1000..60000`；`config.ts:125` |
| `QQPET_SYNC_WEATHER_CACHE_MS` | `600000` | 服务端天气缓存 TTL，整数 `0..3600000`，0 关闭缓存；`config.ts:126` |
| `QQPET_SYNC_ADVANCE_WHILE_EMPTY` | `true` | 只接受 `0/1/true/false`；`config.ts:57-63`、`:127-131` |
| `QQPET_SYNC_CATCHUP_CHUNK_TICKS` | `1440` | 追帧分片，整数 ≥ 1；`config.ts:132` |
| `QQPET_SYNC_COMMAND_RETENTION` / `QQPET_SYNC_EVENT_RETENTION` | `10000` / `10000` | 每宠物保留行数；`config.ts:133-134` |
| `QQPET_SYNC_LOG_RETENTION_DAYS` | `30` | 日志保留；`config.ts:135` |
| `QQPET_SYNC_MAX_FRAME_BYTES` | `16777216` | 帧上限，≥ 1024；`config.ts:136` |
| `QQPET_SYNC_MAX_COMMAND_BYTES` | `262144` | 命令体上限；`config.ts:137` |
| `QQPET_SYNC_MAX_PRE_AUTH_CONNECTIONS` | `64` | 未认证连接上限；`config.ts:141-146` |
| `QQPET_SYNC_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`；`config.ts:155` |

另有若干限制只存在于代码、不接受环境变量：快照上限 16 MiB、重放上限 10000 事件、每宠物 8 连接、hello 超时 5 秒、空闲 60 秒、ping 20 秒、命令速率 10/s 突发 20、配对码 10 分钟、调度轮询 1 秒（`config.ts:138-154`；`server/README.md:250-254`）。要改这些必须改代码并走评审，不能靠改部署环境。

### 客户端数据目录（client-data）

`QQPET_SYNC_CLIENT_DATA_DIR`（默认库同级 `client-data/`）存放客户端展示数据：`release.json`（更新检查，`{version, url}`）、`packs.json`（内容包索引，由发布脚本的 `packs-server.json` 复制而来，`url` 为裸文件名）、`*.qqpetpack`（内容包文件）。启动时自动 `mkdir`（`server/src/index.ts:192`）；`/v1/client/release`、`/v1/client/packs.json`、`/v1/client/packs/<name>` 都从这里读取，缺文件分别回 404 `release_unavailable`/`packs_unavailable`，索引非法回 503。发布时把 `packs-server.json` 复制成 `client-data/packs.json`、把包文件放进同一目录即可（见 [内容包与构建](content-packs-and-builds.md) 第 4 节）。

`server/.env.example` 是唯一可参考的环境样例（含 Docker 专用说明），真实凭据绝不写进文件。

## 3. 容器部署

### 3.1 镜像

`server/Dockerfile` 是两阶段构建，必须从仓库根构建，因为服务端在编译时导入 `src/shared/**`：

```bash
docker build -f server/Dockerfile -t qqpet-server .
```

- 构建阶段 `node:22-bookworm-slim`，`npm ci --prefix server --ignore-scripts` → `npm --prefix server run build` → `npm prune --omit=dev`（`Dockerfile:4-11`）。
- 运行阶段只拷 `package.json`、`node_modules`、`dist`，`USER node:node`，数据目录 `/var/lib/qqpet-sync` 归 node 所有（`Dockerfile:13-29`）。
- 镜像自带 `/healthz` HEALTHCHECK（30 秒间隔、5 秒超时、3 次重试、15 秒启动宽限），打的正是存活探针（`Dockerfile:30-31`）。

### 3.2 Compose

`server/docker-compose.yml` 定义 `qqpet-sync` 与 `caddy` 两个服务：

- 只读根 + `no-new-privileges`（`docker-compose.yml:9-11`）；可写位置只有命名卷 `/var/lib/qqpet-sync` 与两个 tmpfs（`/tmp` 32m noexec nosuid、`/run/qqpet-secrets` 64k 0700）（`docker-compose.yml:44-48`）。
- `client-data/` 落在该命名卷内的 `/var/lib/qqpet-sync/client-data`（`docker-compose.yml:22`、`:44-45`、`:77-78`）；镜像根只读，operator 把 `release.json`、`packs.json`、`*.qqpetpack` 放进卷（或挂载只读副本），重启即由 `/v1/client/*` 提供。
- secret 挂载与降权：服务以 `user: "0:0"` 启动，入口脚本是 `/usr/local/bin/qqpet-docker-entrypoint.sh`，它在容器内 `install -m 0400 -o node` 把 `/run/secrets/owner_admin_credential` 复制到 `/run/qqpet-secrets/owner_admin_credential`，再 `exec setpriv --reuid … node dist/server/src/index.js`（`docker-entrypoint.sh:6-25`、`docker-compose.yml:38-43`）。之所以要这一步：文件型 secret 在 bind-backed 引擎上会保留宿主 uid/mode，非 root 用户读不到。
- 缺配置即失败：`QQPET_OWNER_ADMIN_CREDENTIAL_FILE` 用 `${VAR:?…}` 插值，未设置或为空时 `docker compose config` 直接失败（`docker-compose.yml:33-34`、`:82-84`）；入口脚本对 `QQPET_OWNER_ADMIN_CREDENTIAL_SOURCE`、`QQPET_OWNER_ADMIN_CREDENTIAL` 用 `${VAR:?}` 并在文件缺失/为空时 `exit 1`（`docker-entrypoint.sh:6-18`）。
- 端口只发布到 loopback，Caddy 依赖健康检查通过后才启动（`docker-compose.yml:51-52`、`:63-65`）。

首次部署顺序：

```bash
cd server
cp .env.example .env
# 编辑 .env：QQPET_DOMAIN 指向本机 DNS 名
umask 077
mkdir -p deploy
printf '%s\n' '<existing-owner-device-token>' > deploy/owner-admin-credential
chmod 0600 deploy/owner-admin-credential
export QQPET_OWNER_ADMIN_CREDENTIAL_FILE="$PWD/deploy/owner-admin-credential"
docker compose config >/dev/null      # 缺变量/缺文件在此失败
docker compose up -d --build
curl --fail http://127.0.0.1:8787/readyz
docker compose exec qqpet-sync node dist/server/src/index.js init \
  --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default \
  --time-zone Asia/Shanghai --weather-city 北京
```

凭据文件必须是**该库里已配对、未撤销的 owner 设备 token**；随便生成一个随机串不会被 restore/control 接受（`server/README.md:305-307`）。

## 4. systemd 部署

模板在 `server/deploy/`：

- `qqpet-sync.service`：`User=qqpet-sync`/`Group=qqpet-sync`、`EnvironmentFile=/etc/qqpet-sync.env`、`ExecStart=/usr/bin/node /opt/qqpet-sync/dist/server/src/index.js start`、`Restart=always`、`TimeoutStopSec=30`、`UMask=0077`；沙箱项为 `NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome`、`ProtectKernelTunables`、`ProtectKernelModules`、`ProtectControlGroups`、`RestrictSUIDSGID`、`LockPersonality`；可写路径只有 `StateDirectory=qqpet-sync`（`/var/lib/qqpet-sync`，0700）与 `ReadWritePaths`（`qqpet-sync.service:6-29`）。
- `qqpet-sync-backup.service`：oneshot，`After=` 且 `Requires=qqpet-sync.service`，执行 `backup --db /var/lib/qqpet-sync/qqpet.sqlite --pet-id default`，`Nice=10`（`qqpet-sync-backup.service:1-13`）。
- `qqpet-sync-backup.timer`：`OnCalendar=*-*-* 03:15:00`、`Persistent=true`、`RandomizedDelaySec=600`（`qqpet-sync-backup.timer:4-7`）。`Persistent=true` 表示关机错过的一次会在开机后补跑一次。

安装与启动（命令与 `server/README.md:427-464` 一致）：

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin qqpet-sync
sudo install -d -o qqpet-sync -g qqpet-sync -m 0700 /opt/qqpet-sync
sudo cp -a server/package.json server/node_modules server/dist /opt/qqpet-sync/
sudo install -d -o qqpet-sync -g qqpet-sync -m 0700 /var/lib/qqpet-sync
sudo install -m 0644 server/deploy/qqpet-sync.service /etc/systemd/system/
sudo install -m 0644 server/deploy/qqpet-sync-backup.service /etc/systemd/system/
sudo install -m 0644 server/deploy/qqpet-sync-backup.timer /etc/systemd/system/
sudo install -m 0600 /dev/null /etc/qqpet-sync.env
sudo systemctl daemon-reload
sudo systemctl enable --now qqpet-sync.service
sudo systemctl enable --now qqpet-sync-backup.timer
```

`/etc/qqpet-sync.env` 放非敏感配置，owner 凭据放 `/etc/qqpet-sync/owner-admin-credential`（`0600`，属主 `qqpet-sync`）。凭据文件内容不是环境变量格式，所以不能塞进 `EnvironmentFile`。

## 5. 健康与就绪语义

三个 HTTP 端点行为不同，选错会把「进程活着」当成「可服务」：

| 端点 | 行为 | 是否触碰数据库 |
| --- | --- | --- |
| `GET /healthz` | 恒返回 200 `{ok:true, service, live:true}`；存活探针，进程在就返回 | 否（`index.ts:443-447`） |
| `GET /readyz` | `health.ready` 为真返回 200，否则 503；体是聚合信息 `{ok, service, live, ready, pets, catchingUp, databaseReady, hasError}` | 是（只读探测，带 5 秒缓存） |
| `GET /health` | 无 `Authorization` 且不带 `detail` 时返回同样的公开聚合体 | 是 |
| `GET /health/detail` 或带 `detail=1` | 必须 `Authorization: Bearer <owner device token>`；非 owner 返回 403，缺失/撤销返回 401 | 是，返回完整计数器与宠物级健康 |

`ready` 的构成条件包括：数据库可写、`quick_check` 通过、覆盖区间一致、权威宠物未损坏、调度器就绪、authority 处于活动状态（`server/README.md:271-273`，计算在 `index.ts:258-409`）。写探测用「`BEGIN IMMEDIATE` + 同值 `UPDATE` + `ROLLBACK`」验证可写性，回滚保证探测不可观测（`db.ts:441-479`）；该探测按 `OPERATIONAL_HEALTH_CACHE_TTL_MS = 5_000` 缓存（`db.ts:16`、`:422-434`），避免未认证流量把每次就绪请求变成一次写锁尝试。`/healthz` 刻意不跑任何 PRAGMA（`index.ts:444-446`）。

启动阶段还有两条失败关闭：先校验恢复世代栅栏（`index.ts:195`），再逐宠物解码权威快照，任何一只损坏都不开始监听（`index.ts:197`）。

## 6. 日志与指标

- 日志是逐行 JSON，字段 `ts`、`level`、`event` 加白名单字段；键名命中 `token|pairing|secret|credential|answer|save|payload|authorization|authframe` 的字段被直接丢弃，长期字符串截到 256 字符（`server/src/logging.ts:11-23`）。
- `warn`/`error` 写 stderr，其余写 stdout（`logging.ts:35-36`），便于容器与 journald 分别收集。
- 指标是内存计数器（`server/src/metrics.ts:1-15`），只能通过 owner 认证的 `/health/detail` 读取，按前缀分组：命令、鉴权、限流、备份、调度（`index.ts:352-366`）。没有独立的 Prometheus 端点。

## 7. 不变量清单

1. 服务进程只监听 loopback 明文；TLS 由代理终结，公网不发布 8787。
2. 路径配置必须是绝对路径；整数配置必须在范围内；非法值在 `createServerConfig()` 抛错，进程不启动。
3. 缺 owner 凭据、凭据文件为空、凭据不是库内未撤销 owner：Compose 插值、入口脚本、`restore`/`ctl` 三处分别显式失败。
4. 容器根只读，可写面只有数据卷与两个 tmpfs；服务最终以非 root `node` 身份执行。
5. `/healthz` 不碰数据库；`/readyz` 才代表可服务；详细健康必须 owner 令牌。
6. 备份由 timer 或 CLI 触发，走 SQLite 在线备份；不得用 `cp` 复制运行中的库文件。
7. 恢复世代文件在库外、独立于备份，必须与库内世代一致，启动时强校验。

## 8. 验证命令

```bash
# 前置：服务端产物（下面的 node 命令都跑 dist）
npm --prefix server run build

# 1) 配置解析：非绝对路径/越界整数应失败（不启动服务）
QQPET_SYNC_DB=relative.sqlite node server/dist/server/src/index.js status   # 期望非 0，报 must be an absolute path

# 2) Compose 失败关闭：未设置凭据文件变量时必须失败
( unset QQPET_OWNER_ADMIN_CREDENTIAL_FILE; cd server && docker compose config >/dev/null )   # 期望非 0

# 3) 镜像构建与启动（在仓库根）
docker build -f server/Dockerfile -t qqpet-server .
# 4) 就绪与存活
curl --fail http://127.0.0.1:8787/readyz
curl --fail http://127.0.0.1:8787/healthz

# 5) 与 CI 等价的部署冒烟（Compose 失败关闭 + 镜像/备份恢复 + TLS/WSS 代理）
npm run smoke:compose
npm run smoke:docker
QQPET_PROXY_NGINX_IMAGE=nginx:1.27-alpine npm run smoke:proxy

# 6) systemd 部署后
sudo systemctl status qqpet-sync.service
systemctl list-timers qqpet-sync-backup.timer
journalctl -u qqpet-sync.service -n 50 --no-pager
```

`smoke:*` 三个脚本会在本地构建/启动临时容器并在结束后清理；它们也是 `ci.yml` 的 `docker-smoke`、`proxy-wss` 作业内容。

## 9. 变更影响

- 改 `config.ts` 的变量名或默认值：部署侧的 `.env.example`、Compose 环境、systemd `EnvironmentFile`、本文档必须同步；旧部署会静默沿用旧默认（例如 bind 从 loopback 变成 `0.0.0.0` 属于安全边界变更）。
- 改 `bind`/端口发布：会改变「只有代理能访问」的前提，属于重大变更，需要同步评审 Caddyfile/Nginx 示例。
- 改入口脚本的降权方式或 secret 路径：容器可能以 root 跑业务进程，或非 root 读不到凭据；两种都会在运行时才暴露。
- 改健康检查语义（例如让 `/healthz` 访问数据库）：会让 Docker/K8s 在数据库抖动时重启进程，放大故障。
- 改备份 timer 时间或 `Persistent`：影响错过补跑与备份窗口，需在 `docs/runbooks/server-recovery.md` 的恢复步骤里同步。
- 改 `verifyRestoreGeneration` 的启动时机（移到监听之后）：会短暂提供被回滚的权威服务，破坏恢复栅栏。
