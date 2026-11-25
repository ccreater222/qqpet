# Android 叠加窗触控区：坑点与最佳实践

> 结论：Android 悬浮宠物的触控区必须由**页面当前可见像素**驱动，不能等于窗口矩形；窗口本身则用「1×1 overlay token 父窗 + 裁剪到可见并集的 attached-dialog 子窗 + 透明触控 portal」实现。本文记录 2026-11 这次从「触控范围远大于宠物」到「贴合可见像素、透明区穿透、无 alpha cap、无白闪/菜单背景闪烁」踩过的坑，以及写下一版时应当直接遵守的规则与验收方法。架构细节见 [原生桥接契约](../architecture/native-bridge.md) §4.4 与 [手机 UI 层](../architecture/mobile-ui.md) §3.3，最终证据见 [验收报告](../../.agent-reports/acceptance/2026-11-23-android-touch-region.md)。

## 1. 最终架构速查

1. **页面**：Android 触屏宿主每 50 ms 用 `setHitShape(rects)` 上报当前可见内容（`visiblePetBoxes()` 取 `hitCover` 当前帧；`[data-hit]` 面板；拖动时整页；隐藏 `[]`）。
2. **父窗**：1×1 透明 `TYPE_APPLICATION_OVERLAY`，只用来拿 `windowToken`，不承载可见内容。
3. **渲染子窗**：`TYPE_APPLICATION_ATTACHED_DIALOG`(1003)，`FLAG_NOT_TOUCHABLE`、alpha 1.0，承载全屏 WebView；窗口裁剪到上报矩形并集 + 6 px，`translationX/Y = -childOrigin` 保持页面屏幕锚定；sheet 打开时并集覆盖全屏才全屏。
4. **触控门户**：每个（合并后的）上报矩形一个透明 `TYPE_APPLICATION_OVERLAY` 小窗，`onTouchEvent` 复制 `MotionEvent`，按 `portalScreen - webScreen` 平移后 `web.dispatchTouchEvent`。
5. **`setBounds`** 保留 JS 契约但 no-op；裁剪由 `setTouchableRegion` 的并集决定。

## 2. 坑点清单（症状 → 根因 → 规则）

