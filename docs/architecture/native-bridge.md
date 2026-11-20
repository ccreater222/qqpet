# 原生桥接契约（Android / iOS / HarmonyOS）

> 结论：三端宿主都向页面暴露同一个 `window.qqpet` 契约，但桥接方式分两族：Android 与 HarmonyOS 用「`QQPetNative` 同步方法 + `__qqpet.resolve(id, value, error)` 异步回执」的延迟调用协议；iOS 用「`webkit.messageHandlers.qqpet` 结构化消息 + 按 `page` 作用域回执」的 RPC 协议。方法名、参数形状、返回值语义在同一族内必须逐字对齐；新方法一律设计成可选能力，旧壳缺方法时页面降级而不是崩溃。Android 是唯一编入 server mode 的移动宿主：桥新增 Keystore token 三方法与 `removeStateFile`，状态文件白名单放行三个非机密配置文件，`remote-token.bin` 只能经 Keystore 方法读写；传输只允许 `wss://` 或 loopback `ws://`，iOS/HarmonyOS 仍不提供 server mode。Android 手机页面还按 1 CSS px = 1 dp 布局（平板仍 480 CSS px），手机面板打开时通过可选原生方法 `setBackHandler` 把返回键交给页面 `__qqpetBack`；旧壳缺该方法时退化为原行为。

## 1. 范围与分层

页面侧只有一层入口：`window.qqpet`（`QQPetApi`）。桌面端由 Electron preload 注入，移动端由 `src/android/bridge.ts`、`src/harmony/bridge.ts`、`src/ios/bridge.ts` 在页面加载时赋值：

- Android：`src/android/bridge.ts:499`（`window.qqpet = api`），页面运行在 `PetService` 的 WebView 里。
- HarmonyOS：`src/harmony/bridge.ts` 末尾同样是 `window.qqpet = api`，页面运行在 `PetHost` 的 `TYPE_FLOAT` 浮窗 WebView 里。
- iOS：`src/ios/bridge.ts:523`，页面运行在 WKWebView 里，`window.qqpet` 之外还暴露 `window.__qqpetIOS` 给原生回调（`ios/native/QPHostController.m:279-282`）。

本文的代码位置形如 `path:line`。为控制宽度，同一平台小节内省略前缀：`PetService.kt` = `android/app/src/main/java/net/ankio/qqpet/PetService.kt`，`Native.ets`/`PetHost.ets` = `harmony/entry/src/main/ets/pet/` 下同名文件，`QPHostController.m` = `ios/native/QPHostController.m`，`rpc.ts`/`save-writer.ts` = `src/ios/` 下同名文件；`bridge.ts` 一律写全路径，因为它有三份。

三端共享的沉淀代码在 `src/mobile/`：`bounds.ts`（窗口矩形收敛）、`overlay.ts`（哪些元素算「可见内容」）、`local-repository-bridge.ts`（本地权威 V2 与旧存档的谱系探测）、`game-played.ts`（小游戏时长事件转发）、`visibility.ts`；Android 专属的 server-mode 适配在 `src/mobile/remote-token-store.ts`（`MobileRemoteTokenStore`）与 `src/mobile/server-mode.ts`（`createMobileServerRuntime`），它们复用 `src/shared/remote/repository.ts` 的协议状态机。

## 2. 两族桥接协议

### 2.1 Android / HarmonyOS：同步方法 + id 回执

原生侧暴露名为 `QQPetNative` 的 JavaScript 接口对象：

- Android 由 `addJavascriptInterface(Bridge(), "QQPetNative")` 注册（`android/app/src/main/java/net/ankio/qqpet/PetService.kt:137`），每个方法带 `@JavascriptInterface`（`PetService.kt:396-648`）。
- HarmonyOS 由 ArkWeb 代理注册，实现类是 `harmony/entry/src/main/ets/pet/Native.ets`，方法白名单集中在 `Native.METHODS`（`Native.ets:20-25`）。

页面侧固定两个全局对象：

```ts
window.QQPetNative.read(name)                 // 同步返回字符串
window.__qqpet.resolve(id, value, error)      // 原生异步回执
window.__qqpet.emit(type, payload)            // 原生事件推送
```

