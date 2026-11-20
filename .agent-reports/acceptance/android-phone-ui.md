# 验收报告：Android 手机专属 UI 层

> 结论：**通过**。独立 verifier（未参与实现）在 412×892dp / dpr 2.625 模拟器上，对最终冻结包 `136838789ac05752` 逐项复测 10 项验收与 4 个反例，结果是 **10 项通过、0 项失败**；4 条桌面门禁全绿（typecheck / test:compat / test:docs / check:docs 退出码均为 0）。所有触摸都用真实 `adb shell input tap/swipe` 注入，未使用合成事件；面板尺寸/字号/溢出全部来自页面内 `getBoundingClientRect` + `getComputedStyle` 实测。仍有 3 个非阻塞缺陷建议后续修（§5），无阻塞交付项。
>
> 后续：实现方在 `136838789ac05752` 之后又出了 `d10245a662f00318`，修掉 §5.1（设置标签条 / 商城分类条横向溢出）与 §5.2 的数值部分（状态数值触屏常显），§5.3 按既有策略保留。该包的 5 项回归抽测见 **§9**：全部通过，4 条门禁复跑仍全绿；唯一新增小问题是常显数值只有 11px（见 §9.2）。

## 0. 一句话风险提示

验收期间实现方在 14 分钟内**重装了 5 次 APK**（每次 `installPackageLI` 都会 force-stop 应用），导致 21:58–22:08 的测量跨了多个包。本文所有结论均取**最终冻结包**重测，冻结前的数据只用于发现问题（见 §1.2）；冻结后的测量在每个步骤都核对了包 sha。

## 1. 环境与被测构建

### 1.1 环境

