# 手机 UI 层（Android 1 CSS px = 1 dp）

> 结论：Android 手机宿主以 `initial-scale=1` 把页面按 1 CSS px = 1 dp 布局，渲染层用 `phoneUI()` 判定后给 `body` 挂 `qp-phone`；dp 尺寸体系、底部动作菜单、通用 sheet、手机商城和触摸手势全部只在该作用域生效，桌面、平板和旧壳继续走原有桌面布局。本轮把适配面从 7 个扩到全页面：42 个交互面复核后，领养、游戏大厅、签到、任务、农场、企鹅岛、旅行、相册、邮箱、宠物档案、考试与结果弹窗都改为 dp 重排（sheet、行、≥44 dp 目标），手机菜单补齐工具/互动入口与玩具瓦片；`box.ts` 的 frame 保持自然宽度，宽画布只在确实无法重排时才整体缩放。明确剩余缺口是社区 SWF（建议隐藏入口）、密室（入口与手柄遮挡）、钓鱼 SWF 内部控件未验证、平板与 iOS 未真机回归。

代码位置约定：`main.ts` = `src/renderer/main.ts`，`input.ts` = `src/renderer/pet/input.ts`，`sizing.ts`/`sheet.ts`/`back.ts`/`phone-menu*.ts`/`phone-shop*.ts`/`phone-games*.ts`/`phone-signin.ts`/`phone-task.ts`/`phone-email.ts`/`phone-petinfo.ts`/`phone-pages-model.ts`/`mobile.css`/`menu-phone.css`/`phone-shop.css`/`phone-games.css` = `src/renderer/ui/mobile/` 下同名文件，`phone-panels.css`/`phone-pages.css` = `src/renderer/ui/css/` 下同名文件，`box.ts`/`menu.ts`/`control.ts`/`state.ts`/`shop.ts`/`adopt.ts`/`farm.ts`/`travel.ts`/`album.ts`/`signin.ts`/`task.ts`/`email.ts`/`petinfo.ts`/`games.ts`/`island-runtime.ts` = `src/renderer/ui/` 下同名文件，`AssetClient.kt`/`PetService.kt` = `android/app/src/main/java/net/ankio/qqpet/` 下同名文件。

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

手机样式只在以下四条同时成立时启用（`sizing.ts:20-29`）：

| 条件 | 代码事实 | 失败时的行为 |
| --- | --- | --- |
| 触摸指针 | `touch` 来自 `matchMedia('(pointer: coarse)')`（`src/renderer/ui/dom.ts:2`） | 桌面即使窗口很窄也不启用 |
| 屏幕短边 ≤ 600 dp | `Math.min(screen.width, screen.height) <= 600`（`PHONE_MAX`，`sizing.ts:11`） | 平板保持桌面尺寸 |
| 页面没有缩放 | `visualViewport.scale` 与 1 相差 < 0.02（`sizing.ts:26`） | 旧壳仍按 480 设计空间缩小，继续用桌面布局 |
| 页面确实按 dp 布局 | `documentElement.clientWidth` 与 `screen.width` 或 `screen.height` 相差 ≤ 2（`sizing.ts:14-19`） | 防止“窄但被缩放”的宿主误命中 |

判定通过后 `applyPhoneClass()` 给 `document.body` 切换 `qp-phone` 类（`sizing.ts:32-36`），启动时调用一次并在每次 `resize` 重新判定（`main.ts:27-36`），因此旋转和手机/平板边界切换会换布局。手机 surface 的样式以 `body.qp-phone` 为作用域；`mobile.css` 的 `.qp-sheet*` 只在手机分支调用 `openSheet()` 时出现，桌面不会创建这些节点，因此桌面、平板和旧壳的布局不变。

### 1.3 实测基线

412×892 dp、dpr 2.625 的模拟器上：`innerWidth = 412`、`documentElement.clientWidth = 412`、`visualViewport.scale = 1`、`--safe-top = 24.03`；宠物盒 167.1 CSS px（物理尺寸与改造前一致，见 §2.3）。旧壳的同一页面是 `clientWidth = 480`、`scale = 0.857`，`phoneUI()` 不命中。

## 2. dp 尺寸体系

### 2.1 Token

