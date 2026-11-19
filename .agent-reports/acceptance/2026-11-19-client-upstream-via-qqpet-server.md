# 验收报告：客户端数据上游迁移到 qqpet-server

- 结论：**通过**。客户端运行时代码中已无 `api.ankio.net`；更新、天气、日历、内容包均改由 `qqpet-server` 的 `/v1/client/*` 提供；独立验收在修复旧 `RemoteProjectionCacheV2` 回填 blocking 后判定 PASS。
- Tree：`tree-1be0e55887e9e4c6`（用 qqpet-server 替代 ankio.net 上游）
- 分支 / 基线：`feat-client-upstream` / `5af1f0cebaaef91a1cfed6a98deb22efc84b4701`
- 验收时间：2026-11-19（Asia/Shanghai）
- 说明：按仓库规范未 commit / 未 merge；工作区改动见 `git status`。

## 1. 交付内容

### 服务端

- 新增 `server/src/client-data.ts`：release 文件校验、weather 代理/有界 LRU/single-flight、calendar 本地计算、packs 索引改写、pack 文件路径校验与 ETag。
- `server/src/index.ts`：`/v1/client/{release,weather,calendar,packs.json,packs/<name>}`，公开只读 GET；流式 pack 响应、304、错误处理。
- `server/src/config.ts`：`QQPET_SYNC_CLIENT_DATA_DIR`、`QQPET_SYNC_WEATHER_UPSTREAM`、`QQPET_SYNC_WEATHER_TIMEOUT_MS`、`QQPET_SYNC_WEATHER_CACHE_MS`。
- `server/.env.example`、`docker-compose.yml`、`deploy/nginx.conf.example`、`server/README.md` 同步。
- `server/test/client-data.test.ts`：15 个真实服务端 HTTP 测试（release/weather/cache/calendar/packs/304/遍历/GET-only/config）。

### 客户端

- 新增 `src/shared/upstream.ts`：ws(s)→http(s) origin、公网明文拒绝、`upstream_not_configured`。
- 新增 `src/shared/calendar-data.ts`：农历、24 节气、2025–2027 法定节假日/调休；无网络。
- `src/shared/update.ts` / `weather.ts` / `calendar.ts`：改为从 qqpet-server base 取数；天气保留完整 8 段由客户端按本地小时过滤；日历无上游时本地计算。
- 设备本地 `settings.upstreamUrl`：默认空、永不上传；server 存储模式自动用 `serverUrl`；`setup` 关于页可配置。
- `src/main/*`、`src/preload/*`、`src/renderer/*`、三端 bridge：更新/天气/日历/内容包接入与首启地址回填。
- 内容包：`findFull(serverUrl)` / `download(serverUrl)`；`packUrl` 在 base 非空时只接受本服务器相对文件，拒绝绝对/跨主机 URL；`scripts/pack-content.mjs` 同时生成 `packs.json`（旧客户端/GitHub 绝对 URL）与 `packs-server.json`（qqpet-server 相对 URL）。
- 旧数据兼容：`backfillDeviceLocalSettingsDefaults` / `backfillRemoteProjectionCacheDefaults`；旧 local v2 文档与旧远程投影缓存缺 `upstreamUrl` 时补空串，不再被删除或判损坏。

### 文档

- 新增已批准规格 `docs/specs/client-upstream-via-qqpet-server.md`。
- 更新 `docs/specs/README.md`、`docs/README.md`、`docs/architecture/{sync-protocol,desktop-ipc-and-preload,pet-runtime-and-save}.md`、`docs/guides/{server-deployment,content-packs-and-builds}.md`、`docs/runbooks/server-recovery.md`。

