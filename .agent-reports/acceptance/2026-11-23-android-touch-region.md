# Android 宠物触控区贴合可见像素 · 最终独立验收（菜单首帧背景色修复后）

> 结论：**PASS（最终 APK，sha256 `823a07287c9e27dfda602a22e68f65a4fd6503a8718d0c8f4f478aff0b277f2d`）**。A–K 全部通过；拖动全程可见、松手 child=portal+6；**菜单首帧背景色修复有效**：tap 后 sheet 首个可见帧即含完整菜单内容（density 2.69–2.83%），修复前“cream 背景先在小窗里动画”的帧（base7 帧 46–52，7 帧、宠物尺寸窗、density 7.4–8.3%）在最终版 3 次独立 11–49 fps 录屏中 **0 帧**；tap 5/5 次打开 sheet、back 5/5 关闭（pointerdown 预扩取消 tap 的回归已消失）；K 门禁 tsc exit 0、测试 **62/62（android-overlay 12 + pet-drag 50）** exit 0。

## 0. 验收对象、环境与口径

| 项 | 值 |
|---|---|
| 包名 | `net.ankio.qqpet.touchprobe`（debug APK；数据内 Lv.16 测试宠物，未清数据） |
| APK（最终） | `tmp/android-touchprobe/app/build/outputs/apk/debug/app-debug.apk`，sha256 `823a07287c9e27dfda602a22e68f65a4fd6503a8718d0c8f4f478aff0b277f2d`（md5 `9e761163…`；设备 base.apk md5 一致，lastUpdateTime 19:03:40） |
| 版本 | versionName 0.20.0 / versionCode 2000，minSdk 30，targetSdk 35 |
| 设备 | emulator-5554，SM-G998B，Android 13（API 33），arm64-v8a |
| 逻辑显示 | 1080×2340 @ 420 dpi（dpr 2.625）；物理窗口 1920×1080、Viewport 498×1080@x=711（windowed magnification） |
| 坐标口径 | `dumpsys window` 逻辑 px；`dumpsys input` 物理窗口 px，按 `dumpsys input` 的 display transform 矩阵（含旋转）换算回逻辑 px |
| 验收者 | 独立 verifier，未参与实现；未修改 `src/**`、`android/**`、`docs/**`、`package.json`；写入仅 `tmp/reports/touch-range/verify/**` 与本报告 |
| 证据 | `tmp/reports/touch-range/verify/README.md`、`tmp/reports/touch-range/verify/evidence/**` |

架构（最终版）：1×1 `TYPE_APPLICATION_OVERLAY` token 父窗 → 页面 `TYPE_APPLICATION_ATTACHED_DIALOG(1003)` 渲染子窗，裁剪到页面 setHitShape 矩形并集 +6 px、`translation=-childOrigin`；每个（合并后）触控矩形一个 overlay portal 转发 MotionEvent；`setBounds` no-op；空矩形 800 ms 后缩 1×1。视觉修复：`bigResize` 只按尺寸（宽/高 >200 px 或 >25%、面积比 >2），隐藏整个子窗（`rootParams.alpha=0`）——sheet 扩张 100 ms、拖动/收缩 32 ms，300 ms 看门狗；仅 alpha 1→0 重置 revealToken。页面侧（本任务）：hit-shape 循环对 `.qp-sheet` 豁免 `pointer-events:none` 过滤；`qp-rise` 去掉 opacity 0.4 淡入；移除 pointerdown 预扩。

## 1. 逐项结论（最终 APK）

