# 手机 UI 层（Android 1 CSS px = 1 dp）

> 结论：Android 手机宿主以 `initial-scale=1` 把页面按 1 CSS px = 1 dp 布局，渲染层用 `phoneUI()` 判定后给 `body` 挂 `qp-phone`；dp 尺寸体系、底部动作菜单、通用 sheet、手机商城和触摸手势全部只在该作用域生效，桌面、平板和旧壳继续走原有桌面布局。当前高频交互面已完成重排，宽像素画面板仍是整体缩放兜底，社区 SWF 建议在手机菜单中隐藏入口。

代码位置约定：`main.ts` = `src/renderer/main.ts`，`input.ts` = `src/renderer/pet/input.ts`，`sizing.ts`/`sheet.ts`/`phone-menu*.ts`/`phone-shop*.ts`/`mobile.css`/`menu-phone.css`/`phone-shop.css` = `src/renderer/ui/mobile/` 下同名文件，`phone-panels.css` = `src/renderer/ui/css/phone-panels.css`，`box.ts`/`menu.ts`/`control.ts`/`state.ts`/`shop.ts` = `src/renderer/ui/` 下同名文件，`AssetClient.kt`/`PetService.kt` = `android/app/src/main/java/net/ankio/qqpet/` 下同名文件。

## 1. 设计空间与判定

### 1.1 宿主视口

`AssetClient` 在注入 `index.html` 前计算视口缩放（`android/app/src/main/java/net/ankio/qqpet/AssetClient.kt:72-79`）：

```text
scale = max(1, min(displayMetrics.widthPixels, heightPixels) / density / 480)
```

- 短边小于 480 dp 的手机：`scale = 1`，页面 `width=device-width`，1 CSS px = 1 dp。
- 短边不小于 480 dp 的平板：`scale = 短边dp / 480`，页面仍是 480 CSS px 设计空间，与旧版一致（常量 `VIEWPORT = 480` 在 `AssetClient.kt:17-18`）。
- 这是原生侧唯一决定设计空间的地方；页面不读 UA，也不假设宿主一定是 Android。

### 1.2 `phoneUI()` 判定

手机样式只在以下四条同时成立时启用（`src/renderer/ui/mobile/sizing.ts:20-31`）：

| 条件 | 代码事实 | 失败时的行为 |
| --- | --- | --- |
| 触摸指针 | `touch` 来自 `matchMedia('(pointer: coarse)')`（`src/renderer/ui/dom.ts:2`） | 桌面即使窗口很窄也不启用 |
| 屏幕短边 ≤ 600 dp | `Math.min(screen.width, screen.height) <= 600` | 平板保持桌面尺寸 |
| 页面没有缩放 | `visualViewport.scale` 与 1 相差 < 0.02 | 旧壳仍按 480 设计空间缩小，继续用桌面布局 |
| 页面确实按 dp 布局 | `documentElement.clientWidth` 与 `screen.width` 或 `screen.height` 相差 ≤ 2（`sizing.ts:14-17`） | 防止“窄但被缩放”的宿主误命中 |

判定通过后 `applyPhoneClass()` 给 `document.body` 切换 `qp-phone` 类（`sizing.ts:27-31`），启动时调用一次并在每次 `resize` 重新判定（`src/renderer/main.ts:31-35`），因此旋转和手机/平板边界切换会换布局。手机 surface 的样式以 `body.qp-phone` 为作用域；`mobile.css` 的 `.qp-sheet*` 是只在手机分支调用 `openSheet()` 时才出现的原语，桌面不会创建这些节点，因此桌面、平板和旧壳的布局不变。

### 1.3 实测基线

412×892 dp、dpr 2.625 的模拟器上：`innerWidth = 412`、`documentElement.clientWidth = 412`、`visualViewport.scale = 1`、`--safe-top = 24.03`；宠物盒 167.1 CSS px（物理尺寸与改造前一致，见 §2.3）。旧壳的同一页面是 `clientWidth = 480`、`scale = 0.857`，`phoneUI()` 不命中。

## 2. dp 尺寸体系

### 2.1 Token

`src/renderer/ui/mobile/mobile.css:6-24` 在 `body.qp-phone` 上定义：