| # | 症状 | 根因 | 规则 |
|---|---|---|---|
| 1 | 宠物周围一大片「看不见但点得到」的区域 | Android 叠加窗的**窗口矩形就是触控区**，透明像素不会穿透；旧实现用「学习绘制并集 + 24 dp 边距」做窗口防抖，触控跟着放大 | 窗口裁剪可以保守，**触控区必须用当前可见像素**；不要复用视觉防抖的矩形当触控 |
| 2 | 想用 `ViewTreeObserver.InternalInsetsInfo.touchableRegion` 精确设区，运行报 `NoSuchFieldException` | 它是 @hide，默认 hidden-API 策略对 targetSdk 35 过滤；只有全局 `hidden_api_policy=1` 的调试机才可见 | 不交付 hidden API；按本文公开 API 方案实现 |
| 3 | 渲染窗设 `NOT_TOUCHABLE` 后整只宠物/面板变暗到约 80% | AOSP `DisplayPolicy.adjustWindowParamsLw` 对 system alert window（如 2038）在 `NOT_TOUCHABLE` 且 alpha > 0.8 时强制压到 0.8（防点击劫持）；实测白 255→207 | 可见内容不要放在 system alert 父窗；放 1003 attached-dialog 子窗（不是 system alert，不受 cap）。1×1 token 父窗被压 0.8 无所谓 |
| 4 | 改用 1003 全屏子窗后，透明区挡住了下面的 launcher：`dumpsys input` 触控目标 `<none>`，force-stop 本应用后同点就能启动 | `WindowState.getTouchOcclusionMode()` 只对 system alert window 返回 `USE_OPACITY`，其余（含 1003）是 `BLOCK_UNTRUSTED`；NOT_TOUCHABLE 的**全屏**子窗仍会遮挡下层 untrusted 窗口 | 1003 子窗**不要全屏**；裁剪到可见并集 + 小边距（6 px）；用「child 外 launcher 图标可启动」作为穿透验收，不要只用状态栏下拉（system window 是 trusted，会掩盖问题） |
| 5 | 拖动时宠物离开旧框就不可见，松手才恢复 | 原生在 portal 手势 active 时连**子窗裁剪**也一起早退，子窗停在拖动前的大小 | 子窗 NOT_TOUCHABLE，手势期间可以继续跟随（只延迟 portal 到 ACTION_UP）；`applyChildBounds` 放在 `touchActive` 早退之前 |
| 6 | 子窗从小窗扩到全屏时出现白色/纯背景块 | 白 surface 来自**子窗窗口自己的 surface**，只把 WebView `alpha=0` 不够 | 大幅**尺寸**变化时隐藏整个子窗（`rootParams.alpha=0`），等内容画好再显示；只按尺寸判定，位置移动不要隐藏 |
| 7 | 看门狗/隐藏后子窗一直 alpha 0，宠物彻底不可见 | 把位置变化也算进「大幅变化」，页面 50 ms 一报就反复 hide；hide 每次先 `revealToken++`，旧 reveal 被不断作废 | `bigResize` 只按宽/高（>200 px 或 >25%、面积比 >2）；只有 alpha 1→0 时重置 token；alpha 已 0 时再 hide 直接返回；250–300 ms 看门狗强制显示 |
| 8 | 点击宠物后先闪出**菜单背景色**（cream），菜单内容晚到 | `openPhoneMenu` 为防开屏误点给整页 sheet 层 `pointer-events:none` 220 ms；50 ms hit-shape 循环把所有 `pointer-events:none` 跳过 → sheet 整页矩形晚约 268 ms 上报 → 子窗仍宠物大小，sheet 在**小窗**里动画，cream 背景先出现，随后才 resize | 输入锁 ≠ 不可见：循环对 `.qp-sheet` 豁免 pointer-events 过滤；sheet 整页矩形必须在开屏后 ≤1 个 tick 到达原生 |
| 9 | 菜单首帧内容对比度低/像一块纯背景 | `qp-rise` 从 `opacity:0.4` 淡入，卡片背景先被看见 | 可见内容的 rise 动画只做位移，不做透明度淡入；内容与背景首帧一起出现 |
| 10 | 尝试「pointerdown 预扩窗口」后，tap 不打开菜单 | 真实设备上 touch stream 还活着时子窗 hide/resize 会取消这次手势；模拟器 A/B 的 preload 没暴露 | 不要在 pointerdown 预扩；让 sheet 打开后自己的整页矩形驱动 resize。若必须预扩，做 page→native 就绪握手，且手势期间绝不 hide |
| 11 | 拖动/长按/点击偶尔全部失效，但点击正常或重载恢复 | 手势期间移动/移除 portal 窗口会切断系统手势流 | 手势 active 时 portal 只 `updateViewLayout` 不 remove/add；移动等 UP/CANCEL；跨 portal 多指是两条独立手势流 |
| 12 | 模拟器上坐标对不上（`dumpsys window` 与 `dumpsys input` 差一倍/偏移） | `dumpsys window` 是逻辑坐标；`dumpsys input` 是物理显示坐标，可能带 `WindowedMagnification`/旋转的 display transform | 用 `dumpsys input` 的 display transform 换算；页面 CSS × `web.layoutParams.width/innerWidth`；不要拿两套原始坐标直接比 |
| 13 | 单元测试全绿但真机仍有白闪/裁剪/穿透问题 | 这些是窗口管理器/合成器/触摸分发行为，vm 夹具测不到 | 视觉/窗口类改动必须 60fps 录屏逐帧 + `dumpsys window/input` + 真实触摸；把「首帧内容」「blankBlock」「child 外观」作为量化验收 |
| 14 | 电脑端（Linux）气泡文字发虚、宠物拖动卡顿/闪烁 | Linux 的 `win.setShape` 是**渲染裁剪**，由 50 ms hit-shape 循环驱动；循环在可见性判断前无条件对每个 `[data-hit] *`（含大量隐藏节点）调用 `getComputedStyle(el).pointerEvents`，主线程反复 style/layout，窗口 shape 更新滞后 → 气泡边缘/文字发虚、拖动时 shape 抖动闪烁 | 先 `hitTargetVisible(el)` 再读 `pointer-events`；不可见元素绝不强制 `getComputedStyle`。桌面 Linux 必须与 Android 一起手测，不能只测移动端 |

## 3. 调试与验收最佳实践

### 3.1 先建立坐标系

- 页面：`innerWidth/innerHeight`、`devicePixelRatio`、`body.qp-phone`、`#pet`/`[data-hit]` 的 `getBoundingClientRect()`。
- 原生窗口：`adb shell dumpsys window windows`，看 `mAttrs` 的 `(x,y)(w×h)`、`ty`、`alpha`、`fl`、`Frames`；`mAttrs` 是逻辑 px。
- 输入：`adb shell dumpsys input` 的 `frame`、`touchableRegion`、`inputConfig`、`alpha`、`touchableRegion`；这是物理 px，按显示 transform 换算。
- 触控路径：页面可见像素 ≈ portal frame（逻辑） = child frame - 6 px（边缘）；子窗 `NOT_TOUCHABLE`、portal `NOT_TOUCHABLE` 不能有；child 的 `touchOcclusionMode` 应为 `BLOCK_UNTRUSTED`（这是为什么要裁剪）。

### 3.2 视觉类问题用录屏逐帧