| 项 | 结论 | 关键数字 / 证据 |
|---|---|---|
| A 架构 | **PASS** | 1003 子窗 319×227（屏幕 2.87%）、margin 6/13/6/6；无 alpha=0.8、Surface alpha 1.0；输入 `NOT_TOUCHABLE, alpha=1.00`；portal overlay 可触 alpha 1.00；host 1×1。`evidence/a-architecture.json` |
| B 可见区 | **PASS** | 站姿：可见 306.25×206.33 vs portal 307×208，差 **0.96 px**（触控区 1.12）；躲藏：可见 99.32×244.78 vs portal 100×246，差 **0.91 px**（触控区 2.59）；容差 7.86 px。子窗 319×220 / 114×258。`evidence/b-live-b-stand.json`、`b-live-b-hide-right.json` |
| C 交互 | **PASS** | tap 宠物 → `.qp-sheet`（Lv.16，card `rgb(253,247,234)`）→ 清洁页（1925/2600，本轮库存已耗尽显示“暂无物品”空态，`cleanPageRendered:true`，`itemTapChangesClean:null`）→ back 关闭、焦点回 launcher；sheet 期间 child/portal 全屏。`evidence/c-interaction.json` |
| D 不透明 | **PASS** | 截图卡片 3 点 (253,247,234) == CSS，alpha 255；旧证据同点 (202.6,198,187.5) ≈ 80% 混合。`evidence/d-opacity.json` |
| E 穿透 | **PASS** | 状态栏下滑 → NotificationShade；child 外 launcher 图标 → `org.galexander.sshd`；死区 `Windows: <none>`、页面 0 事件、焦点不变；拖宠物压图标→不可启动，拖走后同点 → camera；sheet 全屏→行可点→关闭缩回。死区 **5,781 px²（屏幕 0.229% / child 8.0%）**，ring margins 6.51/4.34/4.33/6.5。`evidence/e-passthrough.json` |
| F 拖动 | **PASS** | lastX 58.378→81.236、lastY 544.836→475.884；portal 跟随新可见像素；child 320×219、margin 6/6/6/6；child 远小于拖路径包围盒。`evidence/f-drag.json` |
| G IME | **PASS** | 聊天输入框被 portal 覆盖；`mServedView=android.webkit.WebView`、`mInputShown=true`；`input text hello` → value=hello；back 隐藏 IME 并关闭聊天。`evidence/g-ime.json` |
| H 旋转 | **PASS** | 竖 (1080×2340, page 412×892, child 320×219, portal 308×207, 差 0.94 px) → 横 (2340×1080, page 892×412, child 319×219, portal 307×207, 差 **0.47 px**) → 恢复竖屏；rotation 设置恢复。`evidence/h-rotation.json` |
| I hidden | **PASS** | 通知动作 隐藏宠物/显示宠物：隐藏后 body.petHidden/save.settings.hidden true、portal 0、child 1×1、input touchableRegion `<empty>`、页面无绘制；显示后 portal 回建、child 真实尺寸、重新绘制。`evidence/i-hidden.json` |
| J 无 alpha cap | **PASS** | logcat 4 条 “setting alpha to 0.80” 全部 `type = 2038`（1×1 system alert token 窗），无 1003/attached dialog；无 portal 回退错误；宠物截图 max 255。`evidence/j-alpha.json`、`j-logcat.txt` |
| K 测试 | **PASS** | `npx tsc --noEmit -p tsconfig.web.json` exit 0；`node --experimental-strip-types --test scripts/tests/android-overlay.test.mjs scripts/tests/pet-drag.test.mjs` exit 0，**62/62 pass（12 + 50）**。`evidence/k-tsc-web.log`、`k-node-tests.log` |

## 2. 菜单首帧背景色（本任务核心）

### 2.1 根因与修复（page-dev/lead 定位）

`openPhoneMenu` 给整页 sheet 层 `pointer-events:none` 220 ms 防开屏误点；50 ms hit-shape 循环把 `pointer-events:none` 的元素全部跳过 → sheet 整页矩形晚约 268 ms 上报 → native 渲染子窗仍是宠物大小，sheet 的 cream 背景先在小窗里动画，随后才 resize。**不是**动画/合成层/native 延迟。

修复：① hit-shape 循环对 `.qp-sheet` 豁免 `pointer-events` 过滤；② `qp-rise` 去掉 opacity 0.4 淡入；③ 移除 pointerdown 预扩（真实设备会取消 tap、sheet 不打开）及其测试。

### 2.2 逐帧对照（`video_metrics.py`）

度量：`lightMax`=min(R,G,B)≥225 经 9×9 闭运算后的最大连通亮区；`density`=其 bbox 内 min<180 的内容像素/面积；`blankBlock`=lightMax≥100 000 且 density<1.5%；另统计橙色宠物签名（R≥170, 80≤G≤190, B≤130, R≥G+40）与 mean 亮度。