| Token | 值 | 用途 |
| --- | --- | --- |
| `--qp-tap` | 48 px | 列表行、图标按钮、sheet 关闭键的最小触控目标 |
| `--qp-tap-sm` | 44 px | 密集区域下限：分页、步进、分段、聊天输入/发送 |
| `--qp-row` | 56 px | 动作菜单/列表行 |
| `--qp-font` / `--qp-font-sm` / `--qp-font-title` | 15 / 13 / 17 px | 正文 / 次要信息 / 面板标题 |
| `--qp-gap` | 12 px | 面板内间距 |
| `--safe-top/right/bottom/left` | 原生下发 | 系统栏与挖孔安全区，单位为 CSS px（= dp） |

### 2.2 各 surface 的实际落地尺寸

| Surface | 关键尺寸 | 样式位置 |
| --- | --- | --- |
| 手机菜单 | 底部全宽卡片；行 `min-height:56`、字号 15；子项 48；快捷瓦片 ≥72；头部头像 48 | `menu-phone.css:115-145,164-169,221-227` |
| 喂养/背包 sheet | 行 ≥64；图标 40；名称 15、说明 13；分页按钮 44 | `phone-panels.css:535-629` |
| 宠物状态 | 卡片 `min(360px, 92vw)`，字号 14；关闭/档案/开关 44 | `phone-panels.css:157-291` |
| 通用对话框 | `min(340px, 92vw)`、正文 15；主按钮 48、关闭 44、数量步进 44 | `phone-panels.css:41-155` |
| 聊天 | `92vw × 60vh`，正文 15；输入行 44、发送 88×44 | `phone-panels.css:293-336` |
| 设置 | `92vw × min(80vh, 760px)`；行 ≥48、控件 ≥44、tab ≥44 | `phone-panels.css:338-531` |
| 手机商城 | 顶部分段 48；分类 chip ≥64×44；两列卡片；商品图标 56、名称 15、价格 13；购买/步进 ≥44；背包行 64 | `phone-shop.css:32-199,226-245,289-317` |

### 2.3 不变量

- 手机模式下 1 CSS px 就是 1 dp，不再乘宿主缩放系数；新样式直接按手指尺寸写数值。
- 宠物盒尺寸不变：412 dp 手机上 167 dp，可见企鹅约 83×117 dp；本次只改手势和安全区位置（§3）。
- 手机 surface 的样式必须挂在 `body.qp-phone` 下；`mobile.css` 的 `.qp-sheet*` 是例外，它们只在 `openSheet()` 创建的节点上出现，桌面不会创建这些节点。

## 3. 交互模型

### 3.1 手势

`createPetInput()` 按同一次按下过程区分轻点、拖动和长按（`src/renderer/pet/input.ts`）：

| 手势 | 判据 | 动作 |
| --- | --- | --- |
| 轻点 | 未拖动、未长按、未取消，且按下到抬起 < 300 ms（`TAP_MAX_MS`，`input.ts:38`）；抬起在 `input.ts:57-62` 触发 `tap` | 手机打开底部动作菜单；桌面回调直接 return，行为不变 |
| 拖动 | 位移超过 8 px（`input.ts:99`） | 搬动宠物，松手不开菜单 |
| 长按 | 500 ms（`HOLD_MS`，`src/renderer/main.ts:81`） | 打开同一份菜单，兼容旧习惯 |
| 面部热点 | 原有 `.point` 点击（`src/renderer/ui/face.ts`） | 保留，轻点宠物不再弹浮动图标工具栏 |

手机上的组合回调在 `src/renderer/main.ts:297-325`：

- `begin` 在手机不再调用 `showControl()`（`main.ts:307`），浮动图标条是桌面专属入口。
- `tap` 只对手机生效，并延迟一个 task 再打开菜单（`main.ts:319-323`）；Android 在 `pointerup` 之后还会命中一次 `click`，同步弹面板会让该 click 落在刚出现的面板行上，延迟后 click 先落在宠物上。
- `hold` 仍然直接打开菜单；拖动/长按都不会重复触发轻点。

### 3.2 位置与安全区

`clampOnScreen()` 在手机模式把宠物纵坐标限制在 `[--safe-top, 视口高 - --safe-bottom - 宠物体积]`（`src/renderer/main.ts:88-97`），旋转、贴边和拖动释放路径同样调用该钳制（`main.ts:99-104,143-144`）。横向仍保持 `0..视口宽-体积`，没有按左右安全区钳制（见 §7）。

