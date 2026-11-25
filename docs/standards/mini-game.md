# 小游戏规范

> 结论：qqpet 的小游戏不是现代游戏引擎，而是 **Ruffle 0.6 Flash 兼容运行时 + 每窗一个 iframe/一个 WASM 实例** 的桌面窗口模型移植。它兼容旧 SWF，但每窗约 30–80MB、启动 2–3s、移动端峰值约 600MB；新小游戏必须按“1 个 root + 有限 base + 有界动态窗 + 池化 + 两轮 RSS 验收”开发，不能按桌面“每个对象开一个窗口”的方式写。当前六个游戏均已按此模型接入，0.18 实测 guess/paopao2/100ceng PASS，ball/rope PASS-with-risk，mouse 仍有第二轮稳定性问题。

- 适用：`resources/pet/smallGame/**` 的 SWF、`src/renderer/ui/smallgame.ts`、`src/renderer/ui/smallgame-geometry.ts`、`src/renderer/ui/gamepad.ts`、`src/renderer/ui/mobile/phone-games.ts`、`src/renderer/swf/player.ts` 及 Android 原生键桥。
- 关联：[手机 UI 架构](../architecture/mobile-ui.md)、[原生桥架构](../architecture/native-bridge.md)、[前端规范](frontend.md)。
- 证据：0.12–0.18 验收见 `.agent-reports/acceptance/`；临时复现见 `tmp/reports/smallgames/`。
- 本规范是现行合并门禁；与任务描述冲突时以本规范为准，超出预算必须在 `tmp/specs/` 写明证据并由人类批准。

## 1. 为什么会有这些问题

1. **桌面窗口模型被直接移植**：原版每个 SWF 是一个独立无边框窗口，由 Windows 回收；移动端每个“窗口”变成 `<iframe>` + 完整 Ruffle/WASM 播放器。桌面窗口便宜，iframe/WASM 很贵。
2. **每窗重新加载 Ruffle**：0.11 的 `open()` 对每个 `CreateWindow` 新建 iframe 与 `new SwfPlayer`；root、status、prompt、气泡/老鼠/球都如此，WASM 线性内存、Ruffle 元素、Canvas 按窗计费。
3. **没有跨局复用/上限**：0.11 的 `destroy(root)` 只删 iframe，RSS 不归还；第一局约 606MB，第二局叠加到 985MB，CDP 30s 无响应，LMDK。
4. **Canvas2D 换了瓶颈**：0.11 用 Canvas2D 解决 WebGL 7–8 context 的 OOM/宠物空白，但让更多窗口活下来；下一个瓶颈变成 WASM/iframe 堆内存。
5. **旧 SWF 不知道手机**：`Capabilities.screenResolution` 是桌面值；部分 SWF 用固定边距，412px 视口下左右同时为真；需要 API 屏幕补丁 + 虚拟游戏区 + root clamp。
6. **输入语义没有完整移植**：旧游戏用鼠标/键盘/开始按钮/命中窗口；移动端只有 DOM/pointer 不够，100ceng 还需要原生 keyevent。
7. **不是 CS**：`game.startSession`/`game.reward` 只传 session/reward，不传窗口几何、显隐、渲染、输入、屏幕尺寸；故障在本地窗口层。

## 2. 术语与预算

| 术语 | 含义 |
|---|---|
| root | 游戏主窗，必须恰好 1 个；`kind=root` |
| base | root 的常驻子窗：status_mood/status_count/prompt_mood/prompt_money 等；`kind=base` |
| dynamic | 运行中创建/销毁的对象窗：气泡、老鼠、球、云、player、action 等；宿主统一按动态窗计数 |
| shell | 一个 `.smallGameWin` + iframe + SwfPlayer 的完整实例 |
| pool | 退出后隐藏保留、下一局复用的 shell 集合 |

**每游戏硬预算**（`SMALL_GAMES` 的 `baseWindows + maxDynamicWindows`，也是 `shellCap()`）：

| 游戏 | baseWindows | maxDynamicWindows | 同时存活 shell 上限 | 备注 |
|---|---:|---:|---:|---|
| guess | 7 | 3 | 10 | 6 base + root + 3 action |
| paopao2 | 5 | 6 | 11 | root + 4 base + 最多 6 气泡 |
| rope | 5 | 0 | 5 | root + 4 base；无动态窗 |
| mouse | 5 | 1 | 6 | root + 4 base + 1 老鼠（单只复用） |
| ball | 8 | 3 | 11 | root + 7 base + ball/shadow/fallball |
| 100ceng | 5 | 0 | 5 | root + cloud + player + 2 prompt |