| 录像 | fps | 帧数 | 宠物尺寸小窗 cream 块 | 子窗隐藏帧 | 首个菜单帧（内容 density） | 空白块 |
|---|---|---|---|---|---|---|
| 修复前 `tmp/reports/touch-range/base7.mp4` | 53.1 | 266 | **帧 46–52（7 帧）**：lightMax 51,135→56,524，box `[381,658,319,227]`=宠物尺寸窗，density 7.4–8.3%，mean 17.9–18.0 | 帧 40–45 / 53–58（合计 12 帧） | 帧 59，density 2.685% | 0（按 pure cream 大面积空白定义） |
| lead 修复后 `tmp/reports/touch-range/finalpage.mp4` | 48.1 | 235 | **0** | 帧 20–23（4 帧） | 帧 24，density **2.778%** | 0 |
| verifier 最终 `video-tap-final.mp4` | 48.0 | 288 | **0** | 帧 21–24（4 帧） | 帧 25，density **2.756%** | 0 |
| verifier 最终 `video-tap-final-2.mp4` | 49.3 | 296 | **0** | 帧 25–30（6 帧） | 帧 31，density **2.825%** | 0 |
| verifier 最终 `video-tap-final-3.mp4` | 11.1 | 34 | **0** | 帧 27–29（3 帧） | 帧 30，density **2.690%** | 0 |

- 修复前 base7 的 cream 小窗帧正是“菜单背景色先出现、内容后到”：7 帧（~132 ms）里 sheet 的 cream 背景画在 319×227 的宠物尺寸子窗内（lightMax 51k–56k、density 7.4–8.3%），之后子窗 resize；最终版 3/3 次独立录屏 **0 帧**该类小窗 cream 块，首个可见菜单帧即含 header/快捷瓦片/行（density 2.69–2.83%）。
- 最终版仍存在 3–6 帧子窗隐藏（sheet 扩张 100 ms 的 hide + 看门狗），随后**首帧即完整菜单**；这与修复前“cream 小窗动画→隐藏→全屏菜单”的序列不同，前者不出现无内容的 sheet 帧。lead 的 “finalpage 无隐藏帧” 与本 verifier 解码出的 4 帧子窗隐藏略有差异（解码/播放器帧号不同），但“首个可见 sheet 帧即含内容、无 cream 大块”的结论一致。
- 纯白（min≥250）块：所有录像 0 帧（base7 与最终版均无整屏/child 区纯白块）。

### 2.3 tap 必须打开 sheet（防 pointerdown 预扩回归）

| 轮次 | tap 点（device px） | sheet 打开 | 标题 | back 关闭 |
|---|---|---|---|---|
| 1 | (399.6,1803.5) | ✅ | QQ宠物 | ✅ |
| 2 | (399.6,1803.5) | ✅ | QQ宠物 | ✅ |
| 3 | (399.6,1799.7) | ✅ | QQ宠物 | ✅ |
| 4 | (399.6,1795.8) | ✅ | QQ宠物 | ✅ |
| 5 | (399.6,1799.7) | ✅ | QQ宠物 | ✅ |

- 5/5 打开、5/5 back 关闭（`evidence/tap-reliability-final.json`）；sheet 行导航（清洁 shortcut→清洁页；和我聊天 row→聊天，G）正常。
- **“pointerdown 预扩会取消 tap”最小复现（修复前后）**：修复前页面在 pointerdown 时预扩渲染子窗（触发 resize/hide-reveal），真实设备上该手势被取消（tap 后 sheet 不打开、宠物无响应）；最终版移除 pointerdown 预扩后，同一设备/同一注入 tap 5/5 次打开 sheet。该预扩逻辑已按 lead 说明移除；测试文件相应调整为 50 条（pet-drag，修复三时 49 条），最终 K 62/62 通过。
- 说明：本轮清洁库存（雨刷）已在前序轮次耗尽，清洁页显示“暂无物品”空态；因此 C 的 `itemTapChangesClean` 记为 `null`（不伪造），行导航效果由清洁 shortcut 打开页面与 G 的“和我聊天”行覆盖。

## 3. 视觉回归修复迭代（修复前 → 修复一 → 修复二 → 修复三 → 最终）