## 4. 手机菜单（底部动作面板）

`openMenu()` 在 `phoneUI()` 命中时转到 `openPhoneMenu()`（`src/renderer/ui/menu.ts:216-222`）；桌面、平板和旧壳仍走原来的 110 px 弹出菜单与原生托盘菜单，桌面分支没有改动。

`openPhoneMenu()`（`src/renderer/ui/mobile/phone-menu.ts:172-220`）复用 `openSheet()`，行为约定：

- 单实例：再次打开先关闭上一份（`phone-menu.ts:173-176`），不会叠多层。
- 内容来自 `menuItems(adopt)`；runtime 投影模式下菜单项本身没有“和我聊天”，手机层在“互动”组补一项（`phone-menu.ts:178-185`），不改共享的 `runtimeMenuItems()`。
- 分组由纯模型 `groupMenuItems()` 完成：互动 / 养成 / 设置 / 其他，危险项统一抽到最后的“危险操作”（`phone-menu-model.ts:41-84`），颜色由 `.qp-danger` 控制。
- 父项在当前面板内展开子项，不向侧面飞（`phone-menu-model.ts:104-126`；`phone-menu.ts:110-144`），子行 48 dp。
- 头部显示头像、昵称、等级和饥饿/清洁/心情三条微条，点击进宠物档案（`phone-menu.ts:81-100`）。
- 4 个快捷瓦片：喂养、清洁、吃药、逗它，每个 ≥72 dp（`phone-menu.ts:47-63`）。
- 点选条目先关 sheet 再执行 `item.run()`，并用 `fired` 防重入（`phone-menu.ts:188-194`）；关闭动画期间不会重复触发。
- 无宠物/已埋葬/已死亡时沿用 `menuItems()` 返回的受限项，不丢“领养/重新领养/退出宠物”等危险入口。

失败模式：

| 现象 | 原因 | 定位 |
| --- | --- | --- |
| 手机仍出现 110 px 弹出菜单（子菜单向侧面展开） | `phoneUI()` 未命中（旧壳仍 480、非触摸、平板） | `sizing.ts:20-24`；用 `probe.mjs eval` 读 `visualViewport.scale` 与 `clientWidth` |
| 点菜单项没有反应 | 条目没有 `run` 或已被 `fired` 拦截 | `phone-menu.ts:189-194`；检查 `menuItems()` 树 |
| 菜单行落点错位 | 轻点回调没有延迟，面板吃到随后的 click | `main.ts:319-323` |

## 5. 面板容器与各面板

### 5.1 通用 sheet

`src/renderer/ui/mobile/sheet.ts` 提供手机底部面板：

- 结构：遮罩 + 卡片 + 标题/关闭键 + 可滚动 body + 可选 footer；关闭键 48 dp（`sheet.ts:59-75`；`mobile.css:105-119`）。
- 关闭路径：右上 ✕、点击遮罩、向下拖动标题超过 `DISMISS_PX = 96`、Android 返回键（`sheet.ts:38-41,94-129,149-159`）。遮罩关闭要求同一次手势在遮罩上按下并抬起，拖拽越过卡片不会误关（`sheet.ts:95-103`）。
- 键盘：`fitVisible()` 用 `visualViewport` 的 `offsetTop/offsetLeft/width/height` 固定面板，并在 `resize`/`scroll` 时重算（`sheet.ts:134-147`），因此输入法收缩可视区时面板跟着上移；卡片底部再加 `--safe-bottom` 内边距（`sheet.ts:75`）。
- 返回键通道：所有手机模态共享 `src/renderer/ui/mobile/back.ts` 的栈。`pushBack(close)` 入栈时注册 `window.__qqpetBack`，该回调只关闭栈顶；第一层入栈时调用 `window.__qqpetSetBackHandler(true)` 与 `window.qqpet.setFocusable(true)`，最后一层释放时清空 `window.__qqpetBack`、调用 `setBackHandler(false)` 与 `setFocusable(false)`（`back.ts:13-39`）。sheet 在 `sheet.ts:149-151` 接入；box 框和宠物状态卡同样入栈（§5.2）。Android 原生的实现见 `docs/architecture/native-bridge.md` §4.2。
- 叠层：sheet 的 `z-index: 690`，低于 `.box`/`.modal`/`.ui-state` 的 700（`mobile.css:40-49`；`src/renderer/style.css:61-64,146-151`），所以 sheet 内再弹出的确认框/错误框在面板之上。
- 面板存在期间 `body.qp-sheet-open` 关闭宠物指针事件（`mobile.css:233-236`），宠物不会在遮罩下误响应。

