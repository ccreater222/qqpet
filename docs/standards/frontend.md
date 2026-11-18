# 前端规范

> 结论：qqpet 前端是“Electron 主进程 + sandbox preload + 原生 TypeScript 渲染层”的三层结构，同一份渲染代码还运行在 Android WebView、HarmonyOS ArkWeb 与 iOS WKWebView。渲染层只能通过 `window.qqpet` 契约访问宿主能力，不能直接碰 Node、文件系统或权威状态；所有跨端行为必须同时满足桌面、Android、HarmonyOS、iOS 的降级约束。

## 1. 运行时与目录

| 层 | 路径 | 约束 |
|---|---|---|
| 主进程 | `src/main/**` | 窗口、托盘、协议、存档、AI/天气、存储权威切换；可直接使用 Node/Electron |
| preload | `src/preload/**` | 只做受控桥接；`src/preload/index.ts:156` 用 `contextBridge.exposeInMainWorld('qqpet', api)` 暴露 API |
| 渲染层 | `src/renderer/**` | 原生 TypeScript + DOM/CSS，无 React/Vue；`src/renderer/main.ts` 为桌面入口 |
| 移动桥 | `src/android/**`、`src/harmony/**`、`src/ios/**` | 实现同一 `window.qqpet` 契约，调用各自原生层 |
| 共享契约 | `src/shared/**` | IPC 名称、投影、存档、同步协议、跨端逻辑；禁止依赖 Electron/Node 专有 API |
| 移动共享 | `src/mobile/**` | 触摸、覆盖层、可见性等跨移动端逻辑 |

- 桌面窗口固定 `sandbox: true`、`contextIsolation: true`，preload 指向构建产物（`src/main/window.ts:42`）；不得为图方便关闭 sandbox 或开启 `nodeIntegration`。
- 渲染层类型检查走 `tsconfig.web.json`（renderer/shared/mobile/android/ios）与 `tsconfig.harmony.json`（renderer/shared/mobile/harmony）；两套都要通过 `npm run typecheck`。
- 渲染层文件约 140 个，按 `pet/`、`ui/`、`swf/` 分层；新增 UI 放在 `src/renderer/ui/`，宠物规则不得复制到渲染层。

## 2. `window.qqpet` 契约

- 通道常量只在 `src/shared/ipc.ts` 定义（`IPC` 对象，`src/shared/ipc.ts:15` 起）；主进程、preload、移动桥都用同一常量，禁止散落字符串。
- preload 只暴露声明过的能力，不透传 `ipcRenderer`；新增方法必须同步 `QQPetApi`（`src/shared/ipc.ts:266`）与各移动桥，否则另一端会运行时缺方法。
- 渲染层调用方式：读取/一次性操作走 `invoke`，事件订阅走 `on*`；订阅回调要处理重复注册与解绑，preload 已按通道清理旧监听。
- 存储/管理类 IPC 是 owner-only 高风险面：主进程先校验调用方是受信主 frame（`src/main/storage-ipc.ts:23`），再校验载荷；未授权或非法载荷必须抛错，不得降级执行。
- 渲染层不得假设桌面能力存在：`setHitShape` 仅 Linux 暴露，托盘菜单仅 macOS 暴露；跨端代码用能力判断，不按平台名硬编码业务分支。

## 3. 投影与本地状态

- `RendererProjection`（`src/shared/renderer-api.ts:14`）是渲染层唯一权威视图：`save` 已合并设备本地 overlay，`shared` 只含规范化共享状态，`authority`、`revision`、`eventSeq`、`gameTimeMs` 必须随投影一起更新。
- 渲染层不得用 host-only 诊断字段（`device`、`status`）驱动规范化规则；这些字段只用于展示与排错（`src/shared/renderer-api.ts` 注释）。
- 投递分类在 `src/shared/renderer-api.ts:216`：`initial`、`event_gap`、`event_after_head`、`event_order`、`authority_changed`、`stale`。出现 `resync` 时必须丢弃缺口状态并接受完整快照，不能把旧投影继续叠加。
- 设备本地字段只能通过 `DeviceLocalOverlay` / `DeviceLocalOverlayPatch` 修改；`src/shared/renderer-projection.ts:262` 的 `assertDeviceLocalSavePatch` 会拒绝把规范字段塞进本地 patch。
- 永不上传的键（`aiKey`、`searchKey`、`webhookToken` 等）只能在设备本地存储；不得写入共享存档、投影或同步命令（`src/shared/sync/data-boundary.ts:70`）。