`mobile.css:6-24` 在 `body.qp-phone` 上定义：

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
| 手机菜单 | 底部全宽卡片（上限 560）；行 `min-height:56`、字号 15；子项 48；5 个快捷瓦片高 ≥72、宽 ≥48；头部头像 48 | `menu-phone.css:9-18,116-145,164-169` |
| 喂养/背包 sheet | 行 ≥64；图标 40；名称 15、说明 13；分页按钮 44 | `phone-panels.css:537-645` |
| 宠物状态 | 卡片 `min(360px, 92vw)`，字号 14；关闭/档案/开关 44；数值条 seeNum 13 带描边 | `phone-panels.css:155-289,562-575` |
| 通用对话框 | `min(340px, 92vw)`、正文 15；主按钮 48、关闭 44、数量步进 44 | `phone-panels.css:39-153` |
| 聊天 | `92vw × 60vh`，正文 15；输入行 44、发送 88×44 | `phone-panels.css:291-334` |
| 设置 | `92vw × min(80vh, 760px)`；行 ≥48、控件 ≥44、tab ≥44（手机换行，不藏标签） | `phone-panels.css:336-535` |
| 手机商城 | 顶部分段 48；分类 chip ≥64×44（手机换行）；两列卡片；商品图标 56、名称 15、价格 13；购买/步进 ≥44；背包行 64 | `phone-shop.css:32-199,226-245,289-317` |
| 签到/任务/邮箱/档案 | 主操作 56、行 64、分页/领取/删除 ≥44；月历 7 列、格子 ≥44；档案头像 96、输入与保存 44 | `phone-pages.css:59-985` |
| 游戏大厅/企鹅岛 | 游戏行 64、开始键 44、chip 44；岛屿行 56、按钮 44、页脚三列 | `phone-games.css`、`phone-pages.css:987-1111` |
| 领养/农场/旅行/相册/考试/结果 | 见 §5.4；选择键 56、地块 ≥72、tab 44、结果确定 48 | `phone-panels.css:647-837` |

### 2.3 不变量

- 手机模式下 1 CSS px 就是 1 dp，不再乘宿主缩放系数；新样式直接按手指尺寸写数值。
- 宠物盒尺寸不变：412 dp 手机上 167 dp，可见企鹅约 83×117 dp；本次只改手势和安全区位置（§3）。
- 手机 surface 的样式必须挂在 `body.qp-phone` 下；`mobile.css` 的 `.qp-sheet*` 是例外，它们只在 `openSheet()` 创建的节点上出现，桌面不会创建这些节点。

## 3. 交互模型

### 3.1 手势

`createPetInput()` 按同一次按下过程区分轻点、拖动和长按（`input.ts`）：

| 手势 | 判据 | 动作 |
| --- | --- | --- |
| 轻点 | 未拖动、未长按、未取消，且按下到抬起 < 300 ms（`TAP_MAX_MS`，`input.ts:38`）；抬起在 `input.ts:57-62` 触发 `tap` | 手机打开底部动作菜单；桌面回调直接 return，行为不变 |
| 拖动 | 位移超过 8 px（`input.ts:99`） | 搬动宠物，松手不开菜单 |
| 长按 | 500 ms（`HOLD_MS`，`main.ts:81`） | 打开同一份菜单，兼容旧习惯 |
| 面部热点 | 原有 `.point` 点击（`src/renderer/ui/face.ts`） | 保留，轻点宠物不再弹浮动图标工具栏 |

手机上的组合回调在 `main.ts:316-337`：

- `begin` 在手机不再调用 `showControl()`（`main.ts:320`），浮动图标条是桌面专属入口。
- `tap` 只对手机生效，并延迟一个 task 再打开菜单（`main.ts:332-337`）；Android 在 `pointerup` 之后还会命中一次 `click`，同步弹面板会让该 click 落在刚出现的面板行上，延迟后 click 先落在宠物上。
- `hold` 仍然直接打开菜单（`main.ts:327`）；拖动/长按都不会重复触发轻点。

### 3.2 位置与安全区

`clampOnScreen()` 在手机模式把宠物纵坐标限制在 `[--safe-top, 视口高 - --safe-bottom - 宠物体积]`（`main.ts:88-104`），旋转、贴边和拖动释放路径同样调用该钳制（`main.ts:115,129,144`）。横向仍保持 `0..视口宽-体积`，没有按左右安全区钳制（见 §7）。

## 4. 手机菜单（底部动作面板）

`openMenu()` 在 `phoneUI()` 命中时转到 `openPhoneMenu()`（`menu.ts:226-229`）；桌面、平板和旧壳仍走原来的 110 px 弹出菜单与原生托盘菜单，桌面分支没有改动。

`openPhoneMenu()`（`phone-menu.ts:212-261`）复用 `openSheet()`，行为约定：

- 单实例：再次打开先关闭上一份（`phone-menu.ts:215-216`），不会叠多层。
- 内容来自 `menuItems(adopt)`；runtime 投影模式下菜单项本身没有“和我聊天”，手机层在“互动”组补一项（`phone-menu.ts:221-225`），不改共享的 `runtimeMenuItems()`。
- 分组由纯模型 `groupMenuItems()` 完成：互动 / 工具 / 养成 / 设置 / 其他，危险项统一抽到最后的“危险操作”（`phone-menu-model.ts:41-84`），颜色由 `.qp-danger` 控制。
- 父项在当前面板内展开子项，不向侧面飞（`phone-menu-model.ts:104-126`；`phone-menu.ts:118-152`），子行 48 dp。
- 头部显示头像、昵称、等级和饥饿/清洁/心情三条微条，点击进宠物档案（`phone-menu.ts:88-108`）。
- 5 个快捷瓦片：喂养、清洁、吃药、逗它、玩具，高 ≥72 dp、宽 ≥48 dp（412 dp 上约 68），5 列排布（`phone-menu.ts:47-71`；`menu-phone.css:116-145`）。
- 点选条目先关 sheet 再执行 `item.run()`，并用 `fired` 防重入（`phone-menu.ts:229-235`）；关闭动画期间不会重复触发。
- 无宠物/已埋葬/已死亡时沿用 `menuItems()` 返回的受限项，不丢“领养/重新领养/退出宠物”等危险入口。