- 未声明游戏默认 `DEFAULT_SHELL_CAP=9`；新游戏必须在 `SMALL_GAMES` 声明 `baseWindows/maxDynamicWindows`，不能靠默认值上线。
- **单局新增 shell 应为 0**：第二局复用第一局池；只在池未命中且未达上限时新建。
- **退出后可见游戏窗必须为 0**；池 shell 必须 `hidden` + `display:none` + `data-pooled=1`。
- renderer 峰值 RSS **<850MB**（2GB 模拟器基线）；至少 <950MB 才可发布。
- 启动到 5 个可见窗 <4s；CDP/主线程单次 `Runtime.evaluate` 不允许 >1s。

## 3. 窗口模型（R1）

- 一个游戏只能有一个 root；禁止 SWF 再 `CreateWindow` 一个 `main_*` root。
- base 只允许 status_mood/status_count/prompt_mood/prompt_money 或同语义固定窗；prompt 必须惰性加载或可回收，不能每局无条件占 2 个 WASM 实例。
- **禁止为每个游戏对象开一个窗口**（每个气泡/老鼠/粒子/子弹）。优先在 SWF 内部用 MovieClip/Sprite 画；必须分窗时声明 `maxDynamicWindows` 并走池化。
- dynamic 必须是 root 的子窗（`parent=root`），由 root 的 `DestroyWindow` 生命周期管理；不能挂 body 上无主。
- 新游戏若 `maxDynamicWindows` 超过 4，必须提供“池化后玩法仍成立”的证据和降级方案；当前上限 6 是 paopao2 的例外，不是默认值。

## 4. 生命周期与池（R2）

- `destroy` 语义：`wins.delete` + 隐藏/回池 + `player.setIdle(true)`；**不要**在 SWF 自己的 `ExternalInterface` 调用里同步销毁 iframe；iframe 必须保持 connected，否则 `player.ts` 的 MutationObserver 会销毁 player，池失效。
- 池键：`${swf}|${w}x${h}`；跨局保留；达到 `shellCap()` 时按“pooled 动态窗 → 其它游戏 idle base/root → 当前可见 dynamic → 当前游戏 idle base”顺序驱逐；**永不驱逐**当前 root、可见 base、未 show 的 provisional 窗。切到更小 cap 的游戏时，必须先按即将使用的 `main_*.swf|140x140` poolKey 保留 root shell 再裁剪，不能先驱逐可复用 root。
- 复用：更新 name/parent/dir/坐标/尺寸，复位 `hidden/display`，重绑 `frame.contentWindow.API` + `TICKLE_*`；同一 `SwfPlayer.load(newSwf)` 重置 SWF。`reclaim` 必须按 kind 匹配：root 只接受 root shell，140×140 的 base/prompt 不得被提升为 root，base/bubble 也不得占用 root shell；root 的 quit 按钮在所有复用路径下存在且唯一（复用为 root 时补建、复用为子窗时移除），不要重复 append。
- 加载失败：`SwfPlayer.load` reject/timeout 必须 `discard`（隐藏、销毁 player、移除 iframe、从 wins/pool 删除）；root 失败必须恢复 `#pet`/`setDeskGame('')`。
- 退出：`finish()` 恢复 pet、`root=null`、`dir=''`；所有 shell 回池；可见游戏窗 0；不要依赖 `setTimeout(box.remove())` 释放内存。回池必须发生在 `finish()` 之前，按退出前游戏的 `shellCap()` 裁剪：完整 paopao2 局（11 shell）退出后池数量仍须为 11，不能回退到 `DEFAULT_SHELL_CAP=9`。

## 5. 渲染与性能（R3）

- 触屏/移动 smallgame：`SwfPlayer.load(..., { preferredRenderer: 'canvas' })`；桌面保持 Ruffle 默认（WebGL）。
- 不做“每窗一个 WebGL context”的移动方案；Canvas2D 是当前稳定路径；WebGL 只在桌面/有显存预算的设备。
- 每窗 canvas 尺寸 = 窗口尺寸 × dpr；禁止用 4K canvas 画 70×70 气泡；避免 SVG filter/大面积 shadow/逐帧 `getImageData`。
- 隐藏窗必须 `setIdle(true)`/suspend；不可见 prompt 不加载 SWF；不在后台跑 RAF/计时器。
- 新游戏要给出启动时间、峰值 RSS、单窗增量、最长单帧；超过预算要降级（少窗/池化/改内部对象）。

## 6. 屏幕/坐标/触摸（R4）

- SWF 不得直接信 `Capabilities.screenResolution`；必须走宿主 `API.GetScreenWidth/Height`（26 个 SWF 补丁模式）。
- 手机视口 <690×705（paopao2 的桌面边距放不下）时，root 使用虚拟游戏区 + `offset=180` + `clampRoot`；**只 root 映射**，子窗/气泡保持真实坐标。
- root 必须 clamp 在 `[0, innerWidth-MAIN]×[0, innerHeight-MAIN]`；quit 按钮是 root 子元素，任何移动后都必须可见。
- 触摸命中：可交互元素 ≥44×44 CSS px；不要依赖 hover；`pointerdown/up` + `setPointerCapture`；透明像素的点击穿透按 `PASSIVE` 规则处理。
- 屏幕旋转/安全区/多分辨率：按 `innerWidth/innerHeight` 重算，不缓存桌面尺寸；不得假设 1080×2340 或 dpr=2.625。