`__qqpet` 的实现是 `pending` 表 + 自增 `seq`：`call(start)` 先登记 `{resolve, reject}` 再调用原生方法（`src/android/bridge.ts:195-199`）；原生完成时调 `resolve(id, value, error)`，`error === null` 走 resolve，否则 reject（`src/android/bridge.ts:203-213`）。Harmony 完全同构（`src/harmony/bridge.ts:117-134`）。

因此这一族有明确的「同步/异步」分工：

| 类别 | 方法 | 返回 |
| --- | --- | --- |
| 同步取值 | `read`、`safeArea`、`rotatableScreen` | 直接返回字符串/布尔，页面当帧可用 |
| 同步副作用 | `write`、`setFocusable`、`setAutoStart`、`setTray`、`setHidden`、`setBounds`、`copyText`、`openUrl`、`quit`、`openGame` | 返回 `void`，失败只能通过后续读取或事件暴露 |
| 异步请求 | `http`、`exportSave`、`importSave` | 返回 `void`，结果经 `resolve(id, …)` 回执 |

`http` 的回执约定是 `{"status": n, "body": "…"}` JSON 字符串（`src/android/bridge.ts:51-52`）；`exportSave` 写成功回执 `"true"`、取消回执 `null`（`src/android/bridge.ts:53-54`）；`importSave` 回执被选中文件的文本或 `null`（`src/android/bridge.ts:55-56`）。

### 2.2 iOS：结构化消息 + page 作用域

iOS 没有 `QQPetNative`：桥用 WKScriptMessageHandler，handler 名固定 `qqpet`（`src/ios/bridge.ts:85-89`），消息体是 `{ page, id, op, args }`（`src/ios/rpc.ts:1-6`）。RPC 类 `IOSRPC`（`src/ios/rpc.ts:30-100`）负责序号、超时（默认 65 秒，`src/ios/rpc.ts:70`）、AbortSignal 与取消通知。

关键差异：

- **命名空间**：用 `op` 字符串区分操作，不使用同名 JS 方法。原生调度在 `ios/native/QPHostController.m:550-769`，未知 op 回 `Unsupported native operation: …`（`QPHostController.m:769`）。
- **page 作用域**：每个页面实例生成随机 `page` 标识（`src/ios/rpc.ts:37`），原生回执必须带同一个 page 才会被接受（`src/ios/rpc.ts:82-83`；原生侧拼 `window.__qqpetIOS.page===…` 校验，`QPHostController.m:282`）。这样页面重载后旧 ID 不会误结算新请求。
- **值类型**：回执是结构化对象（如 `safeArea` 回 `{left,top,right,bottom,viewport,layoutGeneration,layoutRevision}`，`QPHostController.m:692`），不是 JSON 字符串。
- **可取消性**：`cancellable = {http, importSave, exportSave, openGame, editText}`（`src/ios/rpc.ts:14`）；页面销毁或超时时只对这类 op 发 `cancel`，文件写入不会被中断（`src/ios/rpc.ts:58-67`、`src/ios/rpc.ts:91-100`）。

事件通道也不同：iOS 用 `window.__qqpetIOS.emit(type, payload)`（`QPHostController.m:279`），页面在监听器注册前把早期事件缓存（最多 32 条，`cursor`/`front` 只保最新，`src/ios/bridge.ts:93-105`），并在下一个 tick 回放（`src/ios/bridge.ts:106-116`）；Android/Harmony 直接分发给已注册监听器（`src/android/bridge.ts:203-213`）。

## 3. 方法对齐表

对齐的判定标准不是「名字看着像」，而是「页面调用参数、原生读取方式、回执语义」三者一致。表中「Android」列的行号指 `PetService.kt`，「HarmonyOS」列指 `Native.ets`，「iOS」列指 `QPHostController.m`（全路径见上文约定）。