| 构建 | sha256 | 结论 | 证据 |
|---|---|---|---|
| 修复前 | `dbc58f16…` | A–K 通过，但 tap 每次 2 帧空白亮块（`tap2.mp4` 帧 32/33，mean 66.3，580k，density 0.85%）；拖动连续 68 帧宠物不可见（`drag2.mp4`） | `tap2.mp4`、`drag2.mp4` |
| 修复一 | `e61ecb60…` | **FAIL（视觉）**：仅 hide WebView，tap 仍 6/7 次 1–2 帧空白卡片块（mean 66–117、light 291k–1.16M、density 0–0.54%）；拖动已修复 | `fix1-visual-fail.md`、`fix1-visual-summary.json`、`video-tap*.mp4`/`video-tap-low-*.mp4` |
| 修复二 | `c4b5473b…` | **被 lead 拒绝**：`big` 把位置变化计入 → 每 50 ms hide、revealToken 反复重置、alpha 卡死 0.0，宠物不可见 | 本 verifier 未安装/未验证；lead/native-dev 最小复现：启动 3 s child (681,652)(319×327)、`mAttrs alpha=0.0`、宠物不可见 |
| 修复三 | `fa78048a…` | A–K 通过；tap 5 次录屏 4 次 0 帧、1 次 1 帧残留（与修复前同 bbox，~20 ms）；拖动 0 白块 | `video-tap-fix3*.mp4`、`video-tap-fix3*-metrics.json`、`video-drag-fix3*` |
| **最终** | **`823a0728…`** | **PASS（本报告）**：菜单首帧色修复后 tap 3/3 次 0 cream 小窗块、0 空白块、首帧含内容；A–K + 拖动通过 | 见第 1/2 节与第 6 节索引 |

修复二环境只读观察（非本 verifier 安装）：17:39:44 设备被并行流程更新为 md5 `42d1c069…`（= 工作区 fix2 APK，sha `c4b5473b…`）；当时 `dumpsys window` 显示 `QQPet render` 为 **1×1**（`ty=APPLICATION_ATTACHED_DIALOG`，Surface alpha=1.0），页面 `body=faceHint qp-phone`、`hidden=false`、`#pet` 矩形已绘制、无 sheet → 宠物不可见。与 lead 描述的 alpha/裁剪卡死失败模式一致，仅记录，未做复验。

## 4. 命令与退出码（最终 APK）

| 命令 | 退出码 | 说明 |
|---|---|---|
| `node tmp/reports/touch-range/verify/step-a.mjs` | 0 | A（`pass:true`） |
| `node …/compare-b.mjs b-stand` / `b-hide-right` | 0 / 0 | B（`pass:true`，稳定姿态采样） |
| `node …/step-c.mjs` | 0 | C（`pass:true`，清洁页空态 `cleanPageRendered`） |
| `node …/step-d.mjs` | 0 | D |
| `node …/step-e.mjs` | 0 | E（死区 5,781 px²、穿透、sheet；`pass:true`） |
| `node …/step-f.mjs` | 0 | F |
| `node …/step-g.mjs` | 0 | G |
| `node …/step-h.mjs` | 0 | H（结束恢复旋转设置） |
| `node …/step-i.mjs` | 0 | I（通知动作隐藏/显示） |
| `node …/step-j.mjs` | 0 | J（logcat 4 条 2038 alpha cap，无 1003） |
| `node …/record.mjs tap|drag` + `video_metrics.py` | 0 | 录屏与逐帧度量（第 2 节；tap 5/5 打开、拖动 child=portal+6） |
| `npx tsc --noEmit -p tsconfig.web.json` | 0 | K |
| `node --experimental-strip-types --test scripts/tests/android-overlay.test.mjs scripts/tests/pet-drag.test.mjs` | 0 | K：62/62（12+50） |

## 5. 未覆盖 / 失败项

- 最终 APK A–K 无失败项；菜单首帧背景色主判据通过（3/3 次 0 cream 小窗帧，首个菜单帧 density 2.69–2.83%）。
- 未覆盖：跨 portal 多指手势统一性；其他 ROM/Android 版本（BLOCK_UNTRUSTED/alpha cap 为 AOSP 行为，仅 Android 13 模拟器验证）；长时 soak/性能；TalkBack 无障碍实测；修复二的独立复验（按 lead 指示未安装）；最终版 tap 录屏 3 次（其中 1 次 34 帧低帧率）统计置信度有限。
- 清洁库存耗尽导致 C 的消耗型行检查无法复测（`itemTapChangesClean:null`，未伪造）；行导航已由清洁页打开 + 聊天行覆盖。

