# 验收报告：Android 接入 qqpet-server 服务器模式

> 结论：**通过**。Android 现在可以作为 qqpet-server 的 client-only server-mode 宿主：用真实 server 完成配对、快照、player 命令、重启 token 复用、断网缓存只读、本机/服务器切换、设备撤销与解除配对；桌面共享协议机未回归，iOS/Harmony 仍保持本地模式。独立 verifier 在修复 3 个 blocking 后判定 PASS。

- Tree：`tree-8b47bb18fc4df96b`（Android 接入服务器模式）
- 任务：task-1…task-9（调查 3、设计/实现 4、文档 1、独立验收 1）
- 分支 / 基线：`feat/android-server-mode` / `b44b5a48`；功能提交 `4e9b9049`，合并提交 `136d1421`，已推送 `origin/main`
- 验收时间：2026-11-19（Asia/Shanghai）
- 设备：`emulator-5554`，Android 13 / API 33 / arm64，WebView 101；真实 `qqpet-server` 监听 `127.0.0.1:8787`，Android 经 `adb reverse tcp:8787` 连接到 `ws://127.0.0.1:8787/v1/sync`。

## 1. 交付内容

### 1.1 共享远程客户端（桌面 + Android 单份实现）

- `src/shared/remote/repository.ts`：由 `src/main/remote-repository.ts` 平移；删除 `node:crypto` 默认值，改为 `globalThis.crypto.randomUUID` + `getRandomValues` 兜底；协议、投影分类、缓存、重连、命令幂等全部不变。
- `src/shared/remote/endpoint.ts`、`websocket-transport.ts`：端点校验与全局 WebSocket 适配器平移到共享层；`src/main/remote-*` 保留 `export *` shim，桌面/测试/e2e 旧导入不变。
- `docs/doc-map.json`：`sync-protocol` 规则加入 `src/shared/remote/**/*.ts`。

### 1.2 Android 原生能力

`android/app/src/main/java/net/ankio/qqpet/PetService.kt`：

- `saveRemoteToken/loadRemoteToken/clearRemoteToken`：Android Keystore AES-256/GCM，格式 `version|ivLen|iv|ciphertext` + Base64；原子写 `filesDir/remote-token.bin`；失败返回 false/encoded error，不回退明文。
- `removeStateFile(name)`：仅白名单、幂等；`writeAtomic` 复用同一 fsync + `ATOMIC_MOVE` 实现。
- 状态文件白名单新增 `storage-config.json`、`sync-config.json`、`remote-projection-cache.json`；`remote-token.bin` 刻意不在白名单，页面只能通过 Keystore 三方法触达。

### 1.3 移动 server-mode 宿主

- `src/mobile/remote-token-store.ts`（230 行）：`RemoteTokenStore` 实现；token 只走 Keystore；config/投影缓存走原生原子状态文件；cache 用 `validateRemoteProjectionCacheV2` 校验，损坏即删。
- `src/mobile/server-mode.ts`（约 860 行）：`createMobileServerRuntime` 包装现有 `MobileLocalRepositoryBridge` + `RemoteRepository`，实现 local/server 单权威路由、pair/setMode/unpair、`StorageApi`、lifecycle。
  - server 激活前必须成功 `local.suspend()`；失败则保持 local、停 remote、清理半持久化配对并抛错（失败关闭，禁止双写者）。
  - 有缓存立即只读接管并后台重连；无缓存 5s 超时回退 local，保留 token/config 并给 notice。
  - 每次激活 server / 切回 local 都 `onResync` 重放当前投影（含离线缓存只读投影），并重放 status。
  - Android URL 收紧：只接受 `wss://` 或 `ws://127.0.0.1|localhost`；私网明文 ws 在发出前明确拒绝（`android_transport_unsupported`）。
  - `pair` 成功后 `await remote.flush()` 再重读 token/config，确认 deviceId 已落盘；token/config 半持久化先清理；完整已配对时要求先 unpair。
  - `unpair` 在 server active 时可直接回 local，清 token/config/cache，并 resume 本机宠物。
  - 不 import `src/main/**`、Electron、`node:*`；不修改 `LocalRepositoryHost` 的 local-only 守卫。

### 1.4 桥接与 UI

- `src/android/bridge.ts`：native 可选方法检查；能力齐备时创建 serverRuntime；`capabilities.serverMode=true` + `serverModeClientOnly=true`；`window.qqpet.storage` 仅在可用的 Android 宿主暴露；所有 runtime 方法按 activeMode 委托；server active 时 `save` 拒绝、`exportSave` 走 owner 导出、`importSave` 显式拒绝、`resetPet` 走 `pet.reset`。
- `src/shared/ipc.ts`：新增 `capabilities.serverModeClientOnly?: boolean`。
- `src/renderer/ui/storage.ts`：新增移动专用存储面板分支（配对/使用服务器/回本机/解除配对/状态），隐藏移动端不支持的桌面上传、交接、导入、备份、owner 撤销；显示 `device_revoked` 与离线 notice。

### 1.5 文档与测试

