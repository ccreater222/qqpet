# 手机菜单顶部放大宠物 · 独立验收（2026-11-24 无可见点位复验）

> 结论：**PASS**。本轮按用户要求「移除可见点位、保留原热点逻辑」验收：打开菜单后放大宠物身上没有任何可见圆点/圆圈，但 DOM 仍有 10 个 16dp `.point` 热区（`::after` 36dp 命中区），提示文案为「点击宠物逗它」；按 H/M/BE 坐标点击分别触发 `interact/H7`、`M4`、`BE2`，心情上涨、飘字与菜单文本同步；空白不逗、`faceClick=0` 无点位且不涨心情、滚动/四条关闭路径/快速开关/贴边/桌面 110px 菜单均通过；门禁全部 exit 0。未验证 iOS/HarmonyOS/平板、死亡姿态、无宠物/已埋葬、低端机滚动帧率、`faceClick=1`（隐式点位）单独路径。

## 0. 验收对象与环境

| 项 | 值 |
| --- | --- |
| 设备 | **127.0.0.1:5555**（BlueStacks 重启后新序列号）；SM_G998B / Android 13；`wm size` physical 1920×1080 / override 1080×2340，density 420 |
| 页面 | 412×892 CSS px，dpr 2.625；`innerWidth=412`、`visualViewport.scale=1` |
| 源码 | HEAD `1274d520b3de9ef0334fac4155ccc24ea2d48965` + 未提交实现改动；`git diff` sha256 `6682270…`；`face.ts` sha `405f981d…`、`phone-menu.ts` sha `5c179b79…`、`menu-phone.css` sha `738d9063…`、`pet-stage.test.mjs` sha `a3e77145…` |
| APK | `net.ankio.qqpet.touchprobe` 0.20.0 / 2000，本工作区重新构建；sha256 **`f81fe6c5…`**（设备 `base.apk` 与本地一致，`lastUpdateTime=2026-11-24 15:49:00`） |
| 页面 bundle | `https://appassets.androidplatform.net/assets/index-B8Y0uGgv.js`（与 `out/android/index.html` 及 APK 内 `assets/index.html` 一致） |
| 隔离 | 截图/测量期间 `pidof net.ankio.qqpet`、`pidof net.ankio.qqpet.probe` 均为空；只剩 `net.ankio.qqpet.touchprobe`（pid 3689） |
| 驱动 | `adb -s 127.0.0.1:5555`；`CDP_PORT=9223 node tmp/mobile/probe.mjs tap/eval/swipe`；截图 `probe.mjs adb-shot`（设备合成，包含 Ruffle 层） |

构建/安装实测（全部看到退出码）：`npm run build:android-web` exit 0 / 1.4s（bundle `index-B8Y0uGgv.js`）→ `cd tmp/android-touchprobe && JAVA_HOME=…17.0.2 ./gradlew assembleDebug` exit 0 / 0.82s → `adb install -r` exit 0 / 18.5s → `am start` exit 0 / pid 3689。**没有使用实现者留下的构建或设备状态**，forward 按新 pid 重建。

## 1. 无可见点位：PASS

- 打开菜单后 `faceClick=2`、`body="faceHint qp-phone qp-sheet-open"`；DOM `#pet.qp-pet-stage .point` **10 个**（GG/Adult/peaceful）。
- 每个 `.point` computed `background-image: none`、`animation-name: none`、`box-shadow: none`、`width:16px`、`height:16px`、`pointer-events:auto`；`::after` `inset:-10px`、`36px×36px`、`border-radius:50%`。`getBoundingClientRect()` 为 **16×16**（视觉与布局盒一致），不再有 `point-pulse` 动画。
- 提示文案准确为 **「点击宠物逗它」**（`save.settings.faceClick !== 0` 时显示）。
- 截图 `nodots-01-open.png` 中宠物身上没有任何圆点/圆圈；数据 `nodots-points.json`。
- 热区位置（`left/top` 相对 `#pet`，基准 +8dp 为点击中心；`#pet` rect `(56,134,300,300)`）：

| # | key | left/top | 基准点 (dp) | 点击中心 (dp) |
| --- | --- | --- | --- | --- |
| 0 | BE | 50% / 78% | (206,368) | (214,376) |
| 1 | H | 50% / 45% | (206,269) | (214,277) |
| 2 | LE | 43% / 55% | (185,299) | (193,307) |
| 3 | LF | 35% / 85% | (161,389) | (169,397) |
| 4 | LH | 22% / 74% | (122,356) | (130,364) |
| 5 | M | 48% / 63% | (200,323) | (208,331) |
| 6 | RE | 54% / 55% | (218,299) | (226,307) |
| 7 | RF | 59% / 85% | (233,389) | (241,397) |
| 8 | RH | 73% / 73% | (275,353) | (283,361) |
| 9 | SC | 40% / 72% | (176,350) | (184,358) |