失败模式：

| 现象 | 原因 | 定位 |
| --- | --- | --- |
| 手机仍出现 110 px 弹出菜单（子菜单向侧面展开） | `phoneUI()` 未命中（旧壳仍 480、非触摸、平板） | `sizing.ts:20-29`；用 `probe.mjs eval` 读 `visualViewport.scale` 与 `clientWidth` |
| 点菜单项没有反应 | 条目没有 `run` 或已被 `fired` 拦截 | `phone-menu.ts:230-235`；检查 `menuItems()` 树 |
| 菜单行落点错位 | 轻点回调没有延迟，面板吃到随后的 click | `main.ts:332-337` |
| 某功能在手机上找不到 | 只加了桌面菜单项，没加到 `phoneEntries()`/`SHORTCUTS` | §4.1；`phone-menu.ts:183-205,54-60` |

### 4.1 入口对等（删入口必须同时补入口）

v0.10.0 把手机入口从浮动图标工具栏换成底部菜单后，`main.ts:320` 在手机不再调用 `showControl()`，工具栏 `MENU`（`control.ts:231-282`）里的条目不会自动迁移；runtime 桌面菜单本身也只有商城/喂养/状态/活动/设置/档案。手机补丁全部集中在 `phone-menu.ts`，按组补齐：

| 组 | 入口 | 实现 |
| --- | --- | --- |
| 工具 | 邮箱、任务、签到 | `phoneEntries()`（`phone-menu.ts:186-188`）→ `openEmail`/`openTask`/`openSignIn` |
| 互动 | 打工、学习、旅游、看病 | `phoneEntries()`（`phone-menu.ts:191-194`）→ `openWorkPanel`/`openStudyPanel`/`openTravel`/`doctor` |
| 互动（runtime 追加） | 休息一下、去朋友家送信 | `phoneEntries(runtime)`（`phone-menu.ts:198-203`）→ `restNow`/`sendLetter` |
| 快捷操作 | 玩具（第 5 个瓦片） | `SHORTCUTS`（`phone-menu.ts:54-60`）→ `openGoods('toy')` |

打工/学习不复制业务逻辑：`openWorkPanel()` 与 `openStudyPanel()` 在 `control.ts:218-228` 判断手机后走 `openPhonePanel()`，复用工具栏的 `WORK_PANEL`/`STUDY_PANEL` 数据和 `openGoods` 同款 sheet；桌面分支仍 `showControl()` + `openPanel()`。

**约束：删入口必须同时补入口。** 任何让手机失去工具栏或菜单项的改动——`main.ts:320` 的 `!phoneMode()`、runtime 菜单过滤、菜单重构——都必须在同一次改动里给 `phoneEntries()` 或 `SHORTCUTS` 补等价入口，并在 `scripts/tests/phone-menu.test.mjs` 断言标签和所属组（该测试已逐项覆盖工具/互动/玩具）。`runtimeMenuItems()` 是桌面运行时树，保持原样，手机补丁只加在 `phone-menu.ts`；桌面 runtime 没有的“和我聊天”同样只在手机层补（`phone-menu.ts:222-224`）。反例：v0.10.0 把 110 px 弹出菜单换成底部面板时只删了入口没补入口，工具栏那批功能在手机上集体失联。

## 5. 面板容器与各面板

### 5.1 通用 sheet

`sheet.ts` 提供手机底部面板：

- 结构：遮罩 + 卡片 + 标题/关闭键 + 可滚动 body + 可选 footer；关闭键 48 dp（`sheet.ts:59-75`；`mobile.css:110-123`）。
- 关闭路径：右上 ✕、点击遮罩、向下拖动标题超过 `DISMISS_PX = 96`、Android 返回键（`sheet.ts:38-41,94-129,151-159`）。遮罩关闭要求同一次手势在遮罩上按下并抬起，拖拽越过卡片不会误关（`sheet.ts:95-103`）。
- `close()` 是唯一出口：它把 sheet 从栈里移除、播关闭动画，并在 180 ms 后调用一次 `onClose`（`sheet.ts:39,81-92`）；✕、遮罩、下滑和返回键都汇到 `close()`。
- 键盘：`fitVisible()` 用 `visualViewport` 的 `offsetTop/offsetLeft/width/height` 固定面板，并在 `resize`/`scroll` 时重算（`sheet.ts:136-147`），因此输入法收缩可视区时面板跟着上移；卡片底部再加 `--safe-bottom` 内边距（`sheet.ts:75`）。
- 返回键通道：所有手机模态共享 `back.ts` 的栈。`pushBack(close)` 入栈时注册 `window.__qqpetBack`，该回调只关闭栈顶；第一层入栈时调用 `window.__qqpetSetBackHandler(true)` 与 `window.qqpet.setFocusable(true)`，最后一层释放时清空 `window.__qqpetBack`、调用 `setBackHandler(false)` 与 `setFocusable(false)`（`back.ts:13-39`）。sheet 在 `sheet.ts:151` 接入；box 框和宠物状态卡同样入栈（§5.2、§5.3）。
- 叠层：sheet 的 `z-index: 690`，低于 `.box`/`.modal`/`.ui-state` 的 700（`mobile.css:40-49`；`src/renderer/style.css:64,151`），所以 sheet 内再弹出的确认框/错误框在面板之上。
- 面板存在期间 `body.qp-sheet-open` 关闭宠物指针事件（`mobile.css:239-241`），宠物不会在遮罩下误响应。