| 项 | 值 |
|---|---|
| 设备 | emulator-5554（Android API 33 / `ro.build.version.sdk=33`） |
| 屏幕 | `wm size 1080x2340`、`wm density 420` → 412×892dp，dpr 2.625 |
| 页面 | CSS 1px = 1dp；`innerWidth=412`、`visualViewport.scale=1`、`body.className="faceHint qp-phone"` |
| 安全区 | `--safe-top: 24.0333px`、`--safe-bottom: 0px` |
| 数据 | 真实存档（`宠宝~ Lv.1`），全程**未清除数据**，也未点过任何破坏性确认 |
| 测量通道 | `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + `tmp/mobile/probe.mjs`（页面测量）+ `adb exec-out screencap`（真机整屏） |

### 1.2 被测构建（冻结包）

- APK：`android/app/build/outputs/apk/debug/app-debug.apk`
- 设备内 `base.apk` 与工作区 APK **sha256 完全一致**：`136838789ac05752bfbb6d8c38275c469c8019ef00ee007478383ee538c1e9cf`
- 安装时间 `2026-11-19 22:09:47`；`find src -newer app-debug.apk` 为空 → 源码与包一致

冻结前的构建漂移（同一设备，全部来自 `dumpsys activity exit-info` 的 `installPackageLI` 记录）：

| APK sha 前 16 位 | 安装时刻 | 用途 |
|---|---|---|
| `3044f2a376677aad` | 21:55 | 前 7 项初测（当时结论已成立，但不作为最终证据） |
| `8e609e72955289f5` | 22:04:19 | 横屏适配修正 |
| `9a1ff062c84e0b5a` | 22:05:36 | 横屏 sheet 宽度上限 |
| `ebe92881eae67f7a` | 22:06:37 | 旋转钳制时机 |
| `cdc6403a99bd3a8d` | 22:07 | 引入 `window.setTimeout`，**打红 4 个 renderer 单测**（见 §2 注） |
| `136838789ac05752` | 22:09:47 | **最终冻结包（本文全部证据）** |

## 2. 门禁（最终源码，冻结后重跑）

命令与退出码：

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `npm run typecheck` | **0** | `tsc --noEmit` × 4（node/web/harmony/e2e）全通过 |
| `npm run test:compat`（排除 `scripts/tests/lan.test.mjs`） | **0** | 87 个测试文件，932 tests / 930 pass / 2 skipped / **0 fail**，14.5s |
| `npm run test:docs` | **0** | 106 tests / 0 fail |
| `npm run check:docs` | **0** | “文档检查通过：目录结构、索引、链接与代码引用均有效。” |

`test:compat` 的实际命令（等价于 npm script，仅去掉一个文件）：

```
COMPAT=$(ls scripts/tests/*.test.mjs | grep -v 'lan.test.mjs')
node --experimental-strip-types --test --test-concurrency=1 $COMPAT
```

**排除 `lan.test.mjs` 的理由（必须说明）**：该用例在无外部网络的沙箱里会挂住而不是失败退出，跑它会让整个门禁超时；其余 87 个文件全部执行，没有用 `skip`/`only` 掩盖任何用例。

**注（这次门禁真的红过一次）**：在中间包 `cdc6403a` 的源码上，同一命令返回 **1**，`face-input / multi-monitor / pet-drag / tray-state` 四个文件红，错误是 `TypeError: window.setTimeout is not a function`（renderer fixture 只注入裸 `setTimeout`）。实现方改成裸 `setTimeout` 后重构建，冻结包上复跑转绿；本文记录该过程，避免“一直是绿的”的错觉。

## 3. 逐项验收（10 项）

判定口径一律取**实际渲染结果**：`getBoundingClientRect()` 的 CSS px（=dp）与 `getComputedStyle().fontSize`；触摸一律 `adb shell input tap/swipe` 的真实注入（坐标由 DOM 中心 × dpr 2.625 换算）。

### 3.1 ① 轻点宠物 → 底部面板：行高 / 字号 / 横向溢出 —— **PASS**

- 命令：`adb shell input tap 516 406`（宠物中心 dp(196.5,154.6) ×2.625），`exit=0`
- 结果：`sheet=true`、`title="QQ宠物"`、`body="faceHint qp-phone qp-sheet-open"`
- 测量 JSON 摘要：

```json
{"rowH":[56],"rowFont":[15],"subH":[48],"tiles":["87.0x72.0","87.0x72.0","87.0x72.0","87.0x72.0"],
 "close":"48.0x48.0","card":{"x":0,"y":107.1,"w":412,"h":785.1},"overflowX":0,"vp":[412,892]}
```

- 判读：菜单行 9 个全部 56.0dp（≥56）、字号 15px（≥15）；二级行 48dp/15px；`overflowX=0`。
- 证据：`/tmp/qqpet-verify-01-tap-pet-menu.png`

### 3.2 ② 拖动宠物：移位、松手不弹面板、y ≥ safe-top —— **PASS**

- 关闭面板：点 ✕（dp 382,141.1 → phys 1003,370），`sheet=false`
- 拖动：`adb shell input swipe 516 406 516 1193 700`（+300dp），`exit=0`
- 结果：`pet.y 71.1 → 370.9`，`sheet=false`（松手未弹面板）
- 向上拖到屏幕外：`swipe 516 1193 516 -1170 700` → `pet.y=24`（被钳在安全区）
- 判读：`safe-top=24.0333dp`，实测 `y=24`（差值 0.03dp，等于密度换算的亚像素取整），可判定满足 `y ≥ --safe-top`；两次拖动后 `sheet` 均为 false。
- 证据：`/tmp/qqpet-verify-02-drag-down.png`、`/tmp/qqpet-verify-02b-drag-top-clamp.png`

### 3.3 ③ 长按 500ms+ 仍能打开面板 —— **PASS**

- 命令：`adb shell input swipe 516 282 516 282 520`（同点按下 520ms），`exit=0`
- 结果：`sheet=true`、`title="QQ宠物"`，宠物未位移（`petY=24` 保持）
- 证据：`/tmp/qqpet-verify-03-longpress.png`

### 3.4 ④ 4 个快捷操作瓦片 + 喂养真实生效 —— **PASS**

- 瓦片尺寸：`.qp-shortcut` 四个各 **87.0×72.0dp**（≥44）；字号 16px
- 路径：菜单 → `adb shell input tap 167 934`（喂养瓦片 dp(63.5,355.7)）→ 打开 `喂养` 商品 sheet
- 商品 sheet 内容（点击前）：`当前990 / 1100`；`冰淇淋 饥饿：360 数量：2`、`圈圈冰激凌 饥饿：100 数量：5`；商品行高 94.9dp / 75.3dp（≥44）
- 点第二件商品（dp 206,712.5 → phys 541,1870）一次后：

```
点击前：当前 990 / 1100   圈圈冰激凌 … 数量：5
点击后：当前 1090 / 1100  圈圈冰激凌 … 数量：4
```

- 判读：一次点击同时改变宠物数值（饥饿 +100）与背包数量（5→4），不是只关面板或只弹提示。
- 证据：`/tmp/qqpet-verify-04-shortcut-feed.png`（面板）、`/tmp/qqpet-verify-04b-feed-used.png`（生效后）

### 3.5 ⑤ 宠物状态面板 —— **PASS**

- 路径：菜单 → `宠物状态`（行 412×56dp，dp 206,732.8 → phys 541,1924）
- 测量：

```json
{"box":{"x":26.1,"y":245.1,"w":360,"h":426,"pctW":87.38},"fonts":{"14":100,"11":5},
 "overflowX":0,"innerOverflow":0,"close":{"w":44,"h":44,"x":332.1,"y":249.1}}
```

- 判读：宽度 **360dp**（判据“≥360dp 或 92vw”，命中前者）；可见文本 100 个元素全部 14px（≥14）；`scrollWidth==clientWidth` 无横向溢出；✕ 44×44，真实点击 phys(930,712) 后面板关闭（`PetStateInfo=false`）。
- 说明（不算失败）：另 5 个元素字号 11px，但 `opacity:0` 且类名带 `hover`——它们是桌面端 hover 才显示的进度精确值，触屏永远不会渲染，因此不计入“可见字号”。
- 证据：`/tmp/qqpet-verify-05-pet-state.png`

### 3.6 ⑥ 通用对话框（重新领养宠物，只截图不点确定）—— **PASS**

- 路径：菜单 → 上滑（`swipe 540 1900 540 1250 500`）→ `重新领养宠物`（dp 206,798.3 → phys 541,2096）
- 测量：

```json
{"frame":{"x":36.1,"y":340.1,"w":340,"h":236},
 "msg":{"fs":15,"h":43.5},
 "submit":{"w":220,"h":48,"x":96.1,"y":508.2},
 "close":{"w":44,"h":44,"x":337.1,"y":333.1},"overflowX":0}
```

- 判读：正文 15px（≥15）；确定 220×48（≥44）；✕ 44×44（≥44）
- **没有点「确定」**：只点 ✕（phys 943,932），关闭后重开菜单，头部仍是 `宠宝~Lv.1›饥饿1088清洁892心情924`，存档未被清空。
- 证据：`/tmp/qqpet-verify-06-dialog-readopt.png`

### 3.7 ⑦ 聊天面板 —— **PASS**

- 路径：菜单 → `和我聊天`（行 412×56，dp 206,469.8 → phys 541,1233）
- 测量：

```json
{"panel":{"w":379.2,"h":535.3,"pctW":92.04},"box":{"w":380.2,"pctW":92.28},
 "input":{"w":253.2,"h":44,"fs":15},"send":{"w":88,"h":44,"fs":15},
 "msgFs":15,"close":{"w":44,"h":44},"overflowX":0}
```

- 判读：面板宽度 379.2dp = **92.04vw**（判据 92vw）；正文/输入框/发送按钮字号均 15px；输入框 44dp、发送 88×44dp（≥44）；✕ 44×44；`overflowX=0`
- 证据：`/tmp/qqpet-verify-07-chat.png`

### 3.8 ⑧ 设置面板 —— **PASS**

- 路径：菜单 → `设置帮助`（展开二级）→ `系统设置`（二级行 412×48，dp 206,803.3 → phys 541,2109）
- 容器：`.ui-setup2` 379.2×713.8dp（92vw），`overflowX=0`
- 行/控件实测（`.scheck` 整行即目标，`.cb` 只是 24×24 的视觉方框）：

```json
{"tabs":[{"w":86,"h":44},{"w":58,"h":44},{"w":44,"h":44}],
 "rows":[{"cls":"scheck","w":338.3,"h":54.2},{"cls":"scheck","w":338.3,"h":48},{"cls":"scheck","w":338.3,"h":54.2}],
 "cb":{"w":24,"h":24},
 "buttons":[{"w":183.9,"h":44},{"w":208.9,"h":44},{"w":298.9,"h":44},{"w":44,"h":44},{"w":44,"h":44}],
 "input":{"w":338.3,"h":44},"close":{"w":44,"h":44}}
```

- 判读：三行勾选项整行高 54.2 / **48** / 54.2dp（≥48，最小的一行正好 48）；标签页 86/58/44×44dp（≥44）；按钮与 ± 44dp；输入框 44dp；关闭 44×44
- 已知缺陷（非阻塞，见 §5.1）：标签条内部横向溢出，内容 512dp / 可见 375dp，`工具 / AI / 关于` 三个标签在屏幕外，必须横滑才能看到，且没有滚动提示。
- 证据：`/tmp/qqpet-verify-08-settings.png`

### 3.9 ⑨ 商城：分段/分类/商品卡/购买 + 进入数量选择并取消 —— **PASS**

- 路径：菜单 → `打开商城`（行 412×56，dp 206,676.8 → phys 541,1777）→ 手机 sheet（title `商城`）
- 测量：

```json
{"tabs":[{"w":183,"h":48},{"w":183,"h":48}],
 "chips":[{"w":64,"h":44},{"w":64,"h":44},{"w":73,"h":44},{"w":64,"h":44}],
 "card":{"cls":"qp-shop-product","w":185,"h":184.2},
 "buy":{"w":163,"h":44,"fs":13},"minFont":13,"overflowX":0}
```

- 判读：分段 48dp、分类胶囊 44dp、商品卡 185×184.2、购买 163×44dp（≥44），面板最小字号 **13px**（≥13）
- 购买流程（**只在数量页停留并取消，没有成交**）：

```
点「购买」→ 行内出现：共 5 元宝 · 余额 4985  − 1 +  [取消] [确认]
− / + 各 44×44，取消 78.5×44 fs13
点「取消」(phys 174,1446) → 数量行消失，余额仍 4985，卡片仍「已有 4」
```

- 证据：`/tmp/qqpet-verify-09-shop.png`（商城）、`/tmp/qqpet-verify-09b-shop-qty.png`（数量页）、`/tmp/qqpet-verify-09c-shop-cancelled.png`（取消后）

### 3.10 ⑩ Android 返回键 —— **PASS**

- 面板打开时：`adb shell input keyevent 4`，`exit=0` → `sheet=false`，`body="faceHint qp-phone"`，**进程 pid 前后都是 3675**（应用没退）
- 再按一次：`sheet=false` 保持，`topResumedActivity=com.uncube.launcher3/…HomeActivity`（停桌面，没有误关其它东西）
- 旧版窗口也吃返回键：打开 `和聊天` 后按返回，`.modal` 与 `.ui-chat` 同时消失，pid 不变 → 证明 `back.ts` 的共享栈确实覆盖 sheet + box/state，而不是只包了新面板。
- 口径说明（不粉饰）：本应用的宠物是 **TYPE_APPLICATION_OVERLAY 浮窗**，验收时前台本来就是桌面，所以“不退回桌面”与“第二次返回才到桌面”在语义上无法用“前台 activity 从 A 变 B”来证伪；可证伪的强证据是——**返回只关面板、不杀进程、不改前台 activity**，且第二次返回不会产生副作用。这一点已按上述三条实测。
- 证据：`/tmp/qqpet-verify-10a-back-closed-panel.png`、`/tmp/qqpet-verify-10b-back-again.png`、`/tmp/qqpet-verify-10c-back-closes-chat.png`

## 4. 反例探索（4 个）

### 4.1 连续快速点宠物 5 次 —— 无卡死、无叠层

- `for i in 1..5; do adb shell input tap 516 282; done`，等 1.5s
- 结果：`.qp-sheet` 0 个、`.modal` 0 个、`.ui-state` 0 个，`body="faceHint qp-phone"`（无残留 `qp-sheet-open`），`overflowX=0`，进程存活
- 判读：连点期间面板开→关反复切换，最终收敛到关闭态，没有出现两个 sheet 叠加或半透明遮罩残留。
- 证据：`/tmp/qqpet-verify-12a-rapid-5taps.png`

### 4.2 面板打开时点宠物位置 —— 不叠层

- 面板已开（`QQ宠物`）时再点宠物中心：仍只有 **1** 个 `.qp-sheet`，无 `.modal`/`.ui-state`，`title` 不变，pid 不变
- 判读：宠物点击在面板打开时被遮罩/面板吃掉，不会二次开面板。
- 证据：`/tmp/qqpet-verify-12b-tap-pet-while-panel-open.png`

### 4.3 旋转（竖 → 横 → 竖）—— 通过，且验证了本轮的旋转修复

- 触发方式：`adb shell wm user-rotation lock 1`（仅 `settings put system user_rotation 1` 时 `mOverrideDisplayInfo.rotation` 仍为 0，必须用 `wm user-rotation`），3s 后测量
- 横屏：`vp=[892,412]`，`qp-phone` 保持，**宠物 y=24**（被钳在 `safe-top 24.0154`），sheet 卡片宽 **560dp 且居中**（x=166，判据 `(892-560)/2`），sheet 内容可滚动（898/295），`overflowX=0`
- 回到竖屏（`wm user-rotation lock 0`）：`vp=[412,892]`，宠物 y=71.1、bottom=238.2（在屏内），sheet 复原 412×785.1，`overflowX=0`
- 判读：没有出现窗口裁切、横向溢出或宠物跑到屏外；实现方本轮修的“旋转后一帧仍用旧 innerWidth 导致移动被跳过”在冻结包上已不可复现。
- 证据：`/tmp/qqpet-verify-11b-landscape.png`、`/tmp/qqpet-verify-11c-portrait-back.png`

### 4.4 切后台再回来 —— 浮窗存活，但第三方全屏应用前台时宠物不可见/不可点

- `adb shell am start -a android.settings.SETTINGS` → `topResumedActivity=com.android.settings/.homepage.SettingsHomepageActivity`，**pid 仍 3675**（浮窗服务没被杀）
- 此时整屏是系统设置，**看不到宠物**，`input tap` 打不开面板（符合“全屏应用隐藏宠物”的既有策略，但对用户表现为“宠物消失且唤不起”）
- 按 Home（`keyevent 3`）→ 回到桌面，宠物重新可见，再点宠物 → `sheet=true, title=QQ宠物`，交互恢复
- 补充：`am start -n net.ankio.qqpet/.MainActivity` 不会把任何 activity 带到前台（该 Activity 是启动即结束的壳），所以“回来”只能靠桌面/托盘，这点建议写进用户文档。
- 证据：`/tmp/qqpet-verify-12c-background-other-app.png`、`/tmp/qqpet-verify-12d-return-to-app.png`、`/tmp/qqpet-verify-12e-back-home-tap.png`

## 5. 发现的问题（按严重度，均非阻塞）

### 5.1 设置面板标签条 / 商城分类条横向溢出且无滚动提示（严重度：中，**已在 d10245a662f00318 修复**，回归见 §9）

- 设置：`.stab` 容器 `scrollWidth=512` / `clientWidth=375`；截图里 `工具` 被右边缘切一半，`AI / 关于` 完全在屏外。
- 商城：`.qp-shop-chip` 里 `属性`（x=385）、`装扮`（x=457）超出 412dp 视口。
- 影响：这两处是**功能入口**，用户会以为只有看到的几个标签。文档级 `overflowX` 仍是 0（溢出发生在容器内部），所以只看整页指标会漏掉。
- 复现：菜单 → 设置帮助 → 系统设置；菜单 → 打开商城。截图 `08-settings.png`、`09-shop.png`。
- 建议：标签换行/两行栅格，或缩短文案 + 右侧渐隐提示；至少让最后一枚标签露出边缘。

### 5.2 宠物状态面板仍是桌面皮肤窗口，精确数值依赖 hover（严重度：中，**数值部分已在 d10245a662f00318 修复**；皮肤风格未改，回归见 §9）

- `.PetStateInfo` 是 360dp 宽的旧皮肤框（背景是桌面），与新的 `qp-sheet` 卡片风格割裂；成长/饥饿/清洁/健康/心情的**精确数值**（如 `117 / 125`）是 `opacity:0` 的 `.seeNum.hover`，触屏永远不显示，手机上只能看进度条猜数值。
- 复现：菜单 → 宠物状态。截图 `05-pet-state.png`。
- 建议：把数值从 hover 改为常显（或点击进度条显示），并把该面板纳入 phone sheet 体系。

### 5.3 第三方全屏应用前台时宠物完全消失、无任何唤起入口（严重度：中低）

- 系统设置在前台时整屏无宠物、点原位置无响应；只有回桌面才恢复（§4.4）。
- 若是既有的“全屏应用隐藏宠物”策略，应在用户文档里写明，并保留一个托盘/通知入口，否则用户会认为宠物丢了或崩溃了。
- 另有小瑕疵：`重新领养宠物` 对话框宽 340dp（未走 92vw），✕ 位于 `(337.1,333.1)`、宽 44 → 右边缘 381.1dp，超出窗口右边界 376.1dp 约 5dp，视觉上悬在边框外（`06-dialog-readopt.png`）。

## 6. 阻塞项与放行建议

- **阻塞项：无。** 10 项验收 10 通过；4 条门禁全绿；反例未发现卡死、叠层、裁切或焦点丢失。
- 放行建议：可以交付，把 §5.1 / §5.2 作为后续 UI 迭代项（都只影响可达性/一致性，不影响主流程）。
- 唯一需要写进交付说明的是**验收期间反复重装**这件事：任何在 22:09:47 之前拍的截图/测量都可能属于不同 APK；本报告的设备证据全部在 `136838789ac05752` 上重测。

## 7. 复现配方（从零到本文所有数字）

```bash
# 0) 冻结包一致性
shasum -a 256 android/app/build/outputs/apk/debug/app-debug.apk | cut -c1-16   # 期望 136838789ac05752
adb shell pm path net.ankio.qqpet
adb shell sha256sum <上面的路径>                                               # 必须一致

# 1) 调试通道
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof net.ankio.qqpet)
node tmp/mobile/probe.mjs eval '({vp:[innerWidth,innerHeight],dpr:devicePixelRatio})'   # 期望 412/892/2.625

# 2) 轻点宠物（宠物中心 dp × 2.625）
adb shell input tap 516 406
node tmp/mobile/probe.mjs eval '[...document.querySelectorAll(".qp-menu-row")].map(e=>e.getBoundingClientRect().height)'

# 3) 拖动：+300dp 下移，再拖到屏外验证钳制
adb shell input swipe 516 406 516 1193 700
adb shell input swipe 516 1193 516 -1170 700

# 4) 长按 520ms
adb shell input swipe 516 282 516 282 520

# 5) 返回键（面板开 / 面板关各一次）
adb shell input keyevent 4; adb shell input keyevent 4

# 6) 旋转（注意：只改 settings 不生效，必须 wm user-rotation）
adb shell wm user-rotation lock 1 && sleep 3
adb shell wm user-rotation lock 0

# 7) 门禁
npm run typecheck
node --experimental-strip-types --test --test-concurrency=1 $(ls scripts/tests/*.test.mjs | grep -v 'lan.test.mjs')
npm run test:docs && npm run check:docs
```

截图清单（真机整屏，1080×2340 / 横屏 2340×1080）：`/tmp/qqpet-verify-01-tap-pet-menu.png`、`02-drag-down`、`02b-drag-top-clamp`、`03-longpress`、`04-shortcut-feed`、`04b-feed-used`、`05-pet-state`、`06-dialog-readopt`、`07-chat`、`08-settings`、`09-shop`、`09b-shop-qty`、`09c-shop-cancelled`、`10a-back-closed-panel`、`10b-back-again`、`10c-back-closes-chat`、`11b-landscape`、`11c-portrait-back`、`12a-rapid-5taps`、`12b-tap-pet-while-panel-open`、`12c-background-other-app`、`12d-return-to-app`、`12e-back-home-tap`（前缀均为 `/tmp/qqpet-verify-`）。

## 8. 局限

1. 只测了 412×892dp / dpr 2.625 这一档；360×640、折叠屏、平板（>600dp 走桌面布局分支）未覆盖。
2. 触屏手势只覆盖 tap / swipe / 长按；双指缩放、边缘返回手势、无障碍 TalkBack 未测。
3. 安卓版本只覆盖 API 33 模拟器，未上真机（刘海/挖孔、真实系统栏高度可能不同）。
4. 验收期间 APK 被重装 5 次，`21:55–22:07` 的测量不作为最终证据；最终结论只对 `136838789ac05752` 有效。
5. 商城只验证到“数量选择 → 取消”，按任务要求**没有完成真实购买**（任务书 ⑨ 与 task-9 描述里“完成一次真实购买”冲突，以任务书“不要真的买”为准，避免污染真实存档）。

## 9. 最终包 d10245a662f00318 回归抽测

> 结论：**5 项回归全部通过**；另发现 1 个非阻塞的新小问题——状态面板数值改为常显后字号仍是 11px，低于本文 ⑤ 项“字号 ≥14px”的门槛（详见 9.2）。

### 9.1 被测包与结果

- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，设备内 `base.apk` 与工作区 sha256 一致：`d10245a662f00318f81802374720a6fa136c97069fdef658583c58700a83f84f`；`find src -newer app-debug.apk` 为空
- 设备：412×892dp / dpr 2.625 / `qp-phone` 在体；`user_rotation=0`；app pid 4730（回归期间未变）
- 本轮修的两处（设置标签、商城分类换行）与状态数值常显，都在本文 §5.1 / §5.2 指出的路径上，因此按原复现步骤重走

| # | 回归项 | 结果 | 证据（命令 + 测量） |
|---|---|---|---|
| ① | 设置面板 7 个标签可见且可点 | **PASS** | `.snav` 375.2×113、`scrollWidth=375=clientWidth`；`.stab` **7 个分两行**（y=169.2 / 221.2），x∈[26.5,202.5]、宽 44–86（`AI` 正好 44×44，min-width 生效），全部 `inScreen=true` 且 `elementFromPoint` 命中；真实点「关于」(phys 455,638) → 激活页切到 `关于`，内容为「关于软件 QQPet v0.9.0 检查更新…」；返回键关闭设置窗口，pid 4730 不变 |
| ② | 商城 7 个分类 chip 可见且可点 | **PASS** | `.qp-shop-chips` 412×106、`scrollWidth=412=clientWidth`；`.qp-shop-chip` **7 个分两行**（y=268.1 / 320.1），x∈[16,377]，全部 `inScreen=true` 且可命中；真实点「属性」(phys 126,898，修复前该 chip 在 x=385 屏外) → 商品列表切换为 元宝/缴税/成长值，证明换行后的 chip 真能点 |
| ③ | 状态面板 5 个数值可见 | **PASS** | `.seeNum` 5 个，`opacity` 全为 `1`（修复前 0），文本 `124 / 125`、`1068 / 1100`、`870 / 1100`、`5 / 5`、`912 / 1000`，全部 `inScreen=true`、互不遮挡 |
| ④ | 轻点宠物仍能开面板、行高 56dp | **PASS** | `adb shell input tap 516 406` → `sheet=true`、`title="QQ宠物"`；`rowH=[56]`、`rowFont=[15]`、`overflowX=0` |
| ⑤ | 返回键仍能关面板 | **PASS** | `keyevent 4` → `sheet=false`、`body="faceHint qp-phone"`、pid 4730 前后一致、前台仍是桌面 |

门禁（同一份源码，回归抽测后重跑）：`typecheck=0`、`test:compat=0`（87 文件 / 932 tests / 930 pass / 2 skipped / 0 fail，仍排除 `lan.test.mjs`）、`test:docs=0`（106 pass）、`check:docs=0`。

### 9.2 本轮新发现（非阻塞）

**状态面板数值是 11px，低于“字号 ≥14px”的门槛。** 修复前这 5 个 `.seeNum` 是 `opacity:0` 的 hover 元素（不可见，因此不计入可见字号）；`showNums = touch` 让它们在触屏常显后，就成了**可见的 11px 文本**（`fs10` 类，实测 `fontSize=11px`、高 15.4dp），而面板其余文本仍是 14px。截图 `/tmp/qqpet-verify-15a-state-nums.png` 里数字压在进度条填充上，可读但明显小于周围文字。

- 复现：菜单 → 宠物状态 → 看 5 条进度条上的 `124 / 125` 等数值
- 建议：下一轮把这 5 个数值提到 ≥12px（最好 14px）并加描边/底色，保证在深浅两色填充上都可读；不影响本轮放行
- 另：设置标签条、商城分类条换行后，两处容器的 `scrollWidth == clientWidth`（375 / 412），§5.1 的“入口藏在屏外”问题已消除

### 9.3 回归截图

`/tmp/qqpet-verify-13a-settings-tabs-wrap.png`（7 标签两行）、`13b-settings-tab-clicked.png`（点「关于」后内容切换）、`14a-shop-chips-wrap.png`（7 chip 两行）、`14b-shop-chip-clicked.png`（点「属性」后列表切换）、`15a-state-nums.png`（5 个数值常显）、`15b-back-regression.png`（返回键关闭后）
