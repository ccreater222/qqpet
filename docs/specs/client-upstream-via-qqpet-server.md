# qqpet client 以 qqpet-server 为客户端数据上游

> 结论：把客户端对 `api.ankio.net` 的更新检查、天气、农历/节假日三条运行时接口，以及 GitHub 的 `packs.json` / `.qqpetpack` 内容包通道，统一迁到 `qqpet-server` 的新 `/v1/client/*` HTTP API；服务端负责天气上游代理、日历本地计算、发布清单与内容包文件托管。客户端不再硬编码任何第三方数据域名；未配置上游的本地模式使用本机日历计算、天气不可用、更新不可用。

## 1. 背景与问题

当前客户端有三条运行时请求直接指向 `api.ankio.net`：

- `src/shared/update.ts:5`：更新检查（GitHub Release 代理）。
- `src/shared/weather.ts:5`：天气（服务端 302 到 wttr.in）。
- `src/shared/calendar.ts:4`：农历/节气/节假日，一次并发 31 天。

`api.ankio.net` 已不受支持，继续依赖会让更新、天气、日历同时失效；同时内容包索引 `src/main/content.ts:50` 仍指向已 404 的上游仓库。项目已有 `qqpet-server`（`server/`）作为宠物权威数据服务器，但当前只提供健康检查与 `/v1/sync` WebSocket，没有任何客户端数据 HTTP API，也没有出站网络（`server/src/index.ts:414-450`）。

第一性原理：这些数据的消费者是客户端展示层，不需要把第三方 URL 散落在每个客户端；应该由用户已经部署的 `qqpet-server` 成为唯一客户端数据上游，服务端集中做代理、缓存、计算与文件托管。服务端的宠物引擎天气仍保持确定性种子兜底，不在本变更中改写 `engine.environment`，避免触碰存档/回放契约。

## 2. 范围

### 2.1 本次实现

1. 新增 `qqpet-server` 的客户端数据 HTTP API（公开只读，GET）：
   - `GET /v1/client/release`：更新检查。
   - `GET /v1/client/weather?city=`：天气。
   - `GET /v1/client/calendar?from=YYYY-MM-DD&days=31`：农历/节气/节假日。
   - `GET /v1/client/packs.json`：内容包索引。
   - `GET /v1/client/packs/<name>.qqpetpack`：内容包文件。
2. 客户端新增设备本地设置 `settings.upstreamUrl`（可选）：未进入 server 存储模式时，用它指向 qqpet-server 获取上述数据；server 存储模式下自动使用已配对的 `serverUrl`。
3. 客户端删除三处 `api.ankio.net` 常量与 GitHub `packs.json` 常量，改为从上游地址取数据；本地无上游时：
   - 日历：用共享纯函数本地计算（农历/节气/内置节假日表）。
   - 天气：不可用（`upstream_not_configured`），宠物不播报天气。
   - 更新检查：不可用（手动检查提示“未配置上游服务器”）。
4. Lite 首启窗口新增 `qqpet-server` 地址输入；内容包从服务端 `/v1/client/packs.json` 与包文件下载，仍按原 `size`/`sha256` 校验。
5. 服务端配置、部署代理与文档同步。

### 2.2 非目标

- 不把真实天气/日历写入 `engine.environment` 或 `pet_settings`；服务端宠物引擎继续使用 `seedHex + dayKey` 的确定性天气兜底。若以后要让真实天气影响游戏规则，另立规格门禁。
- 不改变 `/v1/sync` WebSocket 协议、存档 schema、权威/恢复世代。
- 不删除 GitHub 上的发布工作流；GitHub 仍可作为人工发布渠道，只是不再被客户端运行时直接读取。
- 不做多租户或公网 SaaS 部署改造。

## 3. 术语与地址约定