- 四篇 living docs 更新：`native-bridge.md`、`sync-protocol.md`、`desktop-ipc-and-preload.md`、`backend.md`；`check:docs` 通过。
- 新增 `scripts/tests/mobile-server-mode.test.mjs`（8 个用例）：pair/load/command、重启缓存、无缓存离线回退、unpair、suspend 失败单写者、私网 ws 拒绝（transport 0 次调用）、persisted 私网 ws 启动兜底、切模式投影重放。
- 更新 `mobile-local-repository.test.mjs`、`remote-repository.test.mjs`、`renderer-c7d.test.mjs`：Android 允许 server client，iOS/Harmony 仍禁止；Android 白名单/Keystore 方法纳入静态断言。

## 2. 桌面与 Android 的共同点 / 差异 / 难点

| 维度 | 桌面 | Android | 本次处理 |
|---|---|---|---|
| 协议 | `RemoteRepository` + `/v1/sync` | 同一份 `src/shared/remote/repository.ts` | 直接复用，零协议重写 |
| 传输 | Electron 主进程全局 WebSocket | WebView 全局 WebSocket；只允许 wss/loopback | 复用 `RemoteTransport`，Android 收紧 URL |
| token | Electron `safeStorage` | Android Keystore AES/GCM | 新写 `MobileRemoteTokenStore` |
| 配置/缓存 | Node fs + atomic write | 原生 `readStateFile/writeAtomic/removeStateFile` | 新写三个状态文件，独立于 `save.v2.json` |
| 权威切换 | 本地冻结/归档 + upload/use-server/switch-local 交接 | 本机 `suspend`，server 投影接管；不归档、不上传 | 第二阶段能力，明确非目标 |
| 本机宠物 | 可上传、可回迁 | 保留但暂停；切回 resume | 避免双权威与数据丢失 |
| UI | 完整 storage/admin | 配对/状态/切换/解绑 | `serverModeClientOnly` 分支 |
| 角色 | owner/player 全量 | 服务端配对码授予；player 不能 owner 命令 | 复用 `RemoteRepository` 角色闸门 |

**难点（已解决）**：

1. WebView 安全上下文拒绝私网明文 `ws://`，且 `setMixedContentMode` 实测无效；方案是生产用 `wss://`，联调用 `adb reverse` + `ws://127.0.0.1`。
2. Android 没有 Electron safeStorage；方案是 Keystore AES/GCM + 原生白名单，失败关闭。
3. 双写者风险；方案是 server 激活前强制 suspend，失败即放弃激活。
4. 无缓存启动 `RemoteRepository.start()` 会无限等待；方案是 5s 超时回退 local。
5. 切模式时 renderer 可能停留在旧投影；方案是 `onResync` 全量重放当前投影/状态。

## 3. 验证证据