| 能力 | Android (`PetService.kt`) | HarmonyOS (`Native.ets`) | iOS (`QPHostController.m`) |
| --- | --- | --- | --- |
| 读私有文件 | `read(name)` → `String?`（`:406`） | `read(name)` → `String`，缺失返回 `''`（`:27-34`） | `readLocalStateFile` / `readLegacySave`（`:568-587`） |
| 原子写 | `writeAtomic(name,text)` → `Boolean`（`:461`） | 同名同签名（`:95-123`） | `writeLocalStateFileAtomic`（`:568-587`） |
| 删除状态文件 | `removeStateFile(name)` → `Boolean`，仅白名单、缺失也返回 true（`:471-475`） | 无 | 无 |
| 普通写 | `write(name,text)`（`:409`） | 同名（`:36-43`） | `writeSave`/`replaceSave`/`preserveCorrupt`（`:588-608`） |
| HTTP | `http(id,method,url,headers,body)`（`:579`） | 同名，body 用空串而非 null（`Native.ets:124-153`） | `op: "http"`（`:609-623`） |
| 导出/导入存档 | `exportSave(id,name,text)` / `importSave(id)`（`:582`、`:595`） | 同名（`Native.ets:155-189`） | `op: "exportSave"` / `"importSave"`（`:759-768`） |
| Keystore token | `saveRemoteToken(token)` / `loadRemoteToken()` / `clearRemoteToken()`（`:526`、`:546`、`:567`） | 无 | 无 |
| 窗口矩形 | `setBounds(x,y,w,h,viewport)`（`:637`） | `setBounds("x,y,w,h,viewport")` 单字符串（`Native.ets:228-231`） | `op: "setGeometry"` + `bounds` 字典（`QPHostController.m:625-639`） |
| 安全区 | `safeArea(viewport)` → `"l,t,r,b"`（`:641`） | 同名同格式（`Native.ets:233-235`） | `op: "safeArea"` → 对象（`:652-692`） |
| 托盘/通知 | `setTray(icon, tip?)`（`:631`） | `setTray(icon, tip)`，`'null'` 归一成空串（`Native.ets:220-222`） | `op: "setTray"`（`:696`） |
| 隐藏宠物 | `setHidden(on)`（`:634`） | 同名（`Native.ets:224-226`） | 无同名 op，状态经 `status` 上报（`:697-707`） |
| 返回键路由 | `setBackHandler(on)`（`:623`） | 无 | 无 |
| 开机自启 | `setAutoStart(on)` 写 prefs（`:628`） | 同名（`Native.ets:216-218`） | 明确拒绝并回原因（`:695`） |

`setBounds` 的签名差异是刻意的、必须保留：Android 的 `Bridge` 是 `double` 参数逐个接收；ArkWeb 代理对多参数支持不一致，Harmony 侧改收一个逗号分隔串并在 `Native.ets:228-231` 拆包；iOS 走字典 op，因为窗口几何还要和 crop/旋转一起提交。

### 3.1 启动顺序差异

- Android/Harmony 是同步启动：模块加载即 `native.read('save.json')`，解析失败时先把坏文件另存为 `save.json.corrupt-<时间戳>` 再按空存档起步（`src/android/bridge.ts:232-243`），随后在旧权威可用时立刻回写（`src/android/bridge.ts:245-257`）。`leaving` 标志保证"重载到另一个存档"时，渲染层排队的旧写入不会落到新存档上（`src/android/bridge.ts:246-247`、`src/android/bridge.ts:422`）。
- iOS 是异步启动：页面先发 `bootstrap` op，原生必须回一个非空 `generation`，否则直接失败（`src/ios/bridge.ts:527-528`）；拿到 generation 后才创建 `IOSSaveWriter`（`src/ios/bridge.ts:620-630`），并把就绪 Promise 暴露为 `window.__qqpetReady`（`src/ios/bridge.ts:631`）。bootstrap 回传的存档损坏时，先调 `preserveCorrupt` 保留坏文件再继续（`src/ios/bridge.ts:603-611`），入口错误经 `reportError` 走 `qqpet-platform-error` 事件（`src/ios/bridge.ts:127-132`）。

## 4. 可选能力与降级

页面把「宿主是否具备某项能力」当作运行时事实，而不是编译期假设。能力面由 `QQPetApi.capabilities` 表达：

- Android：`rotatableScreen` 取决于 `native.rotatableScreen?.() ?? false`（`src/android/bridge.ts:370-377`），`localRepositoryV2` 取决于本地运行时是否成功建立，`serverMode`/`serverModeClientOnly` 取决于移动 server-mode 运行时是否建立（见 §4.1）。
- HarmonyOS：`rotatableScreen: true` 固定（浮窗随内容旋转），`localRepositoryV2` 同上（`src/harmony/bridge.ts:304-310`）。
- iOS：能力面是常量表加 bootstrap 覆盖（`src/ios/bridge.ts:73-83`），启动后用原生 `bootstrap` 回执合并，并把 `autoStart` 强制为 `false`（`src/ios/bridge.ts:530-532`）。