### 5.2 通用框与面板

- `box.ts` 在手机给 frame 加 `qp-panel` 类，并通过 `onBackdrop` 支持“点遮罩关闭”，同时把 frame 注册进返回键栈（`src/renderer/ui/box.ts:58-71,186-199`）；`openFrame` 的遮罩关闭会先触发内容自带的关闭控件（`box.ts:242-260`）。
- `phone-panels.css` 只做尺寸与重排，不改变像素画素材：通用对话框、宠物状态、聊天、设置、喂养 sheet 的规则全部以 `body.qp-phone` 开头（`src/renderer/ui/css/phone-panels.css:9-17` 等）。
- 宠物状态在手机上居中于安全区，遮罩点击关闭（`src/renderer/ui/state.ts:294-314`；`phone-panels.css:162-172`），并注册返回键关闭（`state.ts:313-314`）；桌面仍按托盘点定位。
- 喂养/背包：`openGoods()` 在手机转到 `openPhoneGoods()`（`src/renderer/ui/control.ts:378-380`）。手机 sheet 每行一次点击直接 `useItem`，不再走“先预览再使用”的两段式；分页按钮 44 dp，“去购物”固定在 footer（`control.ts:104-189`）。
- 手机商城：`openShop()` 在手机转到 `openPhoneShop()`（`src/renderer/ui/shop.ts:127-132`）。面板含“商店/我的”分段、分类 chip、两列商品卡、卡片内 1..99 数量步进、确认购买和背包直接使用（`src/renderer/ui/mobile/phone-shop.ts:83-356`）。购买前用 `purchaseProblem()` 给出等级/粉钻/元宝不足的可见原因（`phone-shop-model.ts:166-196`），确认后 runtime 模式走 `buyRuntime()`，否则 `buy()`（`phone-shop.ts:319-334`）；失败也有 toast，不静默。
- 背包里属性/药品类物品会先关 sheet 再调用 `useItem`，让共享的确认框显示在面板之外（`phone-shop.ts:305-317`）。

失败模式：

| 现象 | 原因 | 定位 |
| --- | --- | --- |
| 面板被键盘挡住 | 宿主不更新 `visualViewport`，或页面用了布局视口定位 | `sheet.ts:134-147`；用 `probe.mjs eval` 读 `visualViewport.height` |
| 面板内按钮在桌面上变大 | 选择器漏了 `body.qp-phone` 前缀 | `scripts/tests/phone-panels-css.test.mjs` 会失败 |
| 商城买不到但无提示 | `buy()` 返回 false 被忽略 | `phone-shop.ts:319-334`；检查 toast 分支 |
| 返回键关错层 | 栈不是后进先出，或旧壳没有 `setBackHandler` | `back.ts:13-39`、`sheet.ts:149-159`；`src/android/bridge.ts:61-63` |

## 6. 逐界面适配状态

### 6.1 已重排并实测

| 界面 | 当前实现 | 关键数字（412×892 dp） |
| --- | --- | --- |
| 手机菜单 | 底部动作面板、分组、行内展开 | 行 56 / 字号 15 / 子项 48；25 个目标全部 ≥44 |
| 快捷操作 | 菜单内 4 个瓦片 | 每个 ≥72；替代浮动图标条 |
| 喂养/背包 | 底部 sheet、一次点击使用 | 行 64–95 / 图标 40 / 名称 15 / 分页 44 |
| 宠物状态 | 居中卡片 + 遮罩 | 宽 360 / 字号 14 / 关闭 44 |
| 通用对话框 | 重排为纵向卡片 | 340×236 / 正文 15 / 主按钮 48 / 步进 44 |
| 聊天 | 92vw × 60vh | 379×535 / 15 / 输入 44 / 发送 88×44 |
| 设置 | 92vw + 单列 | 379×714 / 行 48 / 控件 44 |
| 商城 | 手机专属 sheet | 全宽 / 21 个目标 ≥44 / 两列卡片 / 数量 1..99 |
| 密室 | 手柄浮在舞台内 | 舞台 380×285 / 按键 64 / 工具 44 |
| 小游戏退出 | 常显 | 44×44 |