### 5.2 通用框与面板

- `box.ts` 在手机给 frame 加 `qp-panel` 类（`box.ts:61-62`），并通过 `onBackdrop` 支持“点遮罩关闭”（`box.ts:67-71`）；`openBox` 把返回键注册到自己的 `close()`（`box.ts:235`），`openFrame` 的遮罩关闭与返回键共用 `dismiss()`，先触发内容自带的关闭控件，没有控件才 `stop()`（`box.ts:256-266`）。
- `phone-panels.css` 只做尺寸与重排，不改变像素画素材：通用对话框、宠物状态、聊天、设置、喂养 sheet 的规则全部以 `body.qp-phone` 开头（`phone-panels.css:1-18` 等）。
- 宠物状态在手机上居中于安全区，遮罩点击关闭（`state.ts:306-315`），并注册返回键关闭（`state.ts:315`）；桌面仍按托盘点定位。
- 喂养/背包：`openGoods()` 在手机转到 `openPhoneGoods()`（`control.ts:418-421`）。手机 sheet 每行一次点击直接 `useItem`，不再走“先预览再使用”的两段式；分页按钮 44 dp，“去购物”固定在 footer（`control.ts:124-212`）。
- 手机商城：`openShop()` 在手机转到 `openPhoneShop()`（`shop.ts:128-133`）。面板含“商店/我的”分段、分类 chip、两列商品卡、卡片内 1..99 数量步进、确认购买和背包直接使用（`phone-shop.ts:83-356`）。购买前用 `purchaseProblem()` 给出等级/粉钻/元宝不足的可见原因（`phone-shop-model.ts:182-196`），确认后 runtime 模式走 `buyRuntime()`，否则 `buy()`（`phone-shop.ts:319-334`）；失败也有 toast，不静默。
- 背包里属性/药品类物品会先关 sheet 再调用 `useItem`，让共享的确认框显示在面板之外（`phone-shop.ts:305-317`）。

失败模式：

| 现象 | 原因 | 定位 |
| --- | --- | --- |
| 面板被键盘挡住 | 宿主不更新 `visualViewport`，或页面用了布局视口定位 | `sheet.ts:136-147`；用 `probe.mjs eval` 读 `visualViewport.height` |
| 面板内按钮在桌面上变大 | 选择器漏了 `body.qp-phone` 前缀 | `scripts/tests/phone-panels-css.test.mjs` 会失败 |
| 商城买不到但无提示 | `buy()` 返回 false 被忽略 | `phone-shop.ts:319-334`；检查 toast 分支 |
| 返回键关错层 | 栈不是后进先出，或旧壳没有 `setBackHandler` | `back.ts:13-39`、`sheet.ts:151`；`src/android/bridge.ts:61-63` |
| 面板关掉后第二次打不开 | `onClose` 没执行，模块级 `open` 闩锁仍为 true | §5.3 契约 2；检查返回键是否走了 `close()` |

### 5.3 box 适配契约

这两条是本轮踩到的真实回归，新增或修改 box 面板时必须同时满足。

**契约 1：frame 保持自然宽度，不能给 `.qp-panel`/`.boxFrame` 加 `max-width`（或 `width: calc(100vw - …)`）。** `box.ts` 的 `refit()` 用 `frame.offsetWidth/offsetHeight` 量内容尺寸（`box.ts:94-95`），再算 `flat = min(1, room.w / w, room.h / h)`（`box.ts:99-101`）。给 frame 限宽后 `w <= room.w`，`flat` 恒为 1，宽画布不再缩小，而是按原尺寸向右溢出并被 `html,body{overflow:hidden}` 裁掉。v0.10.0 的 `body.qp-phone .qp-panel { max-width: calc(100vw - 2 * var(--qp-panel-pad)) }`（旧 `phone-panels.css:17-19`）就是这样把“缩放兜底”变成“右侧裁切”：领养只露 65%、「导入存档」在 x=539–615 屏外；游戏大厅 675 宽只露 56%、9/28 个游戏不可见；农场丢 320 dp、社区丢 420 dp、签到日历右栏 x≈546 出屏（`tmp/reports/mobile-ui/05-review-a.md` §0、`05-review-b.md` §0.1、`05-review-c.md` §1 三份复核独立复现）。该规则已从工作区删除，原位只留说明（`phone-panels.css:13-18`）；需要窄的面板应重排内容（§5.4），而不是限制 frame。sheet 卡片允许上限宽（`.qp-sheet-card` 的 `max-width:560px`，`mobile.css:56-67`），因为 sheet 不经过 `box.ts` 的 `flat`。

**契约 2：返回键必须走每个面板自己的 close 路径，不能只移除 DOM。** 返回键栈的栈顶回调只负责“关闭最上层”，具体入口必须是会执行 `onClose`/清理的那个函数：