- **上游地址**：客户端视角的 qqpet-server HTTP origin，例如 `https://pet.example.com`。它可以从 `wss://pet.example.com/v1/sync` 或 `ws://127.0.0.1:8787/v1/sync` 推导：协议换成 http/https，去掉 `/v1/sync` / `/sync` 路径。纯函数放在 `src/shared/upstream.ts`。
- **本地模式**：`storage` 不处于 server 模式（桌面默认），或移动端（始终本地）。
- **server 存储模式**：桌面已配对并切到服务器存储；上游地址取 `StorageStatusView.serverUrl`，优先于 `settings.upstreamUrl`。

## 4. 服务端设计

### 4.1 新增配置（`server/src/config.ts`）

| 配置 / env | 默认 | 说明 |
|---|---|---|
| `QQPET_SYNC_CLIENT_DATA_DIR` | `<db 同级>/client-data` | 绝对路径；存放 `release.json`、`packs.json`、`*.qqpetpack`。启动时 `mkdir`。`packs.json` 由发布脚本的 `packs-server.json` 复制而来。 |
| `QQPET_SYNC_WEATHER_UPSTREAM` | `https://wttr.in` | 天气代理上游，必须是 `http(s)` URL。 |
| `QQPET_SYNC_WEATHER_TIMEOUT_MS` | `10000` | 上游请求超时，整数 1000..60000。 |
| `QQPET_SYNC_WEATHER_CACHE_MS` | `600000` | 服务端天气缓存 TTL，整数 0..3600000；0 关闭缓存。 |

`client-data` 目录与数据库同卷（Docker `/var/lib/qqpet-sync`、systemd `StateDirectory` 均已是唯一可写路径）。

### 4.2 API 契约

所有接口 `GET`，公开只读，JSON 响应 `content-type: application/json; charset=utf-8`。错误统一 `{ "ok": false, "error": "<code>" }`，不返回上游原始错误体。

#### `GET /v1/client/release`

`client-data/release.json` 形如：

```json
{ "version": "0.8.2", "url": "https://github.com/TinyBrian/qqPet/releases/tag/v0.8.2" }
```

- 200：原样返回 `{version, url}`（version 去掉 `v` 前缀；url 必须是绝对 `http(s)`）。
- 404：`release_unavailable`（文件不存在）。
- 503：`release_invalid`（JSON/字段非法）。

#### `GET /v1/client/weather?city=`

- `city` 可选，最长 64 字符；为空时请求上游根路径，由 wttr.in 按**服务端出口 IP**定位（不读取宠物设置）。
- 服务端请求 `${QQPET_SYNC_WEATHER_UPSTREAM}/${encodeURIComponent(city)}?format=j1`，超时 `weatherTimeoutMs`。
- 响应体为客户端现有 `Weather`，`hours` 返回完整 8 个 3 小时时段；客户端按自己的本地小时过滤。
- 200 成功；502 `weather_upstream_failed`；504 `weather_upstream_timeout`；503 `weather_unavailable`（无城市且无法定位）。
- 进程内按 `city` 缓存 `weatherCacheMs`，命中不请求上游；缓存不持久化。

#### `GET /v1/client/calendar?from=YYYY-MM-DD&days=31`

- `from` 缺省为服务端当前本地日期；`days` 1..31，默认 31。
- 200：`CalendarDay[]`，每项 `{date,lunar,term,holiday}`，与 `src/shared/ipc.ts:158-167` 完全一致。
- 400：`invalid_range`（日期/天数非法）。
- 农历用 `src/shared/lunar.ts` 内置的 1900–2100 月表转换（数据/算法源自 solarlunar，ISC），不依赖 ICU；节气用标准 24 节气近似算法；法定节假日/调休用 `src/shared/calendar-data.ts` 内置的 2025–2027 数据（来源 holiday-cn，MIT），超出年份 `holiday: null`。
- 纯计算，无网络、无缓存。

#### `GET /v1/client/packs.json`

