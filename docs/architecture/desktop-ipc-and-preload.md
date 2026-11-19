# 桌面进程 IPC 与 preload 边界

> 结论：桌面版把主进程能力收敛到一个 preload 桥（`window.qqpet`），两端共用一张 92 个通道名的常量表（`src/shared/ipc.ts:15-108`）。业务状态只能以「投影」形式从主进程单向流向渲染进程，渲染进程的写入口只有三类：语义命令 `pet:command`、设备本地覆盖 `pet:local-settings-update`、旧式补丁 `pet:save`（运行时模式下只接受设备本地字段，规范字段一律拒绝）。所有 `ipcMain.handle` 在分发前做 sender 校验；storage/admin 额外要求「可信窗口主框架 + 同源」，不满足即抛 `unauthorized: unknown renderer` 并失败关闭。

## 1. 进程与页面拓扑

- 宠物窗口由 `createPetWindow()` 创建，`webPreferences` 固定为 `sandbox: true`、`contextIsolation: true`，preload 指向构建产物 `../preload/index.cjs`（`src/main/window.ts:42-48`）。
- 渲染页面不从 `file://` 加载，而是自建 `app://bundle` 标准协议（`src/main/protocol.ts:9-23`），因此渲染进程的 origin 恒为 `app://bundle`；生产环境 `PAGES = APP_ORIGIN`，开发环境由 `ELECTRON_RENDERER_URL` 覆盖（`src/main/window.ts:13`、`src/main/window.ts:100`）。
- 协议处理器做路径越界检查：`/pet/` 走内容包解析，其余按 `rendererRoot` 归一化并拒绝逃逸（`src/main/protocol.ts:20-31`）。
- 宠物窗口禁止导航与新开窗口：`will-navigate` 一律 `preventDefault()`，`setWindowOpenHandler` 一律 `deny`（`src/main/window.ts:68-70`）。
- 游戏窗口是独立的 `game.html` 窗口，`sandbox: true` 且**不注入 preload**（`src/main/window.ts:173-184`），同样禁止导航与外开。

这套拓扑决定了后文的信任模型：主进程只认「某个 WebContents 是否就是自己建的宠物窗口」，而不是认页面里跑着什么代码。

## 2. IPC 通道表

常量在 `src/shared/ipc.ts:15-108` 一次性定义，`invoke`/`send`/`main→renderer 推送`都用同一批字符串；方向由使用处决定，通道名本身不带方向。

| 域 | 通道（节选） | 方向 | 注册/使用位置 |
| --- | --- | --- | --- |
| 宠物存档（旧路径） | `pet:load`、`pet:save`、`pet:reset`、`pet:export`、`pet:import` | R→M `invoke`/`send` | `src/main/index.ts:356-447` |
| 运行时 v2 | `pet:runtime-info`、`pet:command`、`pet:set-advance-while-empty`、`pet:local-settings-load`、`pet:local-settings-update`、`pet:flush`、`pet:get-projection`、`pet:get-status` | R→M `invoke` | `src/main/renderer-runtime.ts:403-458` |
| 投影推送 | `pet:projection`、`pet:resync`、`pet:sync-status`、`pet:command-result`、`pet:request-resync` | M→R + R→M(`request-resync`) | `src/main/renderer-runtime.ts:348-375`、`src/main/renderer-runtime.ts:453-458` |
| 桌面 server 模式（C10 兼容） | `pet:remote-status`、`pet:remote-pair`、`pet:remote-revoke` | R→M `invoke` | `src/main/storage-ipc.ts:91-116` |
| 存储/管理（C11） | `storage:status`…`storage:create-backup`、`storage:import-dialog` | R→M `invoke` | `src/main/storage-ipc.ts:57-88`、`src/main/index.ts:450-459` |
| 存储事件 | `storage:status-event`、`storage:devices-event` | M→R | `src/preload/index.ts:37-44` |
| 内容包 | `pack:info`、`pack:import`、`pack:reset`、`pack:find`、`pack:download`、`pack:find-full`、`pack:progress` | R→M / M→R | `src/main/first-run.ts`（`registerPackIpc`，由 `src/main/index.ts:79` 调用） |
| 系统/窗口 | `win:set-click-through`、`win:set-hit-shape`、`win:set-always-on-top`、`win:set-focusable`、`win:set-dragging`、`win:cursor` | R→M / M→R | `src/main/index.ts:486-507` |
| 应用 | `app:calendar`、`app:weather`、`app:relaunch`、`app:quit`、`app:copy-text`、`app:open-url`、`app:presence`、`app:front`、`app:latest-release` | 双向 | `src/main/index.ts:462-484`、`src/main/index.ts:512-542` |
| 托盘 | `tray:click`、`tray:hover-leave`、`tray:menu`、`tray:menu-action`、`tray:set-state` | 双向 | `src/main/index.ts:287-345`、`src/main/index.ts:510` |
| 局域网/Webhook | `lan:online`、`lan:offline`、`lan:message`、`lan:send`、`lan:peers`、`webhook:message`、`webhook:state` | 双向 | `src/main/index.ts:196-208`、`src/main/index.ts:273-286` |
| 记忆/语音 | `mem:*`、`voice:*` | 双向 | `src/main/index.ts:210-255` |