具体降级规则：

1. **旧壳缺原子状态能力**：`readStateFile`、`readLegacySave`、`writeAtomic` 在页面类型里是可选方法（`src/android/bridge.ts:32-50`、`src/harmony/bridge.ts:30-35`）。三者任一缺失就把 `localRuntimeFailure` 设为 `native atomic state storage capability is missing`，本地权威 V2 关闭，`capabilities.localRepositoryV2` 置 `false` 并带 `localRepositoryV2Reason`（`src/android/bridge.ts:111-143`、`src/android/bridge.ts:370-377`）。页面读到原因后回退到旧 `save.json` 路径，而不是假装 V2 可用。
2. **Web Crypto 不可用**：同样关闭 V2 并给出 `Web Crypto getRandomValues is unavailable`（`src/android/bridge.ts:130-131`）。
3. **旧壳缺隐藏/旋转能力**：`setHidden?`、`rotatableScreen?` 用可选调用；缺失时页面按「不支持」处理（`src/android/bridge.ts:68`、`src/harmony/bridge.ts:47`、`src/harmony/bridge.ts:230`）。
4. **iOS 明确不提供的能力**：`autoStart`、`clipboardWatch`、`frontWatch` 为 `false` 且带 `*Reason`（`src/ios/bridge.ts:77-82`）；导入的桌面设置里这三项会被强制关掉（`src/ios/bridge.ts:270-272`、`src/ios/bridge.ts:427-428`），避免「设置看起来开着、实际不生效」。
5. **iOS 存档写入使用 generation**：`IOSSaveWriter` 要求非空 generation（`src/ios/save-writer.ts:15-17`），一次只排一个写者，旧的排队快照在被替换后失效（`src/ios/save-writer.ts:5-22`）。页面缺少 generation 时直接失败，不做「无 generation 也能写」的兜底。
6. **客户端数据上游**：`calendar`、`weather`、`latestRelease` 不新增原生方法，三桥从设备本地 `settings.upstreamUrl` 经共享 `normalizeUpstreamUrl` 取 HTTP origin（`src/android/bridge.ts:250-251`、`src/harmony/bridge.ts:172`、`src/ios/bridge.ts:120`）。未配置有效上游时 `weather`/`latestRelease` 显式抛 `upstream_not_configured`，`calendar` 仍用共享纯函数本地计算；旧壳或未配置服务器不会崩溃，也不会回退到第三方域名。
7. **Android server mode 前置能力缺失**：`readStateFile`/`writeAtomic`/`removeStateFile`、`saveRemoteToken`/`loadRemoteToken`/`clearRemoteToken` 任一缺失（旧壳）就关闭 server mode：token store 构造时抛 `native_server_mode_capability_missing`（`src/mobile/remote-token-store.ts:111-120`）；bridge 在创建运行时前也做同一组前置检查并记 `native_server_mode_capability_missing`（`src/android/bridge.ts:151-191`），因此不创建运行时，`capabilities.serverMode=false`、`serverModeClientOnly=false`；本机模式照常可用，绝不回退明文 token 或伪造配对成功。
8. **旧壳缺返回键通道**：`setBackHandler?` 是可选方法（`src/android/bridge.ts:61-63`）。缺失时 `window.__qqpetSetBackHandler` 为 no-op，手机模态仍可点遮罩、✕ 或下滑关闭，返回键回到原行为（`src/renderer/ui/mobile/back.ts:13-23`、`PetService.kt:146-156`）。

### 4.1 Android server mode 的原生契约

Android 是唯一编入 server mode 的移动宿主：它复用 `src/shared/remote/repository.ts` 的协议状态机，原生侧只提供存储与密钥能力。配对后的设备角色由服务端签发配对码时决定（`pair --role player|owner`）：player 只能发玩家命令，owner 才能用 owner 命令；移动面板对 owner 只读展示设备列表，不提供撤销/交接/备份。服务器模式激活期间本机宠物只 `suspend`（停调度、不写盘、不上传），切回本机才 `resume`。