## 6. 遗留风险

1. sheet 扩张时子窗按设计隐藏 3–6 帧（~80–120 ms，100 ms hide + 300 ms 看门狗），随后首帧即完整菜单；若用户对“宠物/页面短暂停顿”敏感，可感知为极短停顿，但不再出现 cream 背景先行的帧。
2. 拖动/收缩边界 1–4 帧子窗隐藏（32 ms + 看门狗）可能被感知为极短闪烁。
3. 旧页面不调用 `setTouchableRegion` → 子窗 1×1、宠物不可见（fail-closed）。
4. portal 失败 fail-closed（宠物可见不可触）。
5. 有界死区：child − portal ≈ 5,781 px²（0.229% 屏幕 / 8.0% child；随姿态/矩形数变化，本采样为干净站姿）。
6. 拖动/sheet 期间 child 全屏（预期）；旋转瞬态先全尺寸再裁剪。
7. host 1×1 overlay alpha 0.8 仅 token 窗。
8. windowed-magnification 模拟器环境，其他显示缩放/窗口模式需重校验坐标。
9. 某些交互序列后宠物拖动可能停止响应（点击正常、重载恢复），本轮未复现，保留观察。

## 7. 证据索引

| 路径（相对 `tmp/reports/touch-range/verify/`） | 内容 |
|---|---|
| `README.md` | 复跑说明、脚本清单、修复迭代摘要 |
| `evidence/a-architecture.json`、`dumpsys-*-a-arch.txt` | A 架构与原始 dumpsys |
| `evidence/b-live-b-stand.json`、`b-live-b-hide-right.json` | B 两组数字 |
| `evidence/c-interaction.json`、`c-*.png` | C 交互（清洁页空态） |
| `evidence/d-opacity.json`、`d-sheet.png` | D 不透明 |
| `evidence/e-passthrough.json`、`e-fixed-*.png`、`e-fixed-deadzone-touchstate.txt` | E 穿透/死区/sheet |
| `evidence/f-drag.json`、`f-*.png` | F 拖动 |
| `evidence/g-ime.json`、`g-*.png` | G IME |
| `evidence/h-rotation.json` | H 旋转 |
| `evidence/i-hidden.json`、`i-*.png` | I hidden |
| `evidence/j-alpha.json`、`j-logcat.txt`、`j-pet.png` | J alpha cap |
| `evidence/k-tsc-web.log`、`k-node-tests.log` | K 门禁（62/62） |
| `evidence/video-tap-final.mp4`、`video-tap-final-2/3.mp4`、`*-metrics.json`、`video-frames-tap-fixed/` | 最终版 tap 录屏与逐帧度量/帧图（含 base7/finalpage 对照） |
| `evidence/video-drag-final.mp4`、`video-drag-final-metrics.json`、`video-drag.json` | 最终版拖动（child=portal+6） |
| `evidence/tap-reliability-final.json` | 5/5 tap 打开、5/5 back 关闭 |
| `evidence/fix1-visual-fail.md`、`fix1-visual-summary.json`、`video-tap*.mp4`、`video-tap-low-*.mp4` | 修复一 FAIL 存档 |
| `tmp/reports/touch-range/base7.mp4`、`finalpage.mp4`、`tap2.mp4`、`drag2.mp4` | 修复前/lead 修复后基线 |

复跑：安装 `adb install -r <apk>` → `appops set net.ankio.qqpet.touchprobe SYSTEM_ALERT_WINDOW allow` → `am start -n net.ankio.qqpet.touchprobe/net.ankio.qqpet.MainActivity`；`node tmp/reports/touch-range/verify/step-<a..j>.mjs`、`record.mjs tap|drag` + `video_metrics.py`、K 两条命令。验证前 `am force-stop net.ankio.qqpet; am force-stop net.ankio.qqpet.probe; am force-stop net.ankio.attachprobe; am force-stop net.ankio.hiddenprobe` 清场（只 force-stop，不卸载）。