### 推送节律（主进程主动发送）

| 推送 | 周期/触发 | 去重方式 | 位置 |
| --- | --- | --- | --- |
| `win:cursor` | 33ms；`settings.hidden` 时 250ms | 与上次点做 JSON 比较，比较时把 `sequence` 归零 | `src/main/window.ts:82-93`（常量 `src/main/window.ts:11-12`） |
| `clipboard:text` | 500ms 轮询 | 与上次文本比较，且需 `settings.clip` 为真 | `src/main/index.ts:349-354` |
| `app:presence` | 5s 轮询 + `powerMonitor` 锁屏/挂起事件 | 布尔状态变化才发 | `src/main/index.ts:514-523` |
| `app:front` | 15s | 与上次应用名比较；`watchApp` 关闭时停表 | `src/main/index.ts:525-542` |
| `pet:projection` / `pet:resync` | 事件驱动（命令提交、追赶分片） | 游标分类，`stale` 直接丢弃 | `src/main/renderer-runtime.ts:348-368` |
| `pet:sync-status` | 仓库状态变化 | 整体重发当前状态 | `src/main/renderer-runtime.ts:370-375` |

### 进程生命周期

- 单实例锁在注册协议之前获取；Wayland 下若检测到 `ozone-platform=wayland` 且有 `DISPLAY`，进程先以 `--ozone-platform=x11` 重启自己再抢锁（`src/main/index.ts:50`）。
- 退出顺序是确定性的：先 `before-quit` 里停托盘/局域网/Webhook，再 `preventDefault()` 等 `storage.stop()`（或 `rendererRuntime.stop()`）完成才真正 `app.quit()`（`src/main/index.ts:325-339`）。
- 窗口关闭会移除 `win:set-dragging` 处理器并清掉光标定时器（`src/main/window.ts:94-97`）；`window-all-closed` 直接退出应用（`src/main/index.ts:545`）。
- 设置变化只通过 `onView` 单点分发：缩放、HD、`watchApp`、`lan`、`webhook`、`voice` 各自有副作用分支，且用 `appliedSettings` 做差分（`src/main/index.ts:302-321`）。新增设置项必须在这里挂副作用，否则只有 UI 变化、主进程行为不变。

### 客户端数据与内容包通道

`app:calendar`、`app:weather`、`app:latest-release` 与 `packs` 都经 `clientUpstreamBase()` 选上游（`src/main/index.ts:64-70`）：server 存储模式取 `httpBaseFromServerUrl(storage.status().serverUrl)`，否则取设备本地 `normalizeUpstreamUrl(getSave().settings.upstreamUrl)`；两者都没有即离线（返回 `null`），不做任何第三方回退。

- `app:calendar`：离线可用。有上游时发一次 `GET /v1/client/calendar?from=…&days=31`；无上游时用共享纯函数 `computeCalendarDays` 本地计算，不抛错（`src/main/index.ts:463`、`src/shared/calendar.ts:30-60`）。
- `app:weather`：必须有上游；无上游时抛 `upstream_not_configured`，宠物不播报天气。有上游时 `GET /v1/client/weather?city=…`，服务端回完整 8 段、客户端按本地小时过滤（`src/main/index.ts:468`、`src/shared/weather.ts:78-84`）。
- `app:latest-release`：必须有上游；无上游时抛 `upstream_not_configured`，手动检查提示「未配置上游服务器」、自动检查静默跳过。有上游时 `GET /v1/client/release`（`src/main/index.ts:469`、`src/shared/update.ts:15-25`）。
- `packs` API：`findFull(serverUrl?)` 与 `download(serverUrl?)` 接收首启页输入的 qqpet-server 地址；索引来自 `/v1/client/packs.json`，包文件从同一服务器下载，相对 `url` 由 `packUrl` 在 base 非空时解析，绝对/跨主机 URL 一律拒绝（`src/preload/index.ts:68-80`、`src/shared/ipc.ts:207-229`、`src/main/content-pack.ts:358-384`）。
- `settings.upstreamUrl` 是**设备本地设置**，默认空串、永不上传（`src/shared/save.ts:159`、`src/shared/sync/data-boundary.ts:60-66`、`src/shared/sync/data-boundary.ts:114`）；server 存储模式忽略它，改用 `storage.status().serverUrl`。