## 2. 热区仍在 → 特定动画：PASS

按 FACE 百分比点击 3 个不同热区（点位视觉不可见，但 DOM 点存在）：

| key | 点击中心 | 活动 SWF（`#pet ruffle-player[data-swf]`） | mood（`info.mood`） | 菜单「心情」 |
| --- | --- | --- | --- | --- |
| H | (214,277) | `pet/Action/GG/Adult/peaceful/interact/H7.swf` | 685 → 692 | 692 |
| M | (208,331) | `pet/Action/GG/Adult/peaceful/interact/M4.swf` | 692 → 701 | 701 |
| BE | (214,376) | `pet/Action/GG/Adult/peaceful/interact/BE2.swf` | 701 → 706 | 706 |

- 实测序列：H 后 mood **685→692**、M 后 **692→701**、BE 后 **701→706**。三个前缀 **H / M / BE 不同**；每次 `.point` 变为 0（动画期间隐藏），`.float-mood` 出现 1 个，菜单文本与 `petInfo.mood` 同步。
- 截图：`nodots-02-be-poke.png`（BE 点击后飘字/菜单同步）。

## 3. 点空白不逗：PASS

- 点位 10 个时点舞台空白 `(100,250)`：mood **706 → 706**，活动 SWF 保持 `pet/Action/GG/Adult/peaceful/Stand.swf`，无 `interact`，点位仍 10 个。

## 4. 连续逗：PASS

- 点 H 热区 `(214,277)` 后 350ms、1250ms：`.point` 均为 **0**，活动 SWF `interact/H1.swf`。
- 动画结束后 watcher 补回 **10 个** `.point`；再点同一 H：mood **773 → 787**（首击后 763→773），活动 SWF `interact/H6.swf`、飘字 1 个、菜单 787。说明同一部位可重复触发，动画期间点位不提前出现。
- 点位不可见不影响连续点击；本轮用 DOM 数量而非截图确认隐藏/补回。

## 5. 滚动：PASS

- `scrollTop=0` 时 stage top `175.07`、点 0 y `368`、mood **769**、points 10。
- 从宠物区域上滑 `(100,420) → (100,180)`、500ms：`scrollTop=232`、stage top `-56.93`、点 0 y **136**（随内容上移约 232dp）、points 10、mood **769** 不变。
- 截图：`nodots-06-scrolled.png`。

## 6. faceClick=0：PASS（设置面板实测）

- 打开「系统设置 → 全局设置」，关闭「是否开启互动动作(开启后会导致点击位置不可进行宠物移动~)」：`faceClick=0`、`body` 从 `faceHint qp-phone` 变为 `qp-phone`、复选框 off。
- 再打开菜单：`points=0`、`hint=null`；点舞台空白 `(100,250)` 和中心 `(250,350)`，mood **704 → 704**，活动 SWF 保持 `Stand`，无 `interact`。
- 随后打开「是否开启互动动作指示器」恢复 `faceClick=2`、`body=qp-phone faceHint`。截图 `nodots-03-faceClick0.png`。
- 设置行说明：菜单底部「设置帮助」的 `宠物资料/系统设置` 是折叠子项，`.qp-menu-sub` 折叠时 `rect height=0`、`grid-template-rows:0px`、inner `overflow:hidden`，其子行 rect 是裁剪后的测量假象，不是视觉重叠；展开后 sub 高度 96px、危险操作整体下移 96px（详见 §10）。

## 7. 回归：PASS

### 7.1 四条关闭路径

- `nodots-close.json`（本轮新构建）：✕ / 点遮罩 / 下滑标题 / 返回键均 `rectExact=true`；closedBefore/after 均为 `(0,704.31,187.685)`（宠物此前贴左）；class `""`、clip `none`、display `block`、0 sheet/0 stage；复开均 1 sheet/1 stage。
- 关闭淡出：四条路径 `maxDiff=0`、badFrames=0（+90ms 采样 pet/sheet 0.887~0.946 区间，具体见 JSON），无「sheet 透明而宠物不透明」。
- 关闭后手动从左侧可见剪影拖动：`lastX 0→41`（拖回画面），仍可拖动。

### 7.2 快速 5 次开关

- `nodots-rapid.json`：5 轮均找到并点击 `.point`，mood **717→731→742→757→770**，活动 SWF `BE4/BE4/BE6/BE2/BE1`；close 后 0 sheet/0 stage、rect 每轮 `(0,704.3,187.7)`、class `""`、clip none、display block，`rectExact=true`（5/5）。
- 注：第 3–5 轮 open 状态采样瞬间 `points=0`（均为 watcher 补点前的短暂状态），但每轮都成功找到点、点击并触发动画；见 §10 风险。