- 读取 `client-data/packs.json`（由发布产物 `packs-server.json` 复制而来），schema 同 `PackIndex`（`src/main/content-pack.ts:29-43`）。
- 只接受相对 `url`（例如 `QQPet-content-0.8.2.qqpetpack`）；服务端把每个 `url` 改写为 `/v1/client/packs/<encodeURIComponent(name)>`。绝对 URL 视为非法，确保客户端只从本服务器下载。
- 200；404 `packs_unavailable`；503 `packs_invalid`（JSON/schema/url 非法）。

#### `GET /v1/client/packs/<name>.qqpetpack`

- 文件名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.qqpetpack$`；解析后必须位于 `client-data` 目录内。
- 200：流式返回文件，`content-type: application/octet-stream`、`content-length`、`etag`（sha256 或 stat 生成）、`cache-control: public, max-age=31536000, immutable`；`If-None-Match` 命中返回 304。
- 404 `pack_not_found`；400 `invalid_pack_name`。

### 4.3 实现结构

- 新增 `server/src/client-data.ts`：
  - `ClientDataService` 接收 `config`、`DatabaseStore`、注入的 `fetch` 与 `now`。
  - 负责 release 读取、weather 代理/缓存、calendar 计算、packs 索引改写、包文件路径校验与 stat。
  - 不直接写 HTTP response；只返回数据/DTO/错误码，便于单测。
- `server/src/index.ts`：
  - `handleHttp` 改为 async，`createServer` 回调加 `.catch`，任何内部错误返回 500 `{ok:false,error:'internal_error'}`。
  - 在健康检查前分派 `/v1/client/*`。
  - 新增 `streamFile()` 处理 304/206? 本次只支持 200/304 与完整流式下载，不做 Range（客户端不需要断点续传）。
- 不改 `server/src/db.ts` schema；release/packs 只读文件系统。

### 4.4 部署

- `server/deploy/nginx.conf.example` 增加 `location ^~ /v1/client/`（`proxy_pass`、`proxy_read_timeout 300s`、`proxy_buffering off`、`client_max_body_size` 不适用 GET）；`scripts/tests/deployment-config.test.mjs` 与 `scripts/e2e/proxy-smoke.mjs` 同步断言。
- Caddy 的 catch-all `reverse_proxy` 已能透传，无需改 Caddyfile；文档澄清。
- `server/README.md` 的端点表、`docs/guides/server-deployment.md` 的配置表、`server/.env.example`、`docker-compose.yml` 增加新 env。
- Docker 保持只读根；`client-data` 落在 `/var/lib/qqpet-sync/client-data`，operator 将发布文件放入卷。

## 5. 客户端设计

### 5.1 新增上游地址工具 `src/shared/upstream.ts`

```ts
export function httpBaseFromServerUrl(value: string): string | null
export function normalizeUpstreamUrl(value: string): string | null
export function clientUrl(base: string, path: string): string
```

- 接受 `wss://` 完整 `/v1/sync` 地址或 `https://` origin；`ws://` / `http://` 仅允许 loopback/私网字面地址，公网明文一律拒绝。
- 非法值返回 `null`，由调用方显式报 `upstream_not_configured`，不静默回退第三方。

### 5.2 `settings.upstreamUrl`

- 加入 `Settings` / `DeviceLocalSettings`，默认 `''`，设备本地、永不上传（加入 `DEVICE_LOCAL_SETTINGS_KEYS` 与字符串键校验）。
- 设置页“关于”增加输入：“上游服务器地址（qqpet-server，留空则离线；支持 https:// 或 wss://）”。
- server 存储模式下不使用该值，改用 `storage.status().serverUrl`。

### 5.3 数据模块

- `src/shared/update.ts`：`latestRelease(fetch, base)`；无 base 抛 `upstream_not_configured`；请求 `${base}/v1/client/release`。
- `src/shared/weather.ts`：`weather(fetch, base, city)`；无 base 抛 `upstream_not_configured`；抽取 `normalizeWeatherReply()` 供服务端复用。
- `src/shared/calendar.ts`：`calendar(fetch, base?)`；有 base 请求 `${base}/v1/client/calendar?from=...&days=31`；无 base 调 `computeCalendarDays()` 本地计算。
- 新增 `src/shared/calendar-data.ts`：纯函数 `computeCalendarDays(from, days)` + `solarTerm()` + 2025–2027 节假日表；新增 `src/shared/lunar.ts`（1900–2100 农历月表与转换，源自 solarlunar/ISC）。
- `src/main/index.ts` 的 `calendar/weather/latestRelease` IPC 增加 `clientUpstreamBase()`：
  - server 模式：`httpBaseFromServerUrl(storage.status().serverUrl)`。
  - 否则：`normalizeUpstreamUrl(getSave().settings.upstreamUrl)`。
  - 无 base 时按模块语义报错/本地计算。

### 5.4 内容包

- `src/main/content.ts`：
  - 删除 `INDEX` 常量；`findPack(fetch, base)` 请求 `${base}/v1/client/packs.json`。
  - `findFullPack(fetch, base)` 同。
  - `downloadPack(fetch, base, onProgress)` 使用 `new URL(entry.url, base)`。
- `src/main/content-pack.ts`：
  - `downloadTo()` 增加 `base?: string`，relative `entry.url` 与 base 拼接；保留 sha256/size 校验。
  - `packUrl()` 在 base 非空时只接受裸文件名或 `/v1/client/packs/...`，拒绝绝对/协议相对/跨主机 URL；`mirrored()` 与 mirror 语义删除。
- `src/main/first-run.ts`：`registerPackIpc(getBase)`；`findFull` 显式接收首启页输入的 server 地址；`download` 使用 find 时记录的上游 base。
- `src/preload/index.ts` 与 `src/shared/ipc.ts`：`PackApi.findFull(serverUrl)`、`download(serverUrl)`；`PackOffer` 不变。
- `src/renderer/firstrun.ts`：输入从“GitHub 加速镜像”改为“qqpet-server 地址（https:// 或 wss://）”，保存到 `localStorage` 的 `qqpet.upstreamUrl`；`first-run-flow.download(serverUrl)`。宠物启动后 `startAutoUpdate()` 把该值回填到 `settings.upstreamUrl`。
- `src/renderer/ui/update.ts`：`checkUpdate` 捕获 `upstream_not_configured` 时提示“未配置上游服务器，无法检查更新”；自动检查在无上游时静默跳过。
- 内容包索引与包文件都由服务端提供，不再请求 `github.com`。

### 5.5 本地/移动端行为

- 日历：始终可用（本地纯计算），无需上游。
- 天气/更新：`settings.upstreamUrl` 为空时显式不可用；填了 qqpet-server 地址即可用。
- 移动端设置页同样显示 `upstreamUrl` 输入（共用 setup 代码），但无内容包能力。

## 6. 测试与验收

### 6.1 服务端测试

新增 `server/test/client-data.test.ts`（真实 `SyncServer` + `fetch`）：

1. `/v1/client/release`：缺文件 404、合法文件 200、非法 JSON 503、版本/url 校验。
2. `/v1/client/weather`：mock 上游 200 归一化正确；第二次命中缓存且 mock 计数不增；上游 500 → 502；超时 → 504；`city` 为空使用 `weatherLocation`。
3. `/v1/client/calendar`：31 天长度、已知日期农历（2026-11-19 = `十月十一`，与现网 ankio 返回一致）、节气、节假日/调休；非法 from/days 400。
4. `/v1/client/packs.json`：相对 URL 改写为 `/v1/client/packs/...`；绝对 URL 503；缺文件 404。
5. `/v1/client/packs/<name>`：字节与 sha256 一致、content-length、304；`../`、`%2e%2e`、绝对路径、非 `.qqpetpack` 均拒绝。
6. 路由：非 GET 405；未知路径 404。

### 6.2 客户端测试

- `scripts/tests/upstream.test.mjs`：ws/wss→http/https、路径剥离、非法输入。
- `scripts/tests/calendar-data.test.mjs`：农历、节气、节假日表、跨年、2 月 29 日。
- `scripts/tests/update-source.test.mjs`：静态断言 `src/**` 与 `server/src/**` 不含 `api.ankio.net`；`latestRelease`/`weather`/`calendar` 使用 base。
- `scripts/tests/content-pack.test.mjs` / `lite-shell.test.mjs`：相对 URL + base 拼接、下载校验、首启 server 地址流程。
- 现有 `scripts/tests/sync-data-boundary.test.mjs`：新增 `upstreamUrl` 设备本地字段。

### 6.3 真实联调

- 扩展 `scripts/e2e/run-e2e.mjs` 或新增脚本：启动真实 qqpet-server，创建临时 `client-data`（release.json/packs.json/小 pack fixture + mock wttr upstream），用 Electron 主进程 harness 调 `latestRelease/weather/calendar/findFull`，断言真实 HTTP + WS 同时工作。
- 手工验证：本地模式无上游时日历正常、天气不播报、手动更新提示；server 模式三条数据来自真实服务端。

### 6.4 质量门禁

按 AGENTS.md §5 执行：

```bash
npm run typecheck
npm run test:compat
npm --prefix server run typecheck
npm --prefix server test
npm run build
npm run check:docs
npm run smoke:proxy   # 改 nginx/Caddy 配置时
```

另外静态检查：`grep -R "api.ankio.net" src server` 必须无输出（文档/历史审计除外）。

## 7. 文档变更

- `docs/architecture/sync-protocol.md`：`server/src/index.ts` 的 require 规则；补充 `/v1/client/*` 端点与“公开只读”边界。
- `docs/architecture/desktop-ipc-and-preload.md`：`app:calendar/weather/latest-release`、`packs` API 签名变化。
- `docs/guides/server-deployment.md` / `server/README.md`：新 env、端点、client-data 目录、nginx 配置、内容包发布流程。
- `docs/guides/content-packs-and-builds.md`：`packs.json` 相对 url、服务端托管流程、`--url-prefix ''`。
- `docs/architecture/pet-runtime-and-save.md`：明确服务端天气代理只是展示数据，不写 `engine.environment`。

## 8. 迁移、回滚与风险

- **回滚**：服务端变更纯增量（新路由、新配置默认空目录、无 schema 变更），可直接回退到旧版本服务器；客户端保留本地日历计算，上游地址为空即离线，不依赖新服务端。
- **旧客户端**：已发布外壳仍读旧 GitHub `packs.json` 与 ankio；本变更不修改旧索引，不影响其现状（旧上游是否能访问不由本变更负责）。
- **风险**：
  0. 农历表覆盖 1900–2100；表外日期回退到 ICU（历史回放），2027 正月已按发布日历修正为 2027-02-06 初一。2028+ 节假日表仍需每年刷新。
  1. wttr.in 可用性/限流：上游可配置，失败返回 502/504，客户端不崩。
  2. 节假日数据 2028+ 缺失：`holiday: null`，不阻塞；发布流程需每年更新 `calendar-data.ts`。
  3. Lite 首启必须知道服务器地址：UI 明示；完整安装包不受影响。
  4. 服务端公开端点无认证：数据无个人内容；部署层自行限流。若未来需要私有内容包，另立认证规格。
  5. 移动端本地模式无天气/更新：由 `settings.upstreamUrl` 提供人工配置入口；不静默请求第三方。

## 9. 实施步骤

1. 服务端 `client-data.ts` + config + HTTP 路由 + 单测。
2. 共享 `upstream.ts` / `calendar-data.ts` / `update|weather|calendar` 改造 + 单测。
3. 客户端 IPC、设置、内容包、首启 UI 改造 + 单测。
4. 部署配置与文档同步。
5. 真实服务端 E2E 与全量门禁；输出证据到 `.agent-reports/acceptance/`。