- `openBox`：`pushBack(close)` 注册在 `close()` 里（`box.ts:227-237`），而 `close()` 在移除 DOM 前调用 `opts.onClose`；✕（`box.ts:236`）、遮罩（`box.ts:58-71`）和返回键因此走同一条路径。
- `openFrame`：遮罩关闭和返回键共用 `dismiss()`，先点内容自带的 `.sclose`/`.windowViewBut`（`box.ts:256-262`），没有关闭控件才走 `stop()`（`box.ts:263-266`）。因此有自带关闭控件的面板会执行清理；没有控件的 `openFrame` 面板仍只移除 DOM（钓鱼/密室，见 §7.1）。
- `openSheet`：`pushBack(close)`（`sheet.ts:151`），`close()` 在动画后调用 `onClose`（`sheet.ts:81-92`）。

为什么必须这样：领养、农场、旅行、企鹅岛等模块用模块级 `open` 闩锁防重复打开，并在 `onClose` 里把它置回 false（`adopt.ts:10,67`；`farm.ts:193-199`；`travel.ts:144`；`island-runtime.ts:362-381`）。如果返回键只执行 `remove()` 而不进 `close()`，`onClose` 不跑，`open` 永远是 true，第二次打开会在 `if (open) return` 处静默失效（面板不出现也不报错）。v0.10.0 的 `box.ts` 正是把返回键挂在 `show()` 内部的 `remove()` 上，本轮已把 `pushBack` 移进 `openBox.close()` 修复。新面板必须在 `onClose` 里释放所有观察者/定时器/闩锁，并用 `openBox` 或 `openSheet` 承载；`openFrame` 面板要么没有闩锁，要么提供 `.sclose`/`.windowViewBut` 关闭控件，否则返回键会走 `stop()`，清理不执行。

### 5.4 本轮新增的手机面

| 面 | 手机分支与布局 | 关键尺寸 | 样式/入口 |
| --- | --- | --- | --- |
| 领养 | `adopt.ts:52-70`：4:3 SWF 立绘 + 整行「导入存档」+ footer 两个选择键；`ChooseSex(0/1)` 与原 `commit` 映射一致，`onClose` 释放 `open` | 选择键 56，导入行 48 | `phone-panels.css:649-677`；`adopt.ts:71-74` 仍只 `openBox` 桌面 |
| 签到 | `signin.ts:88` → `phone-signin.ts:66`：今日状态 + 56 dp 主按钮、7 列月历、图鉴 chips、两列卡 | 日格 ≥44、主操作 56、行 64、目标 ≥44 | `phone-pages.css:59-352` |
| 任务 | `task.ts:13-14` → `phone-task.ts:34`：tab chips、可领取优先、每任务一行 | 行 64、领取 96×44、字号 15/13 | `phone-pages.css:354-485` |
| 邮箱 | `email.ts:25-26` → `phone-email.ts:50`：邮件行 + 详情滚动 + 领取/删除/翻页/一键操作 | 行 64、操作 44–48、字号 15/13/12 | `phone-pages.css:487-739` |
| 宠物档案 | `petinfo.ts:64` → `phone-petinfo.ts:86`：头像/昵称/等级、44 dp 改名行、两列数值网格、成就与状态 | 头像 96、输入/保存 44、字号 15/13 | `phone-pages.css:741-985` |
| 农场 | `farm.ts:193-199`：runtime 面板走 sheet，六列地块改两列；种子/化肥/操作按钮保留同一套 `uiCommands` | 地块 ≥72、chip/按钮 44、正文 13–15 | `phone-panels.css:679-710` |
| 旅行 | `travel.ts:144`：地图/相簿两 tab 走 sheet，地图按 sheet 宽自适应；相簿沿用 `albumView()` | tab 44、主按钮 48、省名 13 | `phone-panels.css:712-756` |
| 相册/相片 | `album.ts:20`：单张相片走 sheet，`object-fit:contain`；相册仍用同一 `shots()` 数据 | 照片按 sheet 宽 contain、说明 12、相册 2 列 | `phone-panels.css:757-783` |
| 考试 | 不新增 DOM：300 px 卡片原本完整可见，只放大目标；选项美术 24 dp + `::after` 外扩 12 dp 形成 44 dp 热区 | 选项 24 dp 视觉 + 外扩 12 dp、退出 64×26 + 外扩 12 dp | `phone-panels.css:784-821` |
| 结果弹窗 | `result.ts:20-31` 的 `.markFull` 覆盖宿主；手机把「确定」抬到 48 dp、正文 14–15、宽度 92vw，sheet 内结果再走 sheet 专属规则 | 确定 48、宽 92vw | `phone-panels.css:823-837`；`phone-pages.css:31-57` |
| 游戏大厅 | `games.ts:74` → `phone-games.ts:47`：搜索框 + 7 分类 chips + 每游戏 64 dp 行；启动仍复用 `playSmallGame`/`playDiudiule`/`startFlashGame`（`phone-games.ts:113-127`） | 行 64、图标 40、开始 44、chip 44 | `phone-games.css:20-205` |
| 企鹅岛 | `island-runtime.ts:359-385`：同一份桌面 markup，容器换 sheet；`renderIsland` 的命令调用不变 | 行 56、动作 44、页脚三列 | `phone-pages.css:987-1111` |