## 3. preload 暴露面

单文件组装，最后一步才注入全局：`contextBridge.exposeInMainWorld('qqpet', api)`（`src/preload/index.ts:156`）。

`api`（类型见 `QQPetApi`，`src/shared/ipc.ts:272-409`）由四块拼成：

1. `capabilities`：桌面恒定 `{ serverMode: true }`（`src/preload/index.ts:48`）。
2. `load`/`save`/`resetPet`/`exportSave`/`importSave` 等旧存档 API（`src/preload/index.ts:49-60`）。
3. `...runtime`：来自 `createRendererRuntimePreload(ipcRenderer)`（`src/preload/renderer-api.ts:60-86`），提供 `runtimeInfo`、`command`、`setAdvanceWhileEmpty`、`localSettings.load/update`、`flush`、`getProjection`、`getStatus` 与四个订阅器。
4. `storage`（C11 管理面，`src/preload/index.ts:21-45`）与 `remote`（C10 兼容面，`src/preload/index.ts:53-57`）、`packs`（`src/preload/index.ts:68-80`）以及各平台能力。

两条必须遵守的暴露规则：

- **订阅器一律「替换」而不是「追加」**：`replaceListener` 先 `removeAllListeners` 再 `on`（`src/preload/renderer-api.ts:46-53`）。preload 生命周期长于页面刷新，追加会跨页面泄漏监听器；`src/preload/index.ts:105` 有同样的注释性约定，`storage`/`packs`/`voice`/`lan` 等订阅器全部照此实现。
- **平台专有字段用条件展开**：`setHitShape` 仅在 linux 暴露（`src/preload/index.ts:85`），`popupTrayMenu`/`onTrayMenuAction` 仅在 darwin 暴露（`src/preload/index.ts:90-93`）。渲染层据此以 `=== undefined` 判断「该宿主没有这个能力」。

`capabilities` 的语义是「只在明确为 `false` 时表示不支持」，未声明即视为可用（渲染层判据见 `src/renderer/ui/setup.ts:104-117`）。移动桥不再一律写 `serverMode: false`：**Android 例外**——原生能力齐备时 `capabilities.serverMode = true` 且新增 `serverModeClientOnly = true`，表示「只能作为服务器宠物客户端，不能上传本机宠物或做权威交接」（`src/android/bridge.ts:364-370`、`src/shared/ipc.ts:285` 的 `QQPetApi.capabilities.serverModeClientOnly`）；原生能力缺失时两者都回到 `false` 并给出原因，本机模式不受影响。iOS/HarmonyOS 仍显式 `serverMode: false`（`src/ios/bridge.ts:73-83`）。桌面 preload 不声明 `localRepositoryV2`，因为渲染层优先用 `runtimeInfo()` 的真实返回值，只有该调用失败时才回落到 `capabilities.localRepositoryV2`（`src/renderer/bootstrap.ts:8-17`）。

## 4. sender 信任模型

四种强度，全部失败关闭（抛错而非降级）：

| 校验 | 判据 | 位置 |
| --- | --- | --- |
| `requireTrustedSender` | `sender === window.webContents` | `src/main/renderer-runtime.ts:403-408`，由 `DesktopRendererRuntime.acceptsSender` 实现（`src/main/renderer-runtime.ts:128-130`） |
| `assertTrustedStorageIpcSender` | 同上 + 主框架 + 同源 | `src/main/storage-ipc.ts:23-30` |
| `DesktopStorageController.acceptsSenderFrame` | 逐项：`frame.parent == null`、`frame === webContents.mainFrame`、`frame !== sender.mainFrame` 时拒绝、`frame.url` 的 origin 必须等于 `sender.getURL()` 的 origin | `src/main/storage-controller.ts:370-398` |
| 单点内联比较 | `event.sender !== win.webContents` 直接 `return` | 托盘菜单 `src/main/index.ts:340-345`、Linux 输入区 `src/main/index.ts:486-491` |
| 单点内联比较（抛错） | `event.sender !== win.webContents` 抛 `Unknown drag sender` | 拖拽 `src/main/window.ts:76-81` |