- **状态文件白名单**：页面只能按名字读写/删除固定白名单文件——`save.v2.json`、`save.v2.json.bak`、`save.json.bak`、`save.v2.json.corrupt-<时间戳>`，以及 server mode 新增的 `storage-config.json`、`sync-config.json`、`remote-projection-cache.json`（`PetService.kt:420-427`）。任意其它名字（含 `save.json`、`../` 路径）一律拒绝。
- **token 不进文件 API**：`remote-token.bin` 刻意不在白名单里，页面只能通过 `saveRemoteToken`/`loadRemoteToken`/`clearRemoteToken` 触达（`PetService.kt:526-575`）。
- **Keystore 封装**：别名固定、AES-256/GCM/NoPadding、随机 IV；落盘格式为 `version(1) | ivLength(1) | iv | ciphertext` 的 Base64，先写临时文件并 `fsync` 再 `ATOMIC_MOVE`（`PetService.kt:526-544`、`:482-496`）。`loadRemoteToken` 对「文件不存在」回 `{"status":"ok","text":null}`，对解密失败回 `{"status":"error",…}`；页面必须把 error 当失败关闭，不能覆盖或明文回退（`PetService.kt:546-565`）。`clearRemoteToken` 同时删密文与 Keystore key（`PetService.kt:567-575`）。
- **重装语义**：Keystore key 随应用卸载消失，旧 `remote-token.bin` 无法解密 → 必须重新配对；这是预期失败关闭。
- **传输限制**：Android 页面 origin 是 `https://appassets.androidplatform.net`，WebView 安全上下文会拒绝指向私网地址的明文 `ws://`，`mixedContentMode` 不是可靠开关。因此 Android 只接受 `wss://` 或 loopback `ws://127.0.0.1`/`localhost`：`assertAndroidServerUrl` 在共享校验之后追加「非 loopback 的 `ws://` 一律拒绝」（`src/mobile/server-mode.ts:158-172`），配对入口先用它（`src/mobile/server-mode.ts:112-117`，错误码 `android_transport_unsupported`）。模拟器/局域网联调统一 `adb reverse tcp:8787 tcp:8787` 后填 `ws://127.0.0.1:8787/v1/sync`。共享 `assertRemoteServerUrl` 对私网 `ws://` 的放行保持不变（桌面 LAN 需要，`src/shared/remote/endpoint.ts:47-54`），收紧只在移动宿主层。

### 4.2 Android 手机视口与返回键通道

Android 手机与平板共用同一份 WebView，但设计空间由 `AssetClient` 单点决定：`scale = max(1, min(widthPixels, heightPixels) / density / 480)`（`AssetClient.kt:72-79`）。短边小于 480 dp 的手机得到 `scale = 1`，页面按 `width=device-width, initial-scale=1` 布局，1 CSS px = 1 dp；短边不小于 480 dp 的平板得到 `短边dp / 480`，仍是 480 CSS px 设计空间，固定像素画面板按原比例缩放（`AssetClient.kt:17-18`）。页面侧不读 UA：`phoneUI()` 用 coarse 指针、短边 ≤ 600 dp、`visualViewport.scale ≈ 1` 和 `clientWidth ≈ screen` 四项实测决定是否给 `body` 挂 `qp-phone`（详见 [手机 UI 层](mobile-ui.md)），因此旧壳被缩到 480 时手机样式不会误启用。

返回键增加一条只影响 Android 的可选通道：