### 3.1 门禁命令

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run typecheck` | 0 | node/web/harmony/e2e 四套通过 |
| `node --experimental-strip-types --test scripts/tests/mobile-server-mode.test.mjs` | 0 | 8 pass / 0 fail |
| `node --experimental-strip-types --test scripts/tests/mobile-local-repository.test.mjs` | 0 | 30 pass / 0 fail |
| `node --experimental-strip-types --test scripts/tests/remote-repository.test.mjs` | 0 | 58 pass / 0 fail |
| `node --experimental-strip-types --test scripts/tests/renderer-c7d.test.mjs` | 0 | 6 pass / 0 fail |
| `npm run test:compat` | 0 | 875 tests / 873 pass / 0 fail / 2 skipped（最终代码） |
| `npm run check:docs` | 0 | 文档结构/索引/链接/代码引用通过 |
| `npm run build:android-web` | 0 | `out/android` 构建完成 |
| `JAVA_HOME=~/.jenv/versions/17.0.2 ./android/gradlew -p android assembleDebug` | 0 | `BUILD SUCCESSFUL`，`app-debug.apk` |
| `npm run build` | 0 | 桌面 main/preload/renderer 构建完成，Ruffle fallback validated |
| `npm run build:harmony-web` / `npm run build:ios-web` | 0 / 0 | iOS/Harmony 本机模式产物仍可构建，未引入 remote 代码 |
| `npm --prefix server run typecheck` | 0 | 服务端 TypeScript 通过（共享层平移未破坏服务端构建） |
| `git diff --check` | 0 | 无空白错误 |

独立 verifier 额外命令：同一组 targeted tests + `test:compat` 全绿；`tmp/verifier-probe` 12 项行为探针、缓存离线切换探针全部通过。

### 3.2 Android 真机/模拟器端到端

设备 `emulator-5554`，真实 server `127.0.0.1:8787`，`adb reverse tcp:8787 tcp:8787`。证据在 `.agent-reports/acceptance/assets/`：

| 场景 | 证据 | 结果 |
|---|---|---|
| 在线服务器模式 | `e2e-01-baseline-final.json` | mode/active=server、paired=true、player、petId=default、rev48/seq53、havePet=true |
| player 命令 | `e2e-02-command.json` | `pet.cheer` applied，rev45→46；server.log `12:38:18Z command.committed ... revision:46 eventSeq:51` |
| 重启复用 token | `e2e-03-restart.json` | force-stop 后新 pid 25239，deviceId 不变，rev46 online |
| 本机/服务器切换 | `e2e-04-switch.json` | local rev25 havePet=false（paired 保留）→ server rev46 havePet=true |
| 断网缓存只读 | `e2e-05-offline.json` | 停 server 重启：conn=offline、rev47、readOnly=true、havePet=true |
| 设备撤销 | `e2e-06-revoked.json` + `e2e-06-revoke-cli.json` | owner `device.revoke` applied；Android conn=error、notice=device_revoked、rev0、readOnly=true |
| 解除配对 | `e2e-07-unpair.json` | mode/active=local、paired=false、投影 rev26 havePet=false |
| 截图 | `android-server-mode-panel.png`、`android-server-mode-revoked-panel.png`、`android-server-mode-revoked-readonly.png` | 在线服务器面板、撤销提示/只读提示 |

最终 APK 在解除配对后再次启动为 `mode/active=local`、`paired=false`、本机 rev30，无启动错误。

### 3.3 安全证据

- `remote-token.bin` 不在 `allowedStateName`；token 只能经 Keystore 三方法读写；源码/状态/URL/日志中无 token 明文。
- `logcat` 与 `server.log` 搜索 `token`/`QQP-`/`issuedToken` 无敏感值（verifier 只读检查）。
- 私网明文 ws 在 `server-mode.ts` 层被拒绝；独立探针确认 transport 0 次调用。
- Android 面板在 device_revoked 时显示“这台设备已被服务器撤销，请解除配对后重新配对”，不把撤销伪装成普通离线。

## 4. 复现配方

```bash
# 1) 临时 server（只使用 tmp/ 下的库）
export QQPET_SYNC_DB="$PWD/tmp/android-server-test/qqpet-test.sqlite"
export QQPET_SYNC_BACKUP_DIR="$PWD/tmp/android-server-test/backups"
export QQPET_SYNC_CLIENT_DATA_DIR="$PWD/tmp/android-server-test/client-data"
export QQPET_SYNC_BIND=127.0.0.1 QQPET_SYNC_PORT=8787 QQPET_SYNC_TIME_ZONE=Asia/Shanghai
node --disable-warning=ExperimentalWarning server/dist/server/src/index.js init --db "$QQPET_SYNC_DB" --pet-id default
node --disable-warning=ExperimentalWarning server/dist/server/src/index.js pair --db "$QQPET_SYNC_DB" --pet-id default --role player
node --disable-warning=ExperimentalWarning server/dist/server/src/index.js start

# 2) Android
adb reverse tcp:8787 tcp:8787
npm run build:android-web
JAVA_HOME="$HOME/.jenv/versions/17.0.2" ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./android/gradlew -p android assembleDebug
adb install -r -d -g android/app/build/outputs/apk/debug/app-debug.apk
adb shell appops set net.ankio.qqpet SYSTEM_ALERT_WINDOW allow
adb shell am start -n net.ankio.qqpet/.MainActivity
```

App 设置 → 存储 → 填 `ws://127.0.0.1:8787/v1/sync` + 配对码 → “配对并使用服务器宠物”。

## 5. 剩余风险与未知

1. **传输范围**：Android release 只支持 `wss://` 或 loopback `ws://`；局域网私网 `ws://<private-ip>` 被 WebView 安全上下文拒绝。生产按 `docs/guides/server-deployment.md` 用 TLS/WSS 反代；本机联调必须 `adb reverse`。若产品必须支持 LAN 明文，需要另立“原生 WebSocket 传输”规格（OkHttp/自研 WS + 原生事件通道）。
2. **后台冻结**：WebView 被系统冻结时重连/心跳定时器会停摆；第一阶段只保证前台/服务存活期间同步与回前台 resync，后台常驻同步非目标。
3. **未实现桌面级交接**：Android 不上传本机宠物、不回迁服务器宠物、不做 owner detach/backup；这些仍走桌面 owner。移动端 `initialSource:'upload-local'` 显式拒绝。
4. **player reset 错误只进 console**：player 在服务器模式点重置会被服务端拒绝，目前 `console.error`，无 UI 弹错；owner 正常。
5. **桌面 Electron E2E 未在本机跑**：`test:e2e`/`test:e2e:main-process` 依赖 Electron 环境，本次用 typecheck + compat + remote 测试覆盖桌面共享层；CI 应在合并前覆盖。
6. **规格门禁**：本次实现依据 `tmp/specs/android-server-mode.md` 草稿与用户“完成 Android 接入”的任务授权推进；未写入 `docs/specs/`。功能分支已按用户 2026-11-19 的明确指令合并并推送，规格正式批准稿仍可在后续单独补走流程。
7. **合并与推送**：功能提交 `4e9b9049`，合并提交 `136d1421`（`merge: Android server mode`），`origin/main` 已同步到 `136d1421`；无关未跟踪 `audit/`、pnpm 文件保持原样。