## 4. 存档与本地权威

- 桌面默认使用 v2 本地运行时：`save.v2.json` 是权威文档，`QQPET_LOCAL_V2_ROLLBACK=1` 才回退旧写手（`src/main/renderer-runtime-flags.ts:8`、`:29`、`:39`）。旧写手与 v2 文档同时存在时必须失败关闭，禁止双写。
- 旧存档路径为 `userData/save.json`，写入通过 `atomicWrite`（临时文件 + rename，针对 Windows 占用重试，`src/main/atomic-write.ts:11`）；损坏存档改名保留，不静默丢弃。
- 本地 v2 的 flush、覆盖度与心跳由 `src/shared/local-repository/**` 定义；渲染层只调用统一 API，不直接读写存档文件。
- 移动端存档由各宿主原生存储实现（Android/Harmony 的 `local-repository-storage.ts`，iOS 的 `save-record.json`）；渲染层不得假设桌面文件布局。

## 5. 跨端与视觉约束

- iOS 共用渲染代码以 Safari 14.0 为底线；Ruffle 的 Wasm 由 `scripts/lower-ruffle.mjs` 降级签名扩展指令，构建会校验输入/输出哈希，改动回退链路必须重新验证。
- iOS 音频走原生 AudioQueue，不创建 WebAudio；渲染层不能假设 `AudioContext` 可用（`ios/README.md`）。
- Android/HarmonyOS 的窗口按可见内容裁剪，透明区域不能透传触摸；移动端命中/覆盖逻辑在 `src/mobile/overlay.ts` 与 `src/mobile/bounds.ts`，改动需同时考虑旋转与安全区。
- 剪贴板、前台应用观察、开机自启在各平台能力不同；UI 必须展示能力限制，不得用桌面行为假装移动端支持。
- 样式集中在 `src/renderer/*.css`、`src/renderer/ui/css/` 与平台补充 CSS；不做与现有视觉体系无关的框架迁移。

## 6. 失败模式

- preload 未注入或方法缺失：渲染层应给出明确错误提示，不得静默降级为本地模拟。
- IPC 未授权、载荷非法、存储控制器未激活：主进程抛 `unauthorized` / `invalid_payload` / `storage_unavailable`，界面展示失败而不是重试到成功。
- 投影缺口、权威变化、恢复回滚：进入 `resync` 并等待完整快照；快照未到前禁用命令入口。
- 服务端断线：保留最后投影的只读展示，状态栏明确 offline/catching_up；不得在离线时自行推进规范化时间。
- 存档写失败：保留内存状态并重试/报错，不得丢弃用户进度；损坏文件改名保留后提示恢复路径。

## 7. 验证命令

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | node/web/harmony/e2e 四套类型检查 |
| `npm run test:compat` | 渲染层源码级测试（`renderer-*`、`storage-ipc`、移动桥等） |
| `npm run build` | Electron 主进程/preload/渲染层构建 |
| `npm run build:android-web` / `build:harmony-web` / `build:ios-web` | 对应平台 Web 产物 |
| `npm run test:e2e` | 真实服务端 + 双 Electron 渲染进程 |
| `npm run check:docs` | 前端契约变更后的文档同步 |

## 8. 变更影响

- 改 `src/preload/**`、`src/shared/ipc.ts`、`src/shared/renderer-api.ts` 时更新 `docs/architecture/desktop-ipc-and-preload.md`。
- 改 `src/shared/renderer-projection.ts`、存档逻辑或本地权威时更新 `docs/architecture/pet-runtime-and-save.md`。
- 改 `src/android/**`、`src/ios/**`、`src/harmony/**`、`src/mobile/**` 或原生工程时更新 `docs/architecture/native-bridge.md`。
- 新增 IPC 方法、投影字段或平台能力时，同时检查四端实现与 `docs/doc-map.json` 映射；不得只改桌面。