- **原生方法**：`Bridge.setBackHandler(on)` 只改 `backHandler` 标志（`PetService.kt:621-625`）。`dispatchKeyEvent` 遇到 `KEYCODE_BACK` 时，若标志为真则执行页面注册的 `window.__qqpetBack && window.__qqpetBack()` 并消费按键；否则走原来的 `setFocusable(false)` 把焦点还给下层（`PetService.kt:146-156`）。
- **页面入口**：`src/android/bridge.ts:98-101` 把 `native.setBackHandler?.(on)` 暴露为 `window.__qqpetSetBackHandler`，`Native` 接口里它是可选方法（`src/android/bridge.ts:61-63`）。手机模态共享 `src/renderer/ui/mobile/back.ts` 的栈：`pushBack(close)` 入栈时注册只关闭栈顶的 `window.__qqpetBack`，第一层入栈时调用 `setFocusable(true)`，最后一层释放时清空 `__qqpetBack`、调用 `setBackHandler(false)` 与 `setFocusable(false)`（`back.ts:13-39`）；sheet、box 框和宠物状态卡都复用该栈（`src/renderer/ui/mobile/sheet.ts:149-151`、`src/renderer/ui/box.ts:186-199`、`src/renderer/ui/state.ts:313-314`）。
- **旧壳降级**：没有 `setBackHandler` 的壳上钩子 no-op，`__qqpetBack` 永不触发，面板仍可用遮罩、✕ 或下滑关闭；这是显式能力缺席，不是失败兜底（`src/renderer/ui/mobile/back.ts:13-23`）。
- **焦点与按键分离**：`setBackHandler` 只控制返回键路由，窗口可聚焦性仍由 `setFocusable` 负责；页面在最后一层模态关闭时统一释放两者（`src/renderer/ui/mobile/back.ts:13-23`），不要在 `__qqpetBack` 里单独切换窗口焦点。

## 5. 同步返回值 vs 异步 resolve 的判据

新增方法时按以下判据决定形态，规则来自现有实现的分工：

- 结果必须在同一帧内用于布局或绘制 → 同步返回值。例：`safeArea()` 在首帧写入 `--safe-*` CSS 变量（`src/android/bridge.ts:350-353`），`read()` 在启动时同步读存档。
- 涉及系统 UI（文件选择器、通知、权限、剪贴板）或网络 → `void` + 异步回执。例：`exportSave`/`importSave` 打开系统文件选择器后经 `resolve` 回执（`PetService.kt:582`、`:595`）。
- 原生侧需要在非 WebView 线程完成工作 → 必须 `void`，并在 WebView 线程回执。Android 的 `resolve` 用 `web.post`（`PetService.kt:291-293`），`setBounds`/`setTray`/`setFocusable` 也都 `web.post`（`PetService.kt:619`、`:631`、`:637`）。
- 失败即不可继续的启动型操作 → 同步抛错。iOS 在找不到 WK handler 时直接 `throw new Error('QQPet requires its iOS WKWebView host.')`（`src/ios/bridge.ts:87`）。

## 6. 事件与线程约束

三端共有事件：`trayClick`、`gamePlayed`、`clipboard`、`presence`；Android/Harmony 另有 `outside`（触摸落在浮窗外），iOS 另有 `cursor` 与 `front`（`src/android/bridge.ts:75-84`、`src/harmony/bridge.ts:52-58`、`src/ios/bridge.ts:41-48`）。

- Android 的 `emit` 定义在 `PetService.kt:289`，拼 `__qqpet.emit('type', payload)` 注入页面；`PetHost.emit` 同构（`harmony/entry/src/main/ets/pet/PetHost.ets:112-114`）。
- 推送的值是 JSON 字面量文本，页面侧按事件类型解析；`presence` 在 Harmony 上是 `'true'`/`'false'` 字符串（`harmony/entry/src/main/ets/pet/PetHost.ets:101`）。
- `outside` 事件在页面侧被翻译成「视口四角之一」的 cursor 位置，前提是该角不在当前窗口矩形内（`src/android/bridge.ts:358-368`）。窗口矩形与触摸事件必须来自同一坐标系（CSS 像素、页面宽度为 `innerWidth`）。

## 7. 不变量清单