注意两点实现细节，改代码时容易踩：

- `assertTrustedRenderer`（`src/main/index.ts:141-145`）**只在 `storage !== null` 时生效**。当前 `startupAuthority === 'runtime'` 分支同时构造 `DesktopRendererRuntime` 与 `DesktopStorageController`（`src/main/index.ts:91-115`），所以运行时路径始终有校验；一旦有人只构造 runtime 不构造 storage，`pet:load`/`pet:save`/`pet:reset`/`pet:export`/`pet:import` 的校验会静默失效（编译器不会报错）。
- 存档导入对话框走 `storage:import-dialog` 而不是 `pet:import`，因此它额外做参数校验 `validateStorageImportDialogOptions` 后才读文件（`src/main/index.ts:450-459`）。
- 运行时 v2 下局域网探访被直接拒绝：`pet:lan:send`（`IPC.lanSend`）在 `rendererRuntime !== null` 时抛 `unauthorized: LAN visits are unavailable in runtime v2`（`src/main/index.ts:196-207`）；`pet:lan:peers` 返回空数组（`src/main/index.ts:208`）。语音同理，主进程在运行时模式下不启动热键与 ASR（`shouldStartVoice`，`src/main/voice-startup.ts:6-8`）。

## 5. 启动路径与 serverMode/capabilities

启动前必须选出**唯一写入者**，选择逻辑是纯函数：`desktopStartupAuthority(v2DocumentExists, env)` 返回 `'runtime' | 'legacy' | 'blocked'`（`src/main/renderer-runtime-flags.ts:39-45`）。

- 默认 `'runtime'`；`QQPET_LOCAL_REPOSITORY_V2=0` 或 `QQPET_LOCAL_V2_ROLLBACK=1` 会关闭 v2（`src/main/renderer-runtime-flags.ts:11-23`）。
- 若关闭 v2 但 `save.v2.json` 已存在 → `'blocked'`：弹错误框并 `app.quit()`，绝不双写（`src/main/index.ts:116-123`）。
- `'runtime'` 下先同步读设备浮层做「临时视图」，让窗口位置/缩放/X-HD 从第一帧就正确，再异步启动权威（`src/main/index.ts:96-97`、`src/main/index.ts:102-115`）。

权威可能是本机或已配对的服务器，由 `DesktopStorageController` 决定，`info()` 据此返回 `serverMode: activeMode === 'server'`（`src/main/storage-controller.ts:358-360`）：

- `initializeNow()` 读 `storage-config.json`；server 模式且存在 token 才 `connectStoredRemote()` + `local.loadFenced()`（本地被冻结）并把 `local.setSendEnabled(false)`（`src/main/storage-controller.ts:437-470`）。
- server 模式无 token 时不静默降级：`activeMode` 保持 `local`，等用户显式配对（`src/main/storage-controller.ts:456-461`）。
- 冻结后本地运行时的投影/状态/命令结果不再推给渲染进程（`setSendEnabled`，`src/main/renderer-runtime.ts:161-167`）。

`capabilities.serverMode` 是「宿主是否编进了 server 模式」，`runtimeInfo().serverMode` 是「此刻权威是否在服务器」，两者不能互相替代。

Android 走的是同一组语义、不同实现：`src/mobile/server-mode.ts` 的 `createMobileServerRuntime` 包装 `MobileLocalRepositoryBridge`（本机权威）与 `RemoteRepository`（服务器权威），以 `activeMode` 路由 `load/command/localSettings/onProjection/onResync/onCommandResult/onSyncStatus/getProjection/getStatus/requestResync/flush`。server 激活时本机运行时 `suspend()`（停调度、不写盘），切回本机 `resume()`；**本机宠物只暂停，不归档、不上传**。因此移动端没有 `DesktopStorageController`、没有 `storage:*` IPC 通道，也不存在 `pet:remote-*` 管理面；`window.qqpet.storage` 由移动宿主的 `StorageApi` 子集直接实现，UI 分支见 `src/renderer/ui/storage.ts:259-299`（动作处理 `:301-365`）。配对、token、投影缓存的持久化与失败关闭见 `docs/architecture/native-bridge.md` §4.1。

## 6. 渲染进程边界

渲染进程拿不到规范写权限：