```bash
adb shell screenrecord --time-limit 5 --bit-rate 20M /sdcard/tap.mp4
adb pull /sdcard/tap.mp4
ffmpeg -i tap.mp4 -vf fps=30 frames/f%03d.png
# 逐帧统计：亮区 lightMax、内容密度 density、纯白/纯 cream 大块；不要只看一张截图
```

- 「白块」判据：大面积亮区 + 内容密度接近 0；「菜单背景色块」则是 sheet 的 cream 区域铺满但无行内容。
- 点击测试至少覆盖：tap 开 sheet、sheet 行可点、back 关闭；拖动全程可见、松手贴身；sheet 首帧即含内容。
- 穿透测试用 **launcher 图标**（child 外可启动），不要只用状态栏；状态栏是 trusted system window，会给你假阳性。
- alpha cap 测试：`dumpsys input` 的 `alpha`、`mAttrs` 无 `alpha=0.8`、设备截图纯白像素是否 255；logcat 里 `setting alpha to 0.80` 的类型是否为 2038。

### 3.3 页面 hit-shape 循环的过滤规则

- 只有「真的不可见」才能丢：`display:none`、`visibility:hidden`、`opacity:0`、零尺寸。
- **先判可见，再读 `pointer-events`**：`getComputedStyle` 会触发布局/样式计算；桌面的 50 ms `setShape` 循环不要对不可见子树做无谓读取，否则 Linux 窗口 shape 会滞后，气泡发虚、拖动闪烁（见坑点 14）。
- `pointer-events:none` 只表示**不接收输入**，仍然可能占满屏幕（sheet 开屏锁、过渡层）；这类层必须上报矩形，否则原生窗口不会扩。
- WebView 版本较老时 `Element.checkVisibility` 可能不存在；回退到 `display/visibility/opacity` 三读，不要让整个 50 ms tick 抛错。
- 新增任何「临时 input 锁」时，同时检查它是否被 hit-shape 循环过滤；写一条 vm 测试固定这个行为（参考 `scripts/tests/pet-drag.test.mjs` 的「opening sheet layer even while it ignores input」）。

### 3.4 原生窗口隐藏/恢复

- 只对**尺寸**大幅变化 hide；位置移动只更新 x/y + translation。
- hide 是**子窗窗口级** `LayoutParams.alpha=0`，不是只隐藏 WebView；hide 只允许 1→0 时重置 revealToken；alpha 已 0 时保留 pending reveal。
- 恢复要等内容画好；100 ms（sheet/旋转）/32 ms（拖动/收缩）是当前平衡；必须有 250–300 ms 看门狗，宁可偶发一帧背景也不能永久不可见。
- 任何「为了消白帧」的隐藏都要用 60fps 录屏验证：首帧是否已有内容、是否出现 launcher 长时间暴露、是否 alpha 卡死。

### 3.5 合并前验收清单

- 触控区 = 可见像素（站姿/躲藏/面板各测；误差 ≤1 采样格）。
- 透明区穿透：child 外 launcher 图标可启动；sheet 打开时全屏 modal 可接受。
- alpha：1003 子窗 1.0，无 0.8 cap；sheet 不透明。
- 手势：tap 开菜单、行可点、back；拖动全程可见、松手 child=portal+6；长按/多指不回归。
- 窗口：sheet/旋转/隐藏/IME 后 alpha 恢复 1.0；无永久 1×1/0.0。
- 视觉：tap 首帧含菜单内容，无纯背景块；无白闪；无长时间 launcher 暴露。
- 门禁：`npm run typecheck`、`npm run test:compat`、`npm run check:docs`、对应平台构建；真机/模拟器证据写入 `.agent-reports/acceptance/`。

## 4. 代码位置

- `android/app/src/main/java/net/ankio/qqpet/PetService.kt`：`syncPortalsUnchecked`（手势中 child 跟随、portal 延迟）、`applyChildBounds`（并集+6、translation）、`bigResize`（只按尺寸）、`hideChildForResize` / `revealChildAfterResize`（窗口级 alpha、看门狗）。
- `src/renderer/main.ts`：50 ms hit-shape 循环（`visiblePetBoxes`、`.qp-sheet` 豁免 pointer-events、`.ui-menu` 全页 catch-all）。
- `src/android/bridge.ts`：`setHitShape` 能力探测与 `setTouchableRegion` 调用。
- `src/renderer/ui/mobile/phone-menu.ts` / `sheet.ts` / `mobile.css`：sheet 输入锁、rise 动画（只位移、内容不淡入）。
- 回归测试：`scripts/tests/pet-drag.test.mjs`（页面矩形/pointer-events 豁免）、`scripts/tests/android-overlay.test.mjs`（child 裁剪/拖动跟随/隐藏恢复结构断言）。