宠物本体：盒 167 dp、可见约 83×117 dp，尺寸未变；轻点开菜单、拖动移位、长按兼容，纵坐标避开状态栏（§3）。

### 6.2 仍是整体缩放兜底

`box.ts` 的 `flat = min(1, room.w / 内容宽, room.h / 内容高)`（`src/renderer/ui/box.ts:98-100`）只缩不放。以下固定画布在手机上仍会被整体缩小，文字和按钮低于可读/可点阈值：

| 界面 | 手机上的缩放/结果 | 迁移方向 |
| --- | --- | --- |
| 农场 | 约 0.56，正文落到约 6.7 dp | 地块改可滚动网格 + 底部操作条 |
| 钓鱼 | 舞台接近可用，按钮偏小 | 保留舞台，操作条改 44 dp 底部条 |
| 岛屿 | 约 0.79 | 列表化：56 dp 行 + 详情面板 |
| 签到 | 约 0.53，日历格约 12 dp | 7 列自适应 + 44 dp 格 |
| 游戏大厅 | 约 0.58（`zoom:1.25` 后仍偏小） | 两列游戏卡 + 44 dp 进入按钮 |
| 社区 | 约 0.49，按钮随 SWF 缩 | 只能改 SWF 或做原生替代；短期在手机菜单隐藏入口 |
| 宠物档案/考试/邮箱/任务/旅行/相册 | 0.62–0.90 | 统一走 sheet 容器 + 行重排 |

共性做法：像素画舞台保留，列表/表单重排；确实只能缩放的社区 SWF 宁可在手机上隐藏入口，也不把 5.9 dp 文字硬塞给用户。

## 7. 已知限制与迁移顺序

### 7.1 已知限制

- Android 返回键只在包含 `setBackHandler` 的新壳上生效；旧 APK + 新页面时 `window.__qqpetSetBackHandler` 是 no-op，面板仍可点遮罩、✕ 或下滑关闭，但返回键退回原行为（`src/android/bridge.ts:61-63,98-101`；`back.ts:13-23`）。
- 宠物横向未按 `--safe-*` 的左右值钳制；本次只实测了 `--safe-top`（24.03），横屏/挖孔设备的左右与底部安全区未验证（`main.ts:94`）。
- 平板继续使用 480 CSS px 设计空间，手机样式不会命中；平板未在本次验证范围内。
- 判定不区分宿主：iOS/HarmonyOS 只有在页面本来就按 1 CSS px = 1 pt/dp 布局时才会命中 `phoneUI()`，未在真机验证。
- 键盘避让依赖 `visualViewport` 真正收缩；宿主若不回报，sheet 只能按布局视口贴合，无法保证输入框始终可见。
- 社区、农场、钓鱼、岛屿、签到、游戏大厅等 SWF/固定像素画布仍不可用 CSS 重排内部控件（§6.2）。
- runtime 菜单没有“和我聊天”，手机菜单在“互动”组补了一行；桌面 runtime 菜单未改（`phone-menu.ts:178-185`）。

### 7.2 迁移顺序

1. **先做列表/表单类**：任务、签到、邮箱、岛屿、宠物档案、考试、旅行、相册。这些有稳定的 DOM 结构，按 `openSheet` + `qp-row` 重排成 56 dp 行、44 dp 控件，收益最大、风险最低。
2. **再做舞台类**：农场、钓鱼、游戏大厅。保留像素舞台，把操作按钮移出画布为底部 44 dp 操作条，避免 `flat` 把控件一起缩小。
3. **社区 SWF 最后处理**：在手机菜单隐藏入口并标注“桌面可用”，或者替换为原生界面；不要继续依赖整体缩放。
4. **再验证平板与其它移动宿主**：只有确认页面按 1:1 布局后才允许命中 `phoneUI()`；桌面回归始终跑 `npm run typecheck` 与 `npm run test:compat`。

## 8. 验证命令

预期退出码均为 `0`；非 `0` 即视为该项失败。