- 唯一的状态来源是投影（`RendererProjection`，`src/shared/renderer-api.ts:14-30`）：`save` 是已合并设备浮层的可渲染快照，`shared` 是纯规范数据，`authority` 是权威标识。
- 投递前必须通过分类器：`classifyProjectionDelivery(cursor, projection, events)` 只允许「事件游标严格 +1 且末位等于 `projection.eventSeq`」，否则升级为 `resync`；更旧的快照判 `stale` 直接丢弃（`src/shared/renderer-api.ts:216-256`）。主进程据此在 `resync` 与 `projection` 通道间切换（`src/main/renderer-runtime.ts:348-368`）。
- 旧式 `save(patch)` 会被拆成「规范字段」与「设备本地字段」；规范字段一律抛 `CanonicalMutationBlockedError`（`src/shared/renderer-projection.ts:210-268`、`src/main/renderer-runtime.ts:263-275`）。server 模式更直接在控制器层拒绝：`canonical_mutation_blocked: server mode never accepts a SavePatch`（`src/main/storage-controller.ts:1002-1007`）。
- 渲染层保存投影时用 `hydrateSaveProjection` 原地合并，保留只属于本机的 `saveJsonData` 展示缓存（`src/shared/renderer-projection.ts:125-177`）。
- IPC 入参在到达命令队列前先过 `assertCommandIpcInput`：只允许 `type`/`payload` 两个字段，`opId` 必须匹配 `^[A-Za-z0-9._:-]{1,128}$`（`src/shared/renderer-api.ts:328-371`）。

### 一次命令的完整时序

1. 渲染层调用 `window.qqpet.command(cmd, { opId })` → `invoke('pet:command', cmd, options)`（`src/preload/renderer-api.ts:63-66`）。
2. 主进程校验 sender 与入参形状（`src/main/renderer-runtime.ts:417-423`）；不合法抛 `invalid_payload: ...`，不进入队列。
3. 宿主执行命令；`opId` 缺省时由主进程生成 UUID（`src/main/renderer-runtime.ts:240-241`）。
4. 提交成功后主进程发 `pet:command-result`（`src/main/renderer-runtime.ts:255`），同一轮把增量事件随 `pet:projection` 推给渲染层（`src/main/renderer-runtime.ts:348-368`）。
5. 渲染层用 `classifyProjectionDelivery` 判断是否可应用；判 `resync` 时以全量快照覆盖。
6. 渲染层自检到缺口可主动 `requestResync()`，主进程把当前快照重发到 `pet:resync` 并重放一次状态（`src/main/renderer-runtime.ts:151-154`、`src/main/renderer-runtime.ts:453-458`）。

这条链路里渲染层**不持有**规范状态：它只比较游标、应用投影、在缺口时请求重同步。

## 7. 不变量（可逐条对照代码）

1. 每个 `storage:*` 与 `pet:remote-*` 处理器都必须先过 `trustedController(...)`，它同时完成「控制器存在」与「sender 可信」两件事（`src/main/storage-ipc.ts:32-39`）。
2. 控制器为 `null` 时存储面整体不可用，抛 `storage_unavailable: local runtime v2 is not active`（`src/main/storage-ipc.ts:14-16`），而不是返回空状态。
3. preload 不暴露 `ipcRenderer` 本身，只暴露具名方法；渲染进程无法自造通道。
4. 同名通道可双向使用，但只有主进程注册的 `handle/on` 才是入口；渲染进程无法调用未注册的通道。
5. 主进程启动期只允许一个存档写入者（`desktopStartupAuthority`），冲突时进程退出（`src/main/index.ts:116-123`）。
6. server 模式下本地运行时被冻结：不推投影、不接命令、不写盘（`src/main/storage-controller.ts:447-449`）。
7. 命令执行失败不会让渲染进程「乐观前进」：`CommandResult` 携带 `status/revision/eventSeq/error`，投影缺口由 `requestResync` 补齐（`src/shared/renderer-api.ts:258-305`、`src/preload/renderer-api.ts:79-84`）。
8. 平台专有能力缺席时以「字段 undefined」表达，而不是抛错或返回假值（`src/preload/index.ts:85-93`）。

## 8. 失败模式与定位

