# 手机全页面适配 r2 独立验收（emulator-5554，412×892 dp）

> 结论：**验收项 7 项中 6 PASS、1 FAIL**；被点名的 13 个页面中 **11 PASS、1 FAIL（旅行）、1 部分未验证（邮箱详情，收件箱为空）**。入口完整性、真实触摸、返回键、反例、四道门禁全部通过；唯一页面级失败是旅行页「去旅行 / 停止旅行」按钮只有 **30 dp** 高（CSS 命中的是容器 `.toTarvelBut`，不是按钮本身 `.but_normal`）。另有 1 项环境级异常（到达时 PetService 悬浮窗卡在旧 bounds、宠物被裁切）和 1 个交互副作用（连点宠物第二下会命中打开后的首行菜单）需要单列跟进；本轮只写本文件，未改实现代码。

## 0. 验收对象、设备与方法

- **安装包**：`net.ankio.qqpet` versionName **0.10.0**、versionCode 1000（debug，任务给定的 14:03 构建）。宠物已领养（Lv.1，蛋形态），save 未动。
- **设备**：emulator-5554；物理 1080×2340 / 覆盖 1080×2340、density 420；WebView `innerWidth 412 × innerHeight 892`、`dpr 2.625`、`body.qp-phone`。
- **验收对象边界**：lead 在 14:0x 之后又改了 `box.ts`（openFrame 的返回键/dismiss/`onClose`）与农场地块排序，**这两处未装到设备**，本报告结论只对已安装构建负责；这两条需另行复验。
- **方法**：
  - `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + `node tmp/mobile/probe.mjs`（CDP 测量/截图）。
  - 「真实触摸」一律用 `adb shell input tap <物理px>`（不是 JS click、不是 CDP dispatch）；坐标 = dp × 2.621359。
  - 每页目标尺寸用两种口径互证：`probe.mjs measure`（cursor/role 判定）与**点击监听判定**（`getEventListeners(el).click`，覆盖自定义手型 cursor 的 `.qp-btn/.but_normal` 等，避免漏计）。
  - 每页断言：可见正文字号 ≥13 px（=dp）、可点目标短边 ≥44 dp、`documentElement.scrollWidth-clientWidth = 0`、能关闭。
  - 未执行 install / force-stop / 清数据 / 改 wm size；旋转仅用 `settings put system user_rotation 1/0`（任务允许）。

### 0.1 到达时的环境异常与恢复（非本轮改动）

到达时 App 进程在跑（pid 20046）但悬浮窗卡在**旧 bounds**：主窗 326×381 px、页面宠物实际在 122,362 dp（438×438 px），屏上只剩一块被裁的蛋；页面内 `QQPetNative.setBounds(...)` 重发无效（native 的 first-reveal `target` 闩锁等待 frame commit，始终没触发）。没有用 force-stop/重装：从通知「退出」→ 再次点图标启动 PetService 后恢复，之后全部用例在 pid 20046 上完成。该现象与本轮 UI 改动无关（Kotlin 宿主路径），但属于「用户把 App 放后台后被系统重启 service」时可能复现的可靠性问题，见 §6。

## 1. 验收项结论

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 入口完整性（18 顶级行/行高/字号/overflow） | **PASS** | 18 行全在；每行 **412×56 dp**、字号 **15 px**、`overflowX=0`；含 签到/任务/邮箱/打工/学习/旅游/看病/休息一下/去朋友家送信；分组为 互动 9 / 工具 3 / 养成 3 / 设置 1 / 危险操作 2；5 个快捷瓦片含「玩具」。截图 `/tmp/qqpet-r2-menu.png` |
| 2 | 逐页打开并测量 | **FAIL（1/13 页）** | 13 页中 11 PASS；旅行页 2 个主按钮 30 dp；邮箱详情因收件箱 0 封未验证。逐页见 §2 |
| 3 | 真实触摸 ≥3 项 | **PASS（3/3）** | ① `adb tap 539,1168` 轻点宠物 → 菜单 18 行；② 滚动后 `adb tap 540,1407` 点「签到」行 → 签到 sheet；③ `adb tap 540,715` 点「今日签到」→ 文案变「今天已经签到啦 / 本月已累计签到 1 次」。无不可点/中断 |
| 4 | 返回键关闭并复开 | **PASS（13/13 面板）** | 签到、任务、邮箱、档案、游戏大厅、企鹅岛、农场、旅行、打工、学习、商城、聊天、设置：`input keyevent 4` 关闭后再次打开均成功，关闭后无残留层；全程 **pid 20046 → 20046**。注意：签到页第一次 back 未被消费，第二次才关（见 §6，1/13 次） |
| 5 | 反例 4 条 | **PASS（4/4）** | 见 §4：连点 5 次最多 1 层；面板打开时点宠物无新面板；横→竖旋转菜单与宠物都在（宠物 rect 前后均为 122,362,167.1）；系统设置→桌面→回 App 菜单与宠物都在、pid 不变 |
| 6 | 门禁复跑 | **PASS（4/4，exit 0）** | `typecheck` 0；`test:compat` 962 pass / 2 skipped / 0 fail（按任务要求排除 `lan.test.mjs`）；`test:docs` 106 pass；`check:docs` 0。详见 §5 |
| 7 | 复核 06-triage 判定表 | **完成** | 7 条不一致/需修正，见 §7 |

## 2. 逐页测量（安装构建实测）

| 页面 | 入口 | 标题/形态 | 可见正文最小字号 | 可点目标（短边） | overflowX | 关闭 | 结论 |
|---|---|---|---|---|---|---|---|
| 签到 | 工具→签到 | sheet `qp-signin-sheet` | 13 px | 5 个目标全 ≥44；「今日签到」**362×56** | 0 | back ✓ 复开 ✓ | **PASS** |
| 任务 | 工具→任务 | sheet `qp-task-sheet` | 13 px | 5 个目标全 ≥44；领取键 **96×44**（当前 4 条未达成，显示「未达成」占位，可见可点） | 0 | ✓ 复开 ✓ | **PASS** |
| 邮箱 | 工具→邮箱 | sheet `qp-email` | 13 px | 空态：关闭/翻页/一键领取/一键删除均 ≥44（翻页 104×44；当前 disabled 无点击监听） | 0 | ✓ 复开 ✓ | **部分**：收件箱 0 封，「进详情再返回」**未验证**（无法造数据） |
| 宠物档案 | 菜单头部（头像/等级） | sheet `qp-petinfo-sheet` | 13 px | 5 个目标全 ≥44；保存键 ≥44 | 0 | ✓ 复开 ✓ | **PASS** |
| 游戏大厅 | 互动→活动→游戏 | sheet `qp-games` | 13 px | 15 个目标全 ≥44；开始键 **72×44**；分类 chip 44；7 chip 横向可滚（743 vs 412） | 0 | ✓ 复开 ✓ | **PASS** |
| 企鹅岛 | 互动→活动→企鹅岛 | sheet `qp-island`（footer 固定） | 13 px | 17 个目标全 ≥44；接信/交谈/聊天/领成长礼/领宝藏碎片/刷新新闻/去商店/玩游戏均 ≥44 | 0 | ✓ 复开 ✓ | **PASS** |
| 农场 | 互动→活动→农场 | sheet 农场（种子/地块/操作） | 13 px | 30 个目标全 ≥44；地块 **186×72**、两列（x=16/210）；操作键 **48×44** | 0 | ✓ 复开 ✓ | **PASS**（地块排在种子/化肥之后，首屏看不到；lead 的后续排序修复待复验） |
| 旅行 | 互动→旅游 | sheet `qp-travel-card` | 13 px | 5 个目标中 **2 个 FAIL**：「去旅行」**68×30**、「停止旅行」**84×30**；tab 92/62×44 | 0 | ✓ 复开 ✓ | **FAIL**（主操作 <44 dp） |
| 打工 | 互动→打工 | sheet 打工（商品卡+分页） | 13 px | 7 个目标全 ≥44；卡片 412×134+；分页 104×44；1/6→2/6 | 0 | ✓ 复开 ✓ | **PASS** |
| 学习 | 互动→学习 | sheet 学习（商品卡+分页） | 13 px | 7 个目标全 ≥44；分页 104×44；1/3→2/3 | 0 | ✓ 复开 ✓ | **PASS** |
| 商城 | 养成→打开商城 | sheet 商城 | 13 px | 17 个目标全 ≥44；tab/分类换行全可见（属性/装扮在第二行） | 0 | ✓ 复开 ✓ | **PASS** |
| 聊天 | 互动→和我聊天 | framed `.box.qp-panel` 389×559 | **15 px** | 2 个目标全 ≥44（关闭/发送） | 0 | ✓ 复开 ✓ | **PASS** |
| 设置 | 设置帮助→系统设置 | framed `.boxFrame` 379×714 | 13 px | 16 个点击目标全 ≥44；关闭键 `.sclose` **44×44**；开关行 48–109 dp；7 个标签换行全可见 | 0 | ✓ 复开 ✓ | **PASS** |

补充：相簿 tab 能切（`.travelTab.on` 切到相簿、地图 pane `display:none`），但当前账号 0 张照片、空态，2 列网格与 12 px 说明**未验证**；签到日历、任务分页等滚动内容用代表行 + 全量子元素点击监听互证。

### 2.1 测量 JSON 摘要（点击监听口径，`/tmp/r2-<page>-hits.json`）

```json
{"menu":{"n":16,"minFont":13,"overflowX":0,"small":0},
 "signin":{"n":5,"minFont":13,"overflowX":0,"small":0},
 "task":{"n":5,"minFont":13,"overflowX":0,"small":0},
 "email":{"n":1,"minFont":13,"overflowX":0,"small":0},
 "games":{"n":15,"minFont":13,"overflowX":0,"small":0},
 "island":{"n":17,"minFont":13,"overflowX":0,"small":0},
 "farm":{"n":30,"minFont":13,"overflowX":0,"small":0},
 "travel":{"n":5,"minFont":13,"overflowX":0,"small":2},
 "work":{"n":7,"minFont":13,"overflowX":0,"small":0},
 "study":{"n":7,"minFont":13,"overflowX":0,"small":0},
 "shop":{"n":17,"minFont":13,"overflowX":0,"small":0},
 "chat":{"n":2,"minFont":15,"overflowX":0,"small":0},
 "setup":{"n":16,"minFont":13,"overflowX":0,"small":0}}