### 7.3 贴边

- 宠物 `lastX=0`（左侧贴边）时从可见剪影打开菜单：stage `#pet` 300×300、points 10、活动 SWF `Stand`，不是贴边剪影；截图 `nodots-04-edge.png`。

### 7.4 桌面 110px 菜单

- CDP `Emulation.setDeviceMetricsOverride(1280×900, mobile:false)`：`body="faceHint"`（无 `qp-phone`）；`contextmenu` 后 `.ui-menu` 存在，`.rightMenu` `(205,494.48,110,201.71)`（宽 **110**），无 `.qp-menu-card`/`.qp-sheet`；清除 override 后恢复 `qp-phone`、412×892。截图 `nodots-05-desktop.png`。

### 7.5 「逗它」瓦片

- 点「逗它」瓦片：菜单保持、stage 保持、points 仍 10、mood **787 → 787**、活动 SWF `Stand`（只显示不可见热区，不直接逗）。

## 8. 门禁：全部 PASS（退出码 0）

| 命令 | 退出码 | 摘要 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 四套 tsc 通过 |
| `npm run test:compat` | 0 | 1125 tests / 1123 pass / 2 skipped / 0 fail（94.1s） |
| `node --experimental-strip-types --test scripts/tests/pet-stage.test.mjs` | 0 | 12 tests / 12 pass / 0 fail（137.7ms） |
| `npm run check:docs` | 0 | 「文档检查通过：目录结构、索引、链接与代码引用均有效」 |
| `npm run build` | 0 | electron-vite 三段构建成功（469/15/554ms） |

日志：`tmp/reports/pet-stage/verify/nodots-gate-*.log`。

## 9. 未验证（不要当作通过）

- iOS / HarmonyOS / 平板真机：本环境只有 Android 模拟器。
- 死亡姿态（health 0）、无宠物/已埋葬：未构造状态。
- 低端机滚动跟随/掉帧：只验证功能与几何。
- `faceClick=1`（隐式点位）单独路径未验证；本轮验证 0 与 2。
- 屏幕阅读器/键盘可达性：只确认 DOM 角色/aria-label，未做 TalkBack。
- 桌面 Electron 实机窗口未启动：用 CDP 尺寸 override + `.ui-menu` DOM 验证；聊天/喂养等其它入口本轮未重测（只回归本轮的「逗它」瓦片）。

## 10. 验证方法注意 / 其他风险

1. **已核实非缺陷（折叠子项 rect 造成的测量假象）**：折叠态「宠物资料/系统设置」所在 `.qp-menu-sub` 的 `getBoundingClientRect()` 为 `[0,731.3,412,0]`、`getClientRects().length=1`、`grid-template-rows=0px`、inner `overflow:hidden`；`elementFromPoint(206,803)` 命中的是可见的「重新领养宠物」行。展开「设置帮助」后 sub 高度变为 `96px`、`grid-template-rows:96px`，危险操作行 y770/826 整体下移到 y866/922（+96px），无重叠。证据：`hotspot-09-menu-bottom.png`、`hotspot-10-settings-expanded.png`、`hotspot-menu-sub.json`。这不是缺陷。
2. **不可见热区的可发现性**：视觉上没有任何点位，用户只能依据提示「点击宠物逗它」或已知的 FACE 区域点击；这是本轮设计选择，不是实现缺陷。若要提升可发现性，可考虑短时高亮或首次提示，但不在本次验收范围。
3. **点位补回瞬态**：`showFacePoints()` 依赖 `machine.pose.a === 'normal'`；快速开关时个别 open 采样瞬间 `points=0`（随后 watcher 补回并成功点击），功能可用但存在短暂无热区窗口。

## 11. 证据索引

- 截图：`tmp/reports/pet-stage/verify/nodots-01-open.png`、`nodots-02-be-poke.png`、`nodots-03-faceClick0.png`、`nodots-04-edge.png`、`nodots-05-desktop.png`、`nodots-06-scrolled.png`、`hotspot-09-menu-bottom.png`、`hotspot-10-settings-expanded.png`。
- 数据：`nodots-points.json`、`nodots-close.json`、`nodots-rapid.json`、`hotspot-menu-sub.json`、`nodots-gate-*.log`、`reverify-close.mjs`、`hotspot-rapid.mjs`。
- 本次验收未修改任何源码或 `docs/**`；写作用域仅 `.agent-reports/acceptance/**` 与 `tmp/**`，未 git add/commit。