所有新面都只改布局，不改业务数据：签到/任务/邮箱/档案沿用原模块的 store 读取与 claim/兑换规则，游戏大厅复用桌面启动函数，企鹅岛复用 `islandCommands`。桌面窗口分支逐行保留，手机分支只在 `phoneUI()` 命中时先返回。

## 6. 逐界面适配状态

判定口径（`tmp/reports/mobile-ui/06-triage.md` §0）：412×892 dp、dpr 2.625、`hasTouch`、`body.qp-phone`；**OK** = 完整可见且正文 ≥12 dp、目标 ≥40 dp；**需优化** = 能用但字 <12 dp 或目标 20–39 dp；**不可用** = 主操作出屏/被裁/点不到。上版判定与根因数字来自三份独立复核（`tmp/reports/mobile-ui/05-review-a.md`/`05-review-b.md`/`05-review-c.md`），本轮状态对应当前工作区代码。

| 页面 | 上版判定 | 根因（实测） | 本轮状态 |
| --- | --- | --- | --- |
| 领养（首屏） | 不可用 P0 | `.adopt` 607×455 被 `.qp-panel` 限宽到 380，`.box` 只露 65%，「导入存档」76×22 @ x539–615 屏外；SWF 还被四分之一旋转成横躺 | 已修：手机走底部 sheet（4:3 立绘 + 56 dp 选择键 + 导入行），真机领养成功（`adopt.ts:52-70`） |
| 游戏大厅 | 不可用 P0 | `.ui-games{min-width:540;zoom:1.25}` → 675 宽，只见 56%；7 分类 5 个可见，28 个游戏里 9 个点不到 | 已修（真机实测：17 个目标 0 个 <44、overflowX 0；行 64、开始 72×44）：手机分类 chips + 64 dp 游戏行（`games.ts:74`、`phone-games.ts:47`） |
| 签到 | 不可用 P0，且零入口 | 737×485；日历右栏 x≈546 出屏；桌面入口只在浮动工具栏 | 已修（本轮新增，待真机回归）：sheet + 7 列月历 + 工具组入口（`signin.ts:88`、`phone-menu.ts:188`） |
| 任务 | 不可用 P0，且零入口 | 607×455；「领取」按钮 x≈550–628 在屏外 | 已修（本轮新增，待真机回归）：64 dp 行 + 96×44 领取 + 工具组入口（`task.ts:13`） |
| 农场 | 不可用 P0 | 700×550 六列绝对定位，缩放 0.558 后 6.7 dp、目标 42×13 | 已修：手机 sheet + 地块 2 列 + chip ≥44（`farm.ts:193`、`phone-panels.css:679-710`） |
| 企鹅岛 | 不可用 P1 | 590 宽，缩放 0.671 → 8.7–9.4 dp，交谈/聊天 17×14 | 已修（真机实测：动作最小 62×44、页脚 121×44、overflowX 0）：sheet 行 56、动作 44、页脚三列（`island-runtime.ts:359`） |
| 旅行 | 不可用 P1 | 610 帧、缩放 0.649 → 10.4 dp，省名 5.8 dp，按钮 19 dp | 已修：手机 sheet、地图自适应、tab 44/主按钮 48（`travel.ts:144`） |
| 相册/相片 | 需优化 P1 | 相片 500×350 窗口；相册 3 列在 412 dp 里挤成 2 列且说明 11 px | 已修：相片 sheet 内按宽 contain、相册 2 列/12 px（`album.ts:20`、`phone-panels.css:757-783`） |
| 邮箱 | 需优化 P1，入口隐性 | 355 宽 1:1 可读，但领取/删除/翻页/关闭只有 20–25 dp；主入口只在工具栏 | 已修（本轮新增，待真机回归）：64 dp 行 + 操作 44–48 + 工具组入口（`email.ts:25`、`phone-menu.ts:186`） |
| 宠物档案 | 需优化 P1 | 432×420，右侧属性列/保存键出屏，缩放后 10.8 dp | 已修（本轮新增，待真机回归）：96 dp 头像、44 dp 输入/保存、两列网格（`petinfo.ts:64`、`phone-petinfo.ts:86`） |
| 考试 | 需优化 P1 | 300 宽可读，选项 20×20、退出 50×20 | 已修：24 dp 视觉 + 44 dp 热区（`phone-panels.css:784-821`） |
| 结果弹窗 | 需优化 P1 | 「确定」只有 22 dp | 已修：48 dp、正文 14–15 px、92vw（`phone-panels.css:823-837`） |
| 钓鱼 | 需优化 | 411×320，缩放 0.963（≈1:1）；SWF 内按钮未验证 | 保持（可接受）；SWF 内控件列入未验证（§7） |
| 社区 | 不可用 P0 | 800×600 纯 SWF，缩放 0.489；手机两种模式都不可达 | 建议手机隐藏入口（SWF 无法重排），列入下版决策 |
| 密室 | 界面 P1 / 入口 P0 | CSS 已适配（舞台 380×285、键 64 dp），但手柄浮层盖住舞台 34%+23.6%；runtime 菜单过滤掉密室 | 入口与遮挡列入下版决策 |
| 小游戏窗口 | 可用 P2 | 140×140 1:1，退出 44 dp 常显但压住右上角约 10% | 接受 |
| 丢丢乐 | 可用 P2 | 退出 44 dp 挂在宠物上，会随宠物移动 | 接受 |
| 说话气泡 | 可用 P2 | 261×183、字 ≈13.7 dp；按钮在 SWF 内不可控 | 接受 |
| 探访（朋友来玩） | OK | 358×239 1:1、15.5 dp | 无需处理 |
| LAN 回话框 | 需优化 P2 | 96×36 按钮 | 下版（Android 无 LAN 桥，当前不可触发） |
| 手机菜单/状态/喂养/商城/聊天/设置 | OK | 上一版已重排 | 保持（本轮真机：18 个顶级行 min 56、5 个瓦片 68×72） |
| 进度条数值（seeNum） | 需优化 P2 | 11 px 压在填充条上 | 已修：13 px + 深色描边（`phone-panels.css:562-575`） |
| 设置标签条 / 商城分类条 | 需优化 | 横向滚动把「工具/AI/关于」「属性/装扮」藏在屏外 | 已修：手机改为换行，全部可见（`phone-panels.css:336-535`、`phone-shop.css`） |
| firstrun（首次会话） | 不适用 | Android 构建不含 firstrun.html，真正的首屏是领养弹窗 | — |