## 2. 验证证据

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run typecheck` | 0 | 根仓库 node/web/harmony/e2e 四套通过 |
| `npm --prefix server run typecheck` | 0 | 服务端通过 |
| `npm run test:compat` | 0 | 848 tests / 846 pass / 0 fail / 2 skipped |
| `npm --prefix server test` | 0 | 104 tests / 104 pass / 0 fail |
| `npm --prefix server run build` | 0 | `tsc -p tsconfig.build.json` + `fix-esm-imports` 完成 |
| 目标测试 8 个文件（upstream/calendar-data/client-upstream-data/wiring/sync-data-boundary/content-pack/lite-shell/deployment-config） | 0 | 78 tests / 78 pass |
| `npm run build` | 0 | 主进程/preload/renderer 构建完成，Ruffle Safari14 fallback validated |
| `npm run check:docs` | 0 | 结构/索引/链接/代码引用通过 |
| `npm run test:docs` | 0 | 106 tests / 106 pass |
| `grep -R "api.ankio.net" src server` | 1（无匹配） | 运行时代码中已无旧域名 |

### 真实服务端冒烟

在临时 SQLite + 临时 `client-data` 上启动 `server/dist/server/src/index.js start`：

- `GET /v1/client/release` → 200 `{"version":"0.9.0","url":"..."}`。
- `GET /v1/client/calendar?from=2026-11-19&days=2` → `2026-11-19 十月十一`、`2026-11-20 十月十二`。
- `GET /v1/client/packs.json` → 相对 `url` 被改写为 `/v1/client/packs/QQPet-content-0.9.0.qqpetpack`。
- `GET /v1/client/packs/<name>` → 返回 3 字节 `abc`，sha256 与索引一致。
- 服务端测试覆盖：缺文件 404、非法索引 503、绝对 packs URL 503、目录遍历/非法名 400、304、天气缓存/并发合并/超时/超大响应、空 city 使用上游根路径。

### 独立验收

- `final-verifier`（未参与实现）首轮发现 blocking：旧 `RemoteProjectionCacheV2` 缺 `upstreamUrl` 会被 `PairingStore.loadProjectionCache` 判非法并删除。
- 修复后在临时目录真实调用 `PairingStore.loadProjectionCache()` 得到 `{loaded:true, upstreamUrl:"", cacheStillExists:true}`；复验结论 **PASS**，无剩余 blocking。

### E2E 边界

`npm run test:e2e:main-process` 在“first-run adopt on empty server and two-client convergence”步骤失败（`owner-electron has exited`）。同一命令在未修改的 `main` 检出 `5af1f0ce` 上复现完全相同的失败，属于本机 Electron/E2E 环境问题，不是本次改动回归；因此未把该结果作为通过证据，记录为剩余未知。

## 3. 剩余风险与未知

1. **农历表范围**：已改用 `src/shared/lunar.ts` 的 1900–2100 月表（源自 solarlunar，ISC），2027 正月按发布日历为 2027-02-06 初一；表外日期回退 ICU 仅用于历史回放。2028+ 节假日表未内置，返回 `holiday: null`，发布流程需每年刷新。
2. **旧客户端**：已发布外壳仍读 GitHub `releases/latest/download/packs.json` 与旧 ankio；本次不改旧索引，旧客户端是否可用不由本变更负责。新客户端不再读 GitHub 运行时索引。
3. **公开端点无认证**：`/v1/client/*` 设计为公开只读；部署层需自行限流/防滥用，服务端已有天气缓存上限与 2 MiB 响应上限，但未实现应用层 IP 限流。
4. **Lite 首启需要 qqpet-server 地址**：完整安装包不受影响；没有服务器时可手动导入 `.qqpetpack`。
5. **构建环境**：本 worktree 使用主 checkout 的 `node_modules` 软链，`viteStaticCopy` 不跟随软链导致 Ruffle 插件首次构建失败；用临时本地 `@ruffle-rs/ruffle` 副本后 `npm run build` 退出 0。这是检出布局问题，不是源码回归。
6. **未提交**：按 `AGENTS.md` 未执行 `git add/commit/merge`；分支可供评审后合并。