| 现象 | 直接原因 | 定位 |
| --- | --- | --- |
| 所有面板空白、控制台报 `unauthorized: unknown renderer` | sender 不是宠物窗口主框架，或子框架发起的调用 | `src/main/storage-ipc.ts:23-30`；`acceptsSenderFrame` 的 `parent`/origin 分支（`src/main/storage-controller.ts:370-398`） |
| 启动即弹「本地数据版本冲突」并退出 | 回滚开关与已存在的 `save.v2.json` 同时成立 | `src/main/index.ts:116-123`；判据 `src/main/renderer-runtime-flags.ts:32-45` |
| 界面停在只读、命令返回 `authority_not_active` | 权威未 `active` 或处于 `handoff_pending` | `src/main/renderer-runtime.ts:411-416`（legacy stub）、本地仓库拒绝分支 `src/shared/local-repository/host.ts:1334-1343` |
| 状态卡住但无报错 | 投影被判 `stale` 丢弃 | `src/main/renderer-runtime.ts:361-364` |
| 页面反复丢订阅 | preload 用了 `on` 而非「替换」 | `src/preload/renderer-api.ts:46-53` |
| 局域网/语音「开了没反应」 | 运行时 v2 下这些能力被主动屏蔽 | `src/main/index.ts:196-207`、`src/main/voice-startup.ts:6-8` |
| 点击穿透后画面无响应（Linux） | 未设置输入区，或 `setHitShape` 被 sender 校验拒绝 | `src/main/index.ts:486-491` |

## 9. 验证命令

预期退出码均为 `0`；非 `0` 即视为该项失败。

```bash
# 类型边界（preload/api/ipc 的类型漂移会在这里暴露）
npm run typecheck

# 全量行为测试（含 storage-ipc 与 runtime IPC 用例）
npm run test:compat

# 只跑 preload/IPC 相关用例
node --experimental-strip-types --test scripts/tests/storage-ipc.test.mjs
node --experimental-strip-types --test scripts/tests/renderer-runtime-c6a.test.mjs

# 真实 Electron + 真实 preload 的端到端
npm run test:e2e
```

通过标准：`npm run typecheck` 四套 `tsc --noEmit` 无输出；`npm run test:compat` 汇总行 `fail 0`；单文件用例的 `pass` 数等于该文件用例数；`npm run test:e2e` 退出码 `0`，且 E2E 报告断言渲染层与 GUI 覆盖为真。任一项失败时按本文第 8 节的失败模式定位。历史完整验收记录（12 条命令的退出码、耗时与证据哈希）见 [C12 final gate](../reviews/c12-final-gate/2026-11-18-c12-final-gate.md)。

## 10. 变更影响

- **新增通道**：必须同时改三处才能生效——`IPC` 常量（`src/shared/ipc.ts`）、preload 方法（`src/preload/index.ts` 或 `src/preload/renderer-api.ts`）、主进程注册（`src/main/index.ts` / `src/main/renderer-runtime.ts` / `src/main/storage-ipc.ts`）。漏掉主进程注册时调用会以 `Error: No handler registered for ...` 失败，不会静默。
- **新增管理面通道**：一律放进 `installStorageIpc`，复用 `trustedController`，不要自写 `ipcMain.handle`——否则会绕过主框架/同源校验。
- **修改 `SavePatch` 拆分规则**：只改 `DEVICE_LOCAL_*`/`PRESENTATION_ONLY_*` 白名单（`src/shared/sync/data-boundary.ts:51-81`），禁止在 `classifySavePatch` 里加特例，否则「规范字段不可被渲染进程改写」这条不变量会失守。
- **给 `RendererProjection` 加字段**：`src/shared/renderer-api.ts:14-30` 与 `src/main/renderer-runtime.ts:310-322` 都要动，并检查移动桥是否也需要同名字段（`src/android/bridge.ts`、`src/ios/bridge.ts`）。
- **改变启动权威判定**：`desktopStartupAuthority` 是唯一入口，测试与 E2E 都依赖它（`scripts/tests/renderer-c7-startup.test.mjs`）；改动需同时更新 `src/main/index.ts:116-123` 的错误文案与退出路径。
- **移动端**：任何依赖 `window.qqpet.storage`/`remote`/`packs` 的新代码都必须在移动桥下保持可缺席。桌面 preload 的 `capabilities` 与移动桥是两套契约：iOS/HarmonyOS 显式 `serverMode: false`，Android 在原生能力齐备时 `serverMode/serverModeClientOnly = true` 但只实现客户端子集（无上传、无交接、无备份），不要按桌面的 `StorageApi` 全量假设。

历史验收证据见 [C12 final gate](../reviews/c12-final-gate/2026-11-18-c12-final-gate.md)；IPC 与运行时的历史设计取径见冻结文档 [local-or-server pet data design](../reviews/legacy/2026-10-20-local-or-server-pet-data-design.md)（只读，勿改）。