```bash
# 类型边界（桥接、渲染层、手机模块）
npm run typecheck

# 全量行为测试（含手机手势、菜单、面板 CSS、商城模型）
npm run test:compat

# 手机层单测
node --experimental-strip-types --test scripts/tests/pet-tap.test.mjs scripts/tests/pet-drag.test.mjs
node --experimental-strip-types --test scripts/tests/phone-menu.test.mjs scripts/tests/phone-shop.test.mjs scripts/tests/phone-panels-css.test.mjs

# 文档门禁
npm run test:docs
npm run check:docs
```

Android 尺寸与触摸验证（模拟器按 1080×2340、density 420 配置，即 412×892 dp、dpr 2.625）：

```bash
npm run build:android-web
cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am force-stop net.ankio.qqpet
adb shell am start -n net.ankio.qqpet/.MainActivity
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof net.ankio.qqpet)

# 设计空间与手机判定
node tmp/mobile/probe.mjs eval '({w:innerWidth,client:document.documentElement.clientWidth,scale:visualViewport.scale,dpr:devicePixelRatio,phone:document.body.classList.contains("qp-phone")})'
# 遍历可点元素：输出 viewport、overflowX、small/smallCount、每个目标的 w/h/font
node tmp/mobile/probe.mjs measure
# 真实触摸（页面坐标，单位 dp）
node tmp/mobile/probe.mjs tap 206 700
node tmp/mobile/probe.mjs swipe 206 700 300 600 400
# 截图
node tmp/mobile/probe.mjs shot menu
# 也可以用 adb 直接触摸设备坐标
adb shell input tap 540 1800
adb shell input swipe 900 1800 300 1800 400
```

通过标准：`phone` 为 `true`、`innerWidth` 与 `clientWidth` 都等于 412、`scale` 接近 1；菜单行高 ≥56、正文 ≥15；面板/商城可点元素短边 ≥44、无横向溢出；轻点宠物开面板、拖动移位、长按仍开面板；商城能完成一次真实购买且背包数量变化。

## 9. 变更影响

- **新增手机 surface**：复用 `openSheet()` 与 `qp-*` 基础类，CSS 必须以 `body.qp-phone` 作用域；同步补 `scripts/tests/phone-*.test.mjs` 的纯模型/作用域断言。
- **改 `phoneUI()` 阈值或判定**：会影响所有手机样式是否启用，必须同时验证旧壳（仍 480）、平板（≥600 dp 短边）和桌面（无 coarse 指针），并更新本文 §1。
- **改 `AssetClient` 视口缩放**：同时影响 `innerWidth`、`setBounds` 的 `viewport` 换算、`--safe-*` 数值和宠物尺寸归一化；必须重跑 `npm run build:android-web` 与 §8 的真机测量。
- **改 `setBackHandler`/`__qqpetBack` 契约**：必须同步 `src/android/bridge.ts`、`PetService.kt`、`src/renderer/global.d.ts` 与 `docs/architecture/native-bridge.md` §4.2；漏一端会让返回键静默失效。
- **改 `box.ts` 的 `flat` 缩放或面板内容宽度**：会同时影响所有宽面板手机兜底效果和桌面窗口；按 §6.2 的迁移顺序逐个替换，不要靠调 `flat` 掩盖。
- **桌面回归**：手机 surface 规则都以 `body.qp-phone` 为作用域（base sheet 原语只在手机分支创建），桌面/平板应保持原样；改动后跑 `npm run typecheck` 与 `npm run test:compat`，并在桌面上打开菜单、状态、设置、商城确认布局未变。

## 10. 代码位置到文档的映射

| 代码位置 | 同步文档 |
| --- | --- |
| `src/renderer/ui/mobile/**`、`src/renderer/ui/css/phone-panels.css` | 本文 |
| Android 视口与返回键（`AssetClient.kt`、`PetService.kt`、`src/android/bridge.ts`） | 本文 §1、§5.1 与 [原生桥](native-bridge.md) §4.2 |
| 手机分支接入点（`src/renderer/main.ts`、`src/renderer/pet/input.ts`、`src/renderer/ui/menu.ts`、`src/renderer/ui/runtime-menu.ts`、`src/renderer/ui/box.ts`、`src/renderer/ui/control.ts`、`src/renderer/ui/state.ts`、`src/renderer/ui/shop.ts`） | 本文对应小节；桌面契约仍以 [桌面 IPC 与 preload](desktop-ipc-and-preload.md) 为准 |