宠物本体不在上表：盒 167 dp、可见约 83×117 dp，尺寸未变；轻点开菜单、拖动移位、长按兼容，纵坐标避开状态栏（§3）。

## 7. 已知限制与下版顺序

### 7.1 已知限制

- **社区**：800×600 纯 SWF，`touch-action:none`，内部控件随舞台缩到 0.489（12 px 字约 5.9 dp），CSS 无法重排；runtime 用企鹅岛替代，legacy 手机没有入口。下版应在手机菜单明确隐藏或标注“桌面可用”，不要补一个点不动的入口。
- **密室**：CSS 已把舞台改成 380×285、按键 64 dp，但手柄 `.padArrows`/`.padButtons` 是 `position:fixed`，包含块是带 `transform` 的 380×285 舞台框，分别盖住舞台 34% 和 23.6%；runtime 菜单的过滤器（`control.ts:285-298`）又把密室过滤掉，手机仍无入口。入口与手柄竖排都列入下版。
- **钓鱼 SWF 内部控件**：舞台 411×320、缩放 0.963，宿主侧只有买苗弹窗已重排；抛竿/收杆/卖鱼的按钮在 Ruffle 内部，CSS 不可量，尚未真机验证。另有一个 50×50 的冷却期隐形块位于 (0,125)。
- **openFrame 且没有自带关闭控件的面板**：`openFrame` 的返回键/遮罩已统一走 `dismiss()`（`box.ts:256-266`），有 `.sclose`/`.windowViewBut` 时会点控件；钓鱼（`fishing.ts:17,30,187-199` 的 `open` 与 `window.close_game`）和密室（`mstx.ts:10,63-69` 的 `closeFrame`）没有这类 DOM 控件，仍走 `stop()`，清理不会执行，二次打开可能静默失效。给它们加关闭控件，或把清理挂到 `stop`。
- **旧壳返回键**：Android 返回键只在包含 `setBackHandler` 的新壳上生效；旧 APK + 新页面时 `window.__qqpetSetBackHandler` 是 no-op，面板仍可点遮罩、✕ 或下滑关闭，但返回键退回原行为（`src/android/bridge.ts:61-63,98-101`；`back.ts:13-23`）。
- **宠物横向安全区**：宠物横向未按 `--safe-*` 的左右值钳制；本次只实测了 `--safe-top`（24.03），横屏/挖孔设备的左右与底部安全区未验证（`main.ts:92-93`）。
- **平板/iOS**：平板继续使用 480 CSS px 设计空间，手机样式不会命中；iOS/HarmonyOS 只有在页面本来就按 1 CSS px = 1 pt/dp 布局时才会命中 `phoneUI()`。两者都未在真机回归。
- **键盘避让**：依赖 `visualViewport` 真正收缩；宿主若不回报，sheet 只能按布局视口贴合，无法保证输入框始终可见（`sheet.ts:136-147`）。
- **firstrun 不属 Android**：Android 构建输入只有 `index`/`game`/`swf`（`vite.android.config.ts:19`），firstrun 只在 Electron 输入端；Android 真正的首屏是 §5.4 的领养 sheet。
- **LAN 回话框**：按钮 96×36；Android 桥没有 `lanSend/lanPeers`，peer 恒空，当前不可触发（`src/android/bridge.ts` 无 LAN 实现）。
- **小游戏/丢丢乐**：退出键 44 dp 但小游戏会盖住画面右上约 10%，丢丢乐的退出键随宠物移动；属可接受 P2。

### 7.2 下版顺序