```

- 菜单 18 行（含屏下滚动行）单独用全量 cursor 口径复测：18/18 行 `h=56`、`font=15`、`w=412`，36 个可点元素短边全部 ≥44（`/tmp/qqpet-r2-menu-measure.json`、`/tmp/qqpet-r2-menu.json` 观察值）。
- 旅行失败项原文：`but_normal fcc mr8 | 去旅行 | 68×30`、`but_normal fcc disable | 停止旅行 | 84×30`（`/tmp/r2-travel-hits.json`）。CSS `body.qp-phone .qp-travel-card .toTarvelBut{min-height:48}` 抬高的是外层容器，内层按钮仍是 30 px。

## 3. 真实触摸记录（adb input tap，非 JS click）

1. **轻点宠物开面板**：宠物中心 (205.5,445.5) dp = (539,1168) px → `.qp-sheet` 出现，18 行菜单。
2. **点「签到」行**：菜单 body 滚 588 px 后，签到行中心 (206,536.6) dp = (540,1407) px → 打开 `qp-signin-sheet`，标题「签到」。
3. **点今日签到**：(206,272.6) dp = (540,715) px → `今天已经签到啦`，`本月已累计签到 1 次`，按钮变「已签到」。

3/3 命中，无中断/无遮挡导致不可点。

## 4. 反例与状态用例

| 用例 | 结果 |
|---|---|
| 宠物坐标连点 5 次 | 任意时刻最多 **1 层**（sheet 或 box），无叠加。逐次状态：tap1 菜单 sheet；tap2 因菜单已覆盖宠物位置，命中「和我聊天」行 → 打开聊天 box；tap3–5 无变化。**但 tap2 暴露了双击误触**（见 §6） |
| 面板打开时点宠物 | 聊天 box 打开时，在宠物坐标 tap → 仍是同一个聊天 box，无新面板、无菜单、无气泡 → 宠物点击被面板消费，**PASS** |
| 横屏再回竖屏 | 菜单打开 → `user_rotation 1`：`892×412`、菜单仍在、18 行、`overflowX=0`；回 `user_rotation 0`：`412×892`、菜单仍在、宠物 rect `122,362,167.1` 与旋转前一致 → **PASS** |
| 切后台再回来 | 菜单打开 → `am start -a android.settings.SETTINGS`（焦点在 Settings 时菜单与宠物仍在）→ Home → `am start MainActivity`：菜单与宠物都在，pid 20046 不变 → **PASS** |

## 5. 门禁复跑（工作区 14:2x 状态；含 lead 之后 2 处未装机改动）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | **exit 0**（node/web/harmony/e2e 四套 tsc） |
| `npm run test:compat`（排除 `scripts/tests/lan.test.mjs`） | **exit 0**：964 tests、962 pass、2 skipped、0 fail。排除原因：该用例建立真实 LAN/UDP 监听，按任务要求与 06-triage §4 的沙箱口径排除；本次未运行它，属“按指示排除”而非“已验证不挂” |
| `npm run test:docs` | **exit 0**：106 tests、106 pass、0 fail |
| `npm run check:docs` | **exit 0**：`文档检查通过：目录结构、索引、链接与代码引用均有效。` |

注意：门禁跑的是**当前工作区源码**（包含上述 2 处未装机改动），因此它们证明的是“源码树可过门禁”，不是“14:03 APK 的逐字节等价物”。

## 6. 与 06-triage 判定表的不一致（逐条）

1. **旅行“已修”不成立**：真机「去旅行/停止旅行」仅 **30 dp**，低于本轮 44 dp，也低于 triage 自己的 40 dp 口径；相簿说明 12 px 也低于本轮 13 px（本账号无照片，未实测）。
2. **游戏大厅“进行中（手机分类 + 游戏卡）”已过时**：安装构建已是完整 sheet（7 chip 可横滚、开始键 44 dp、列表可滚），不是“只见 56%”。结论方向（原来不可用）没错，状态落后。
3. **签到/任务/邮箱/企鹅岛/档案“进行中/需优化”已过时**：安装构建均已手机化（签到今日按钮 362×56、任务领取 96×44、企鹅岛 footer、档案两列）；邮箱空态 44 dp，但详情路径因 0 封邮件未验证。
4. **农场“已修：地块两列 + 操作按钮”只对了一半**：两列（186×72）与 48×44 操作键属实，但地块排在 20 种种子 + 5 种化肥**之后**，首屏看不到；lead 的后续 CSS order 修复（未装机）正是补这一点。
5. **“设置标签条 / 商城分类条 已修：换行全可见”与真机一致**：设置 7 个标签、商城 9 个分类 chip 都换行全可见；PASS。
6. **“max-width 全局回归已删”与真机一致**：13 个页面全部 `overflowX=0`，无右侧裁切；宽面板（设置 379、聊天 389、农场/企鹅岛/游戏/旅行）都在屏内。
7. **未覆盖/无法复核的条目**：领养（已领养，重新领养是破坏性操作，未做）、考试与结果弹窗、社区/密室/钓鱼/小游戏/丢丢乐/seeNum（本轮不在验收清单或缺少触发条件）→ 均标“未验证”，不把 triage 的“已修”当证据。

## 7. 阻塞项、风险与最该继续修的 3 条

**阻塞**：无。唯一页面级缺陷（旅行按钮 30 dp）不影响其它页；邮箱详情是验证缺口，不是环境阻塞。

**风险/观察（建议单列 issue）**：
- 到达时 PetService 悬浮窗卡旧 bounds、宠物只剩一块裁切，重发 setBounds 无效，靠“通知退出 → 重新启动”恢复；疑似 first-reveal `target` 等待 frame commit 的闩锁在 service 重启/后台场景不触发（Kotlin 宿主，非本轮 UI 改动）。
- 13 次 sheet 返回中 1 次首次 `keyevent 4` 未被消费（签到页，第二次才关）；怀疑 `setFocusable(true)` 与窗口焦点同步的竞态。
- 连点宠物第 2 下会命中菜单首行「和我聊天」（菜单 sheet 覆盖宠物位置）——双击宠物可能直接开聊天，建议首帧忽略/去抖，或让 sheet 顶部不覆盖点击点。

**最该继续修的 3 条**：
1. **旅行主按钮 ≥44 dp**：把 `min-height:48px` 从 `.toTarvelBut` 移到 `.but_normal`（或给 `.qp-travel-card .but_normal` 加 `min-height:44px`），同时把 `.albumCap` 12→13 px。
2. **返回键/焦点竞态**：sheet 打开后首次 back 偶发丢失（1/13）；在 `pushBack`/`setFocusable(true)` 后确认宿主收到焦点，或让宿主在 `setBackHandler(true)` 时主动 hold focus，并加一条“打开→立即 back”的回归用例。
3. **PetService 首帧 bounds 闩锁**：service 重启后 first-reveal 可能永不完成（宠物被裁/不可见）；在 `onCreate`/`onStartCommand` 加超时兜底或强制一次 `place(bounds)`，并复验“后台被系统重启 service”场景。

## 8. 证据文件

- 报告：本文件（唯一写入）。
- 截图（设备原图）：`/tmp/qqpet-r2-menu.png`、`signin.png`、`signin-tapped.png`、`task.png`、`email.png`、`petinfo.png`、`games.png`、`games-chips.png`、`island.png`、`farm.png`、`travel.png`、`travel-album.png`、`work.png`、`work-page2.png`、`study.png`、`shop.png`、`chat.png`、`setup.png`、`rotate-land.png`、`rotate-port.png`、`background.png`、`negative-multitap.png`、`negative-multitap2.png`。
- JSON：`/tmp/qqpet-r2-menu-measure.json`、`/tmp/r2-<page>-metrics.json`、`/tmp/r2-<page>-hits.json`、`/tmp/r2-hits-summary.json`、`/tmp/r2-*-state-open.json|state-closed1.json|state-reopen.json|state-closed2.json`。
- 探测工具：`tmp/mobile/probe.mjs`（仓库内，只读使用）；辅助脚本 `/tmp/r2nav.mjs`、`/tmp/r2page.sh`（仅 /tmp，不入库）。

## 9. 通过/失败计数

- 验收项：**6 PASS / 1 FAIL**（第 2 项逐页）。
- 页面（13）：**11 PASS / 1 FAIL（旅行） / 1 部分未验证（邮箱详情）**。
- 门禁：**4/4 exit 0**。
- 真实触摸：**3/3 命中**。
- 返回键：**13/13 可关闭可复开**，1 次首次 back 丢失（记录在风险）。
- 反例：**4/4 PASS**（含 1 个双击误触副作用观察）。

## 验收后增量（14:27–14:36，lead 复验）

验收对象是 14:03 的构建；之后又改了 4 处，均由 lead 在 14:36 的构建上复验：

| 改动 | 原因（来自本报告） | 复验 |
|---|---|---|
| `travel` 的 `.toTarvelBut > *` 提到 44dp | 本报告唯一 FAIL：去旅行 68×30 | 真机实测 96×44，`overflowX=0` |
| 农场种子/化肥块各自限高 150px 内滚 | 报告「地块排在种子/化肥之后」 | 真机：header 179 → 种子块 213（内滚）→ 化肥 391 → **地块 539**（首屏可见） |
| `phone-menu` 打开后 220ms 忽略整层触摸 | 报告「连点宠物第 2 下命中和我聊天」 | 真机连点两次：菜单仍开（18 行），未误开聊天 |
| `openFrame` 增加 `onClose`，`fishing` 用它恢复全局与 `open` 闩锁 | 报告 §7.1 / docs §5.3 契约 2 | 真机：池塘 开→返回→再开 成功（修前第二次无反应） |

未复验（与验收对象一致）：iPad/横屏、iOS、社区 SWF、密室、钓鱼 SWF 内部控件。