## 7. ExternalInterface / Show（R5）

- `API.*` 的窗口查找必须 null-safe：SWF 会持有已池化/已销毁的窗口名；`of()` 返回 undefined 时方法返回 `0/''/安全值`，不能 TypeError。
- `CreateWindow` 返回 0 表示宿主拒绝（达上限/加载失败）；SWF 必须能降级（不画该对象/重试/结束回合），不能死循环等窗口。
- `DestroyWindow` 幂等；`Show` 只改可见性；`RemoteCall` 目标不存在时 no-op；`GetWindowRect/Position` 对 root 返回虚拟坐标，对子窗返回真实坐标。
- **`Show` 语义按游戏声明**：默认 qqpet 语义 `0=显示/1=隐藏`（paopao2 bubble、guess、ball 等）；Windows 语义 SWF 是 `1=显示/0=隐藏`，当前只有 **100ceng**（`MainWindow.playerShow` 调 `Show(1)` 显示 player）。新游戏若来自 Win32，必须在 `Show` 增加明确分支 + 单元测试，不能全局反转。
- 不允许 SWF 在 `CreateWindow` 里同步等待宿主；宿主不允许在 `CallExternalInterface` 里重入同一玩家。

## 8. 输入与原生键桥（R6）

- 鼠标/触摸：优先用真实 pointer 事件；需要命中窗口时，宿主提供 `GetCursorPosition`/`APIEvent.OnMouseMove/OnHitWindow`，但旧 SWF 可能不注册，不能假设。
- 键盘：**只有声明 `keyboard` 的游戏才显示 D-pad**；当前 `100ceng` 用 `ARROW_KEYS`。D-pad 必须在游戏结束/切游戏/页面隐藏时释放所有键。
- Android 原生键桥（0.16+）：
  - 契约：`window.qqpet.sendGameKey(code: 'ArrowLeft'|'ArrowRight', phase: 'down'|'up') => Promise<boolean>`；只允许左右，返回 false 表示平台不支持/未运行。
  - Android：`PetService` 的 WebView 在 UI 线程 `dispatchKeyEvent(KeyEvent)`；`setGameKeyActive(true)` 只在小游戏运行期；50ms 限流、down 未 up 不重复、up 幂等；结束/隐藏释放所有键。
  - 其它平台缺失/返回 false 时回退 DOM `KeyboardEvent`；桌面 preload 明确返回 false，不静默假装成功。
  - 安全：不接任意键/文本/组合键，不申请权限，不暴露给非小游戏页面。
- 100ceng 启动顺序：cloud 的 `StartAnimation` 在 frame 36 发 `playerShow`（`Show(1)` 显示 player），frame 98 发 `addEvent`/“单击鼠标开始”；测试必须等 3.5–4.5s 再点 cloud 文本并按住 D-pad 800ms，不能用瞬时点击/文档 keycount 判过。cloud 启动点击是会话级幂等：每次 down（含 140ms repeat 与原生 `sendGameKey` 的 prepare）只允许触发一次 click，新局/结束重置；800ms 长按的 `cloudClicks` 增量必须 ≤ `nativeDown` 增量。

## 9. 六个游戏的适配要点

| 游戏 | 窗口/输入要点 | 验收 |
|---|---|---|
| guess | 6 base + 3 action；cap 10；无键盘；0=show | 6 base+action×3；两轮 RSS |
| paopao2 | root+4 base+最多 6 Bubble；虚拟区 `offset=180`；0=show；prompt eager（lazy 会阻塞 onWindowCreate） | 两轮 Bubble；>3 落点；<850MB |
| rope | root+4 base；中央 `waitToMouseDown_mc` 点一次，随后每个跳跃窗口点一次；非按住 | 启动/退出；节奏可人工复测 |
| mouse | root+4 base+1 rat；rat 窗 PASSIVE；真实输入是 tap root/宠物（不是 rat）；第二轮菜单状态要复位 | 两轮；宠物跳/得分；第二轮 open |
| ball | root+7 base+ball/shadow/fallball；intro 后点 `startbtn_mc/begin_mc` 才建 base/shadow | ball+shadow+4 base；完整颠球/结算；lightReopen |
| 100ceng | root+cloud+player+2 prompt；cloud 文本 click→`playerShow`→`Show(1)`；D-pad 原生 37/39 | player 可见；按住 x 位移；无 stuck |

## 10. CS 边界（R7）