1. 页面只认 `window.qqpet`；任何新宿主能力都必须经由 `QQPetApi`，不得让页面直接读 `window.QQPetNative` 或 `webkit.messageHandlers`。
2. Android/Harmony 的 `QQPetNative` 方法名、参数顺序、回执通道必须逐字一致；`Native.METHODS` 是 ArkWeb 暴露的白名单，新增方法必须同时改 `src/harmony/bridge.ts` 的 `Native` 接口与 `Native.ets`。
3. 异步调用必须成对：登记 `pending` → 原生 `resolve` 或 reject；未知 id 不得抛异常（`src/android/bridge.ts:203-213` 与 `src/ios/rpc.ts:84-85` 都做了存在性检查）。
4. iOS 回执必须匹配 `page`，否则丢弃；页面销毁后旧回执不能结算新请求。
5. 缺能力时必须显式降级并给出原因字符串，不允许静默假设可用。
6. `safeArea` 与 `setBounds` 在所有端使用同一单位（CSS 像素，基于调用时的 `viewport` 宽度换算），不一致会导致浮窗与内容错位。
7. 只有 `cancellable` 集合内（iOS）或可被 retry 的请求允许在页面销毁时取消；存档写入必须跑完。
8. Android 状态文件必须按**精确名字**白名单放行（`PetService.kt:420-427`）：页面不能借 `read/writeAtomic/removeStateFile` 触达 `remote-token.bin`、`save.json` 或任意 `filesDir` 路径。
9. 设备 token 只允许经 Keystore 三方法进出（`PetService.kt:526-575`）；封装失败一律返回失败，不允许明文回退，也不允许把 token 写进日志、URL、配对码参数或投影缓存。
10. Android 的 `capabilities.serverMode` / `serverModeClientOnly` 必须由「原生能力齐备 + 移动 server 运行时已建立」推导，不能写成常量；`runtimeInfo().serverMode` 仍表示**当前权威**是否在服务器。
11. Android 返回键只在 `backHandler` 为真时交给页面，且页面只关闭 back 栈顶（最上层 sheet/框/状态卡）；旧壳没有 `setBackHandler` 时不得假装能拦截返回键（`PetService.kt:146-156`、`src/renderer/ui/mobile/back.ts:13-39`）。

## 8. 验证命令

```bash
# 桥接与移动端相关单元测试（含 iOS RPC、覆盖窗口收敛、iOS 存档写入）
node --experimental-strip-types --test \
  scripts/tests/ios-bridge.test.mjs \
  scripts/tests/android-overlay.test.mjs \
  scripts/tests/ios-safe-area.test.mjs

# Android server mode 宿主（token store、配对/切换/重连、缓存只读、失败关闭）
node --experimental-strip-types --test scripts/tests/mobile-server-mode.test.mjs

# 全量兼容测试（桥接测试在其中）
npm run test:compat

# 三端类型检查（android/harmony 桥与共享契约）
npm run typecheck

# 构建对应平台 Web 产物，确认桥接入口被打进产物
npm run build:android-web
npm run build:harmony-web
npm run build:ios-web
```

Android 原生侧的行为断言是「读源码 + 正则」式的结构测试（例如 `scripts/tests/android-overlay.test.mjs:7-24` 断言窗口移动不透明度、偏移与 `updateViewLayout` 的顺序），不是运行时测试；改 Kotlin 侧顺序时这些断言会失败，这是预期保护。

## 9. 变更影响

- 新增/改名 `QQPetNative` 方法：必须同步改页面 `Native` 接口、Android `Bridge` 类、Harmony `Native.ets` 与 `Native.METHODS`、对应 `scripts/tests/*bridge*` 断言；漏一端会在该平台运行时报「不是函数」。
- 把同步方法改成异步：破坏首帧布局（`safeArea`）与启动读存档，属于契约级破坏，需要同步更新本文与 `docs/standards/backend.md`/`frontend.md` 中的桥接约定。
- 改 `setBounds` 参数形状：Android 数值参数、Harmony 逗号串、iOS 字典三者独立，但语义必须一致；只改一端会导致窗口抖动或内容错位，`bounds.ts` 的收敛规则也会失配。
- 改 iOS `page` 作用域或取消集合：会让旧回执误结算或让存档写入被中断，属于数据风险，必须补 RPC 测试。
- 新增能力面字段：旧壳不会返回它，页面读取时必须给默认值（参照 `rotatableScreen: native.rotatableScreen?.() ?? false`），否则旧壳上会出现 `undefined` 参与判断。
- 新增状态文件：必须同时改 `allowedStateName`（`PetService.kt:420-427`）和移动宿主的读写路径，并在本文 §4.1 登记；**秘密文件不得进白名单**，只能新增专用的 Keystore 方法。
- 改 server mode 能力判定：`src/android/bridge.ts` 的 `capabilities`/`runtimeInfo`、`src/shared/ipc.ts` 的类型与 `src/renderer/ui/storage.ts` 的移动面板必须同步；漏改会让 UI 显示可配对而运行时拒绝，或反之。