1. **社区入口**：手机隐藏或标注“桌面可用”；不要补入口。
2. **密室**：先决定是否开放；若开放，补 runtime 菜单入口，并把舞台与手柄改成竖排（舞台在上、手柄带在下），避免 `position:fixed` 盖住舞台。
3. **钓鱼**：补 44 dp 宿主操作条（买苗/收获/加速/关闭），真机验证 SWF 内抛竿/收杆/卖鱼，并修 §7.1 的 `openFrame` 返回键清理。
4. **平板与其它移动宿主**：确认页面按 1:1 布局后才允许命中 `phoneUI()`；至少在真机验证 iPad/HarmonyOS 的旋转、安全区和键盘。
5. **P2 打磨**：LAN 回话框、小游戏退出位置、丢丢乐退出跟随、说话气泡按钮（只能改 SWF）。

## 8. 验证命令

预期退出码均为 `0`；非 `0` 即视为该项失败。

```bash
# 类型边界（桥接、渲染层、手机模块）
npm run typecheck

# 全量行为测试（含手机手势、菜单、面板 CSS、商城模型、页面重排）
npm run test:compat

# 手机层单测
node --experimental-strip-types --test scripts/tests/pet-tap.test.mjs scripts/tests/pet-drag.test.mjs
node --experimental-strip-types --test scripts/tests/phone-menu.test.mjs scripts/tests/phone-shop.test.mjs scripts/tests/phone-panels-css.test.mjs
node --experimental-strip-types --test scripts/tests/phone-games.test.mjs scripts/tests/phone-pages.test.mjs

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

通过标准：`phone` 为 `true`、`innerWidth` 与 `clientWidth` 都等于 412、`scale` 接近 1；菜单行高 ≥56、正文 ≥15；面板/商城/签到/任务/邮箱/档案/游戏大厅/企鹅岛可点元素短边 ≥44、无横向溢出；领养、农场、旅行、相册、考试、结果弹窗完整可见；轻点宠物开面板、拖动移位、长按仍开面板；商城能完成一次真实购买且背包数量变化。

## 9. 变更影响

- **新增手机 surface**：复用 `openSheet()`/`openBox()` 与 `qp-*` 基础类，CSS 必须以 `body.qp-phone` 作用域；新页面同时补 `scripts/tests/phone-*.test.mjs` 的纯模型/作用域断言，并在 §6 增加一行。
- **改 `phoneUI()` 阈值或判定**：会影响所有手机样式是否启用，必须同时验证旧壳（仍 480）、平板（≥600 dp 短边）和桌面（无 coarse 指针），并更新本文 §1。
- **改 `AssetClient` 视口缩放**：同时影响 `innerWidth`、`setBounds` 的 `viewport` 换算、`--safe-*` 数值和宠物尺寸归一化；必须重跑 `npm run build:android-web` 与 §8 的真机测量。
- **改 `setBackHandler`/`__qqpetBack` 契约**：必须同步 `src/android/bridge.ts`、`PetService.kt`、`src/renderer/global.d.ts` 与 `docs/architecture/native-bridge.md` §4.2；漏一端会让返回键静默失效。
- **改 `box.ts` 的 `flat`、frame 宽度或面板内容宽度**：先满足 §5.3 的契约 1；任何给 `.qp-panel`/`.boxFrame` 加宽高限制的规则都会让 `flat` 失效，必须改用内容重排。桌面回归要同时打开宽面板确认缩放未变。
- **改菜单树/入口过滤**：同步 `phoneEntries()`/`SHORTCUTS` 与 `phone-menu.test.mjs`，遵守 §4.1 的“删入口必须同时补入口”；`runtimeMenuItems()` 保持桌面树不变。
- **桌面回归**：手机 surface 规则都以 `body.qp-phone` 为作用域（base sheet 原语只在手机分支创建），桌面/平板应保持原样；改动后跑 `npm run typecheck` 与 `npm run test:compat`，并在桌面上打开菜单、状态、设置、商城确认布局未变。

## 10. 代码位置到文档的映射

| 代码位置 | 同步文档 |
| --- | --- |
| `src/renderer/ui/mobile/**`、`src/renderer/ui/css/phone-panels.css`、`src/renderer/ui/css/phone-pages.css` | 本文 §2–§6 |
| 手机分支接入点（`src/renderer/main.ts`、`src/renderer/pet/input.ts`、`src/renderer/ui/menu.ts`、`src/renderer/ui/runtime-menu.ts`、`src/renderer/ui/box.ts`、`src/renderer/ui/control.ts`、`src/renderer/ui/state.ts`、`src/renderer/ui/shop.ts`） | 本文 §3–§5 |
| 页面手机分支（`adopt.ts`、`farm.ts`、`travel.ts`、`album.ts`、`signin.ts`、`task.ts`、`email.ts`、`petinfo.ts`、`games.ts`、`island-runtime.ts`） | 本文 §5.4、§6 |
| Android 视口与返回键（`AssetClient.kt`、`PetService.kt`、`src/android/bridge.ts`） | 本文 §1、§5.1、§5.3 与 [原生桥](native-bridge.md) §4.2 |
| 桌面窗口/面板契约（`src/renderer/style.css`、桌面菜单与商城） | [桌面 IPC 与 preload](desktop-ipc-and-preload.md) 与本文 §5.2 |