- CS 只负责 `game.startSession`/`game.reward`（sessionToken、分钟/元宝/成长/心情）；**不传**窗口几何、显隐、渲染、输入、屏幕尺寸。
- serverMode/local V2 不得改变小游戏窗口层行为；本地模式必须能独立玩。
- 新增 CS 字段前先问“这是不是纯展示/窗口状态”；是则不要上 CS。

## 11. 测试与验收（每个新/改小游戏必跑）

1. **静态检查**：`CreateWindow` 不在无界循环；dynamic 有 `DestroyWindow`；`maxDynamicWindows` 已声明且 ≤6；无 `Capabilities.screenResolution`；prompt 惰性；`PASSIVE` 正确；`Show` 语义已声明。
2. **单元测试**：窗口池/上限/复用/load 失败/of 空值/Show 语义/D-pad 原生回退；参考 `scripts/tests/smallgame-renderer.test.mjs`、`smallgame-geometry.test.mjs`。
3. **两轮内存**：第一局 20–40s → quit（可见 0、pet 恢复）→ 第二局 20–40s；renderer 峰值 <850MB；无 CDP 超时/`SWF load timed out`/LMDK；DOM shell ≤cap；第二局宠物可见、对象 ≥3、root/quit 不出屏。
4. **60s soak**：单局 60s 或两局各 60s；RSS 不持续上升；无加载超时。
5. **真实设备**：至少 1 台 4GB RAM 真机；release 包升级；Android WebView 版本记录；模拟器结论不能替代真机。
6. **证据**：`.agent-reports/acceptance/`；含 APK sha256/version、renderer RSS 曲线、窗口数、logcat 关键 grep、截图；临时材料 `tmp/reports/`。

**0.18 基线**：guess 2/2 PASS（573.6/562.9MB）、paopao2 PASS（581.4MB）、100ceng PASS（476.9MB；player x 105→89；nativeTrue 14/false 0）、ball/rope PASS-with-risk（497/444.5MB）、mouse FAIL（第二轮 open）；全局 444.5–581.4MB，0 CDP 超时/0 SWF timeout/0 LMDK。

## 12. 性能与引擎结论

- **性能不高**：Ruffle 0.6 兼容优先，简单 2D 够用；单窗 30–80MB、启动 2–3s、峰值约 600MB，不适合大量动态窗、粒子、3D 或低端机多开。
- 池/上限/Canvas2D 把第二局稳定在约 600MB，但不改变单窗成本；**新游戏优先 SWF 内部对象**，不要复制桌面“每对象一窗”。
- 迁到现代 2D 引擎（PixiJS/Canvas/原生）是重写，不是优化；在兼容旧 SWF 的前提下，本规范是当前可维护路径。

## 13. 迁移/开放问题

| 项 | 状态 | 下一步 |
|---|---|---|
| guess | PASS | 保持两轮 RSS |
| paopao2 | PASS | difficult 横向 run/真机 |
| rope | PASS-with-risk | 节奏/可点帧人工复测 |
| mouse | FAIL | 第二轮 open（sheet=true）；确认测试状态/宠物命中 |
| ball | PASS-with-risk | 完整颠球/结算/lightReopen |
| 100ceng | PASS | 真机/60s；kid-only 边界 |
| 发布 | BLOCKED | CI token/KEYSTORE/E2E；**未授权 push 已发生，人类决定保留/回退** |

开放问题（需人类决定）：

1. mouse 的第二轮测试/游戏状态：是测试菜单复位还是游戏本身？在稳定前不宣称 PASS。
2. ball/rope 的完整玩法/节奏是否纳入发布门禁；当前只验收到“出现+可退出”。
3. 低端机（2GB/3GB）是否把 cap 降到 8/7，还是按设备内存动态降级？
4. 是否把“新小游戏两轮 RSS”加入 `gate:acceptance`？会增加发布门禁时间。
5. 长期是否接受 Ruffle 兼容层 ~600MB 成本，还是迁移现代 2D 引擎（重写）。

## 14. 参考

- 代码：`src/renderer/ui/smallgame.ts`、`smallgame-geometry.ts`、`gamepad.ts`、`src/renderer/swf/player.ts`、`src/android/bridge.ts`。
- 测试：`scripts/tests/smallgame-renderer.test.mjs`、`smallgame-geometry.test.mjs`。
- 验收：`.agent-reports/acceptance/2026-11-20-mobile-smallgames-018.md`（0.18）、`...-017.md`、`...-016-native.md`、`...-015.md`。
- 复现：`tmp/reports/smallgames/verify-013/`…`verify-018/`、`tmp/reports/smallgames/manual/manual-100ceng.md`。
- 文档：[手机 UI 架构](../architecture/mobile-ui.md)、[原生桥架构](../architecture/native-bridge.md)、[前端规范](frontend.md)。
