# 生产构建 CLI 独立验收（`npm run release:android`，0.20.0）

> 结论：**PASS（最终状态，含 certificateSha256 硬化后复验）**。`npm run --silent release:android -- --json` 真实构建 exit 0，`dist/QQPet-0.20.0.apk`（424,786,295 B，sha256 `e1a625938864f915fc7eb50a12ce711b1ff284846cc903cc47509812c10bd174`）签名、包名、versionName、证书 SHA-256 均经独立 `apksigner`/`aapt2`/`shasum` 核验，APK 在 emulator-5554 安装并启动成功（进程存活、`PetService` 前台、无 FATAL/ANR）。门禁最终状态：新测试 40/40、`typecheck`、`check:docs`、`test:compat`（1086 tests / 1084 pass / 0 fail / 2 skip）全部 exit 0；负路径（未知参数、缺签名、无 JDK 17）均在 Gradle 前 exit 1 且不新增 dist 产物。未发现需要修复的 FAIL 或安全问题。限制：GitHub Actions 未实跑、Windows 不支持、Gradle wrapper 负路径只有单元测试覆盖、构建非 `clean`、模拟器被其他并发工作流干扰；详见第 7 节。

## 0. 验收对象、环境与口径

- 任务：`task-2`（tree `tree-c46924d889411887`；叶子 `verify-review`、`verify-negative`、`verify-real`、`verify-emulator`、`verify-gates`）。本 agent 为独立 verifier，未参与实现，未修改实现/文档/`package.json`；对实现文件的写入为零，唯一交付写入为本报告，另有 `tmp/reports/build-cli/verify/` 下的临时命令证据。
- 仓库：`/Users/ccreater/Desktop/work/qqpet`，分支 `main`，`HEAD=6b50f0fd97731e2de1b62c430555704d472fd8e2`（2026-11-23 14:56:41 +08:00，已包含任务描述的 `8bd94088`）。实现为工作区未提交改动；本报告结论只对下述工作区状态负责。
- 实现改动（本任务）：
  - 新增 `scripts/lib/release-android.mjs`（703 行，编排/纯函数）、`scripts/build-android-release.mjs`（6 行，薄 CLI）、`scripts/tests/release-android.test.mjs`（716 行，40 tests）。
  - 删除 `scripts/build-android-release.sh`（-73 行）。
  - 修改 `package.json`（+`release:android`）、`.github/workflows/build.yml`、`README.md`、`docs/guides/content-packs-and-builds.md`、`docs/guides/quality-gates.md`、`docs/doc-map.json`。
- 环境：macOS；Node v24.22.1 / npm 11.19.1；`java` on PATH 为 17.0.2（jenv shim），但 `JAVA_HOME=/Users/ccreater/.jenv/versions/11.0.16.1`（故意构造的 JDK 探测对抗环境）；Android SDK `/opt/homebrew/share/android-commandlinetools`，build-tools `35.0.0`（apksigner/aapt2），`ANDROID_HOME` 未设置；模拟器 `emulator-5554`（SM_G998B / Android 13 / API 33 / arm64-v8a）。本机 `~/.qqpet-release/release.env` 存在（`chmod 600`），verifier **未读取其内容**，由 CLI 按设计加载。
- 证据目录：`tmp/reports/build-cli/verify/`（`tmp/` 已被仓库忽略；关键输出在本报告内复述）。

### 0.1 并发改动边界（非本任务，未触碰、未纳入结论）

验证期间工作区有其他工作流的并发改动，verifier 未编辑、未回退。其 mtime 与内容均与本任务无关（触控区域/IPC 工作流）：

| 文件 | mtime | 与本任务关系 |
|---|---|---|
| `android/app/src/main/java/net/ankio/qqpet/PetService.kt` | 15:28:07 | 无关并发改动（+240 行触控区域） |
| `src/android/bridge.ts` | 15:18:30 | 无关并发改动 |
| `src/renderer/main.ts` | 15:26:15 | 无关并发改动 |
| `src/shared/ipc.ts`、`docs/architecture/desktop-ipc-and-preload.md` | 15:28:25 | 无关并发改动 |
| `scripts/tests/pet-drag.test.mjs`、`scripts/tests/android-overlay.test.mjs` | 15:26:15 | 无关并发测试 |

这些改动**会进入 APK**（因为真实构建使用工作区源码）；本报告将它们作为“环境现状”记录，不作为构建 CLI 的验收内容。另有未跟踪的 `audit/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与历史 `.agent-reports/**`，均早于/独立于本任务。

## 1. 静态审查

### 1.1 变更范围与旧脚本移除 — PASS

- `git diff --check` → exit 0（无空白错误）。
- 旧脚本：工作区 `D scripts/build-android-release.sh`；`git grep -n 'build-android-release\.sh' -- .` → exit 1（无结果）；全工作区 `grep -rn` 仅命中 `tmp/reports/build-cli/design.md` 的历史说明与 `.worktrees/fix-mobile-bubble/` 的旧分支副本（不在当前树/提交内），无运行残留引用。
- 构建产物的 `.gitignore` 覆盖 `dist/`、`out/`；`git status` 无构建产物进入交付范围。verifier 未执行 `git add`/`commit`。
- 代码结构符合设计：`scripts/lib/release-android.mjs` 负责参数/env/工具链/编排，`scripts/build-android-release.mjs:6` 只设置 `process.exitCode = main(...)`。

### 1.2 CI 契约 — PASS（静态）

`.github/workflows/build.yml:48-80` 的 android 作业：

- 保留 `actions/checkout`（lfs）、`setup-node@v4`（22）、`setup-java@v4`（temurin 17）、`gradle/actions/setup-gradle@v4`、`npm ci`、`npm version "${GITHUB_REF_NAME#v}"`。
- keystore 解码步骤保留，四个 secrets 原样注入（`ANDROID_KEYSTORE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`）。
- 唯一构建步骤是 `npm run release:android`（`build.yml:70`）；旧 `typecheck && build:android-web`、`./gradlew assembleRelease`、`mkdir dist && mv` 均已删除。
- 上传保留：`dist/*.apk`，`if-no-files-found: error`（`build.yml:76-80`）。
- YAML 步骤顺序/缩进经人工核对无异常；**未在 GitHub runner 实跑**（见第 7 节）。

### 1.3 文档与实现一致性 — PASS

- `README.md`：新增 `release:android` 入口、env 文件优先级/只打印路径、预检、构建步骤、`dist/QQPet-<version>.apk`、JSON/`--silent`、证书 SHA-256、失败语义与平台限制。
- `docs/guides/content-packs-and-builds.md:84-94`：入口、env、预检、构建/产物、JSON 字段（含 `certificateSha256`）、CI android 作业说明与实现一致。
- `docs/guides/quality-gates.md:21`：命令/覆盖/退出码表项与实现一致；`package.json:10-39`、`package.json:34` 行号实测正确。
- 文档行号实测：`build.yml:9-13`（acceptance 依赖完整验收）、`build.yml:48-80`（android）、`build.yml:82-127`（harmony）、`build.yml:129-132`（ios）、`build.yml:134-192`（release）、`build.yml:134-135`（release needs）均与当前文件吻合。
- `docs/doc-map.json` 将两个新脚本加入 `docs/guides/content-packs-and-builds.md` 的 `warn` 规则，属于同一变更，`check:docs` exit 0。
- 轻微表述（不构成 FAIL）：README 称“不会产出未签名或未校验的 APK”，严格说若 Gradle 已产出中间 APK、随后 `apksigner`/`aapt2` 校验失败，中间文件仍会留在 `android/app/build/outputs/apk/release/`，只是**不会归档到 `dist/`**；预检缺签名时不会进入 Gradle。建议后续把“产物”明确为 `dist/` 交付物。

### 1.4 凭据与敏感值 — PASS

- 测试使用固定假值（`fixture-*` 形式，测试文件第 28 行注释亦声明为 obvious fixtures），未发现真实 keystore/密码/私钥进入代码、测试、文档或提交内容；本报告不复制任何值。
- `release.env` 只被 CLI 读取；日志仅输出**加载路径**与 `signing via environment`，`--json` 摘要只含公开信息（包名、versionName、证书 DN、证书 SHA-256、APK SHA-256），不含密码/别名值/keystore 内容。真实构建 stderr 关键行已复核，无凭据值。
- verifier 未 `cat`/读取/复制/打印 `~/.qqpet-release/release.env` 或 keystore 内容；仅使用 `ls` 元数据（`chmod 600`）与 CLI 自身日志。
- 残余风险（P3）：合并后的 env（含签名 secrets）会完整传给 `npm run typecheck` 与 `npm run build:android-web` 子进程，超过这两个步骤的实际需要；env 解析器是 shell 子集，未加引号且含 `" #"` 的密码会被截断（文档已声明非法行显式失败；以引号包裹即可规避）。

### 1.5 测试质量 — PASS（有覆盖缺口）

- 40 个 `node:test`，使用临时 fixture（fake JDK/SDK/keystore/executor）与真实 CLI 子进程（`scripts/tests/release-android.test.mjs:706`），覆盖：
  - 参数/用法/JSON 失败语义；
  - env 文件引号、`export`、注释、CRLF、非法行不泄露值、显式环境优先；
  - 版本语义化、JDK 17 验证（JAVA_HOME=11 时改用 PATH 17；无 17 拒绝）、SDK 完整性、签名四键/keystore.properties、wrapper 缺失/不可执行；
  - 编排顺序 typecheck → build:android-web → gradle，环境变量注入，`local.properties` 不覆盖，失败短路；
  - APK 缺失/apksigner 失败/包名/versionName 不符均不归档；失败保留旧 dist 且无临时文件；
  - `certificateSha256` 正常与缺失（null + `(unavailable)`）两条路径（`:528`）；
  - 真实薄 CLI `--help` 与 `--json --bogus` 退出码/纯 JSON。
- 非自我印证：测试断言真实文件内容/目录清单（无 tmp 残留）、旧产物保留、子进程 env 与 cwd、stdout 只有一条 JSON。
- 缺口（不阻塞）：没有 `aapt2` 非零退出但含 package 行的用例、copy/hash 失败用例、成功路径的真实子进程集成测试（仅 help/参数错误走真实 CLI）、`--help` 与 `--json` 同时出现的语义、`--env-file` 相对路径。均属低风险。

## 2. 质量门禁（最终状态）

| 命令 | 退出码 | 关键输出 | 证据 |
|---|---|---|---|
| `node --experimental-strip-types --test scripts/tests/release-android.test.mjs` | 0 | tests 40 / pass 40 / fail 0 / 220ms | 本报告；测试输出留存在会话 |
| `npm run typecheck`（15:27 与 15:33 各一次） | 0 | node/web/harmony/e2e 四套 tsc 通过 | 同上 |
| `npm run check:docs`（15:27 与 15:33 各一次） | 0 | “文档检查通过：目录结构、索引、链接与代码引用均有效。” | 同上 |
| `npm run test:compat`（最终，15:30:5x–15:32:2x） | 0 | tests 1086 / pass 1084 / fail 0 / skipped 2 / 94.7s | `tmp/reports/build-cli/verify/final-compat.log` |

`test:compat` 首跑（15:22–15:23）曾 exit 1：`scripts/tests/lan.test.mjs:69` “a crashed pet is missed within the timeout” 因真实 UDP 广播发现到环境中的其他宠物节点（日志出现 `+甲/+乙/+丙` 等 OWN 名字）而多出事件。该文件头注释已说明测试共享真实 UDP 端口；隔离重跑 `node --experimental-strip-types --test scripts/tests/lan.test.mjs` → 4/4 pass；全量重跑 → 1073 tests / 1071 pass / 0 fail；最终状态再跑 → 1086 / 1084 / 0 fail。**归因为并发/环境性 flake，与本构建 CLI 改动无关**；但这是仓库既有的测试稳定性风险（P3），已如实记录，不用“重跑通过”掩盖首跑失败。

## 3. 负路径（最终状态，15:31）

| 场景 | 命令（摘要） | 退出码 | 证据/关键输出 |
|---|---|---|---|
| 未知参数 + JSON | `npm run --silent release:android -- --json --bogus` | 1 | stdout 仅 `{"ok":false,"error":"Unknown argument: --bogus."}`；stderr 0 字节（`final-negA-*.txt`） |
| 缺签名、禁 env 文件 | 清空四个 `ANDROID_*` 后 `... -- --json --no-env-file` | 1 | stdout `{ok:false,error:"Release signing is not configured..."}`；stderr 只到 `release: Android SDK ...` 就 `error:`，**未出现** `npm run typecheck` / `./gradlew` 日志；`dist/QQPet-0.20.0.apk` 未新增（`final-negB-*.txt`） |
| 无 JDK 17 | `env -i HOME=... JAVA_HOME=/nonexistent/jdk17 PATH=/usr/bin:/bin node scripts/build-android-release.mjs --json --no-env-file` | 1 | 错误列出 `JAVA_HOME is not a usable JDK; java on PATH is Java 8; /usr/libexec/java_home -v 17 is Java 8`，证明不盲信 `JAVA_HOME` 且校验回退 JDK（`final-negC-*.txt`） |
| Gradle wrapper 缺失/不可执行 | 未端到端执行 | — | 会需要临时改动 `android/gradlew`，超出 verifier 写作用域；由 `scripts/tests/release-android.test.mjs:458` 的 fixture 单测覆盖（缺失与 `chmod 644` 两分支，且断言未调用构建命令） |

负路径后核对：`dist/QQPet-0.20.0.apk` 仍是 15:27 的最终产物；`android/app/build/outputs/apk/release/app-release.apk` mtime 仍为 15:27:15、大小 424,786,295 B，说明失败未触发 Gradle 或产生新的未签名归档。

## 4. 真实构建（最终状态，15:27）

命令：`npm run --silent release:android -- --json` → **exit 0**，耗时 10s。

stdout（唯一一行 JSON，字段顺序与文档一致）：

```json
{"ok":true,"target":"android","version":"0.20.0","apk":"/Users/ccreater/Desktop/work/qqpet/dist/QQPet-0.20.0.apk","sha256":"e1a625938864f915fc7eb50a12ce711b1ff284846cc903cc47509812c10bd174","packageName":"net.ankio.qqpet","versionName":"0.20.0","signer":"CN=QQPet, OU=Mobile, O=QQPet, C=CN","certificateSha256":"f636e237378d8bb7c65fb5ae9046c6d0d6e49b07125534b216265655adcc281d"}
```

stderr 关键行（`tmp/reports/build-cli/verify/final-build-stderr.log`）：

```
release: env file /Users/ccreater/.qqpet-release/release.env (existing environment wins)
release: android 0.20.0
release: Java 17 (/Users/ccreater/.jenv/versions/jdk-17.0.2.jdk/Contents/Home, java on PATH)
release: Android SDK /opt/homebrew/share/android-commandlinetools (build-tools 35.0.0)
release: signing via environment
release: android/local.properties kept (.../android/local.properties)
release: npm run typecheck
release: npm run build:android-web
release: ./gradlew assembleRelease
release: verifying signature and package metadata
release: archived /Users/ccreater/Desktop/work/qqpet/dist/QQPet-0.20.0.apk
release: sha256 e1a62593...
```

- **JDK 探测对抗**：进程 `JAVA_HOME` 是 11.0.16.1，CLI 拒绝并改用 PATH 的 17.0.2（日志 `java on PATH`），随后 Gradle/apksigner 均在 17 下运行；负路径 C 进一步证明无 17 时快速失败。
- **Gradle 证据**：`BUILD SUCCESSFUL in 5s`；`46 actionable tasks: 11 executed, 35 up-to-date`；执行包含 `mergeReleaseAssets`、`compressReleaseAssets`、`compileReleaseKotlin`、`packageRelease`、`assembleRelease`（`final-build-stderr.log`），不是纯 up-to-date 假构建。
- **产物**：`dist/QQPet-0.20.0.apk` 424,786,295 B（约 405 MiB），mtime 15:27；`android/app/build/outputs/apk/release/app-release.apk` 同大小；`cmp` 完全相同。
- **复现性**：本次为增量构建（Gradle 缓存复用，未 `clean`），但 `npm run typecheck`、`npm run build:android-web` 与关键 Gradle task 均真实执行；`out/android` mtime 从 15:02 更新到 15:27:11；`android/local.properties` 已存在，CLI 校验后保留、未覆盖；`dist` 旧文件被同路径原子替换（前一次 pre-hardening 构建 sha256 `50b7b4a1...` → 本次 `e1a62593...`），dist 目录无 `.tmp-*` 残留。
- **硬化前对照**：15:24 的同命令为 pre-hardening 状态，exit 0、sha256 `50b7b4a190d88201fb0c4ebddf6cf0aac24ec5f5c8dbaf56d95a30967b49e22e`、424,784,899 B；该 APK 也完成过一次模拟器安装/启动。最终结论以 15:27 硬化后构建为准。

## 5. 独立产物核验（不只信 CLI 输出，15:27:25）

工具显式取自 `/opt/homebrew/share/android-commandlinetools/build-tools/35.0.0/`（未依赖 `ANDROID_HOME`）：

| 检查 | 结果 |
|---|---|
| `shasum -a 256 dist/QQPet-0.20.0.apk` | `e1a625938864f915fc7eb50a12ce711b1ff284846cc903cc47509812c10bd174`，与 JSON 一致 |
| `cmp dist/... android/app/build/outputs/apk/release/app-release.apk` | IDENTICAL（exit 0） |
| `apksigner verify --print-certs -v` | exit 0；`Verifies`；v2 scheme true；Number of signers: 1；DN `CN=QQPet, OU=Mobile, O=QQPet, C=CN`；certificate SHA-256 `f636e237378d8bb7c65fb5ae9046c6d0d6e49b07125534b216265655adcc281d`（与 JSON `certificateSha256` 一致）；RSA 4096 |
| `aapt2 dump badging` | `package: name='net.ankio.qqpet' versionCode='2000' versionName='0.20.0'`；minSdk 30 / targetSdk 35；`launchable-activity: net.ankio.qqpet.MainActivity` |
| JSON 字段 | `ok,target,version,apk,sha256,packageName,versionName,signer,certificateSha256` 全部存在且值正确 |

证据：`tmp/reports/build-cli/verify/12-final-artifact-verify.txt`、`final-build-stdout.json`。

## 6. 模拟器安装与启动（emulator-5554）

设备：`SM_G998B`，Android 13 / API 33，`arm64-v8a`；安装前 `df /data` 可用 115G。

### 6.1 操作记录（只卸载 `net.ankio.qqpet`，`.probe` 全程保留）

- 15:24:51 设备探测时，已安装的 `net.ankio.qqpet` 实际是 **0.20.0 / versionCode 2000 / lastUpdate 15:19:51**（与任务简报“已安装 0.11.0”不一致；如实记录）。
- 15:24:5x `adb uninstall net.ankio.qqpet` → Success；`pm list packages` 仍见 `net.ankio.qqpet.probe`（未触碰）。
- 15:25:05 安装 pre-hardening APK（424,779,223 B）→ Success；冷启动 exit 0、进程存活、无 FATAL；期间进入系统“显示在其他应用上层”授权页（首次运行正常流程），appops 授权后仍被系统页遮挡。
- 15:26:56 出现**非本 agent**的安装/更新（lastUpdateTime 变化，签名与最终 APK 不同），导致 15:27:36 的覆盖安装 `adb install -r` 报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE: ... signatures do not match newer version`。
- 按任务约定 15:28:10 再次 `adb uninstall net.ankio.qqpet`（Success，`.probe` 保留），15:28:13 安装最终 APK 成功；随后约 15:29 该包被**并发工作流**经 `deletePackageX` 卸载（logcat 有 `Force stopping ... user=-1: deletePackageX` / `pkg removed`），并出现 `net.ankio.qqpet.touchprobe`（并发工作流的探针包，未触碰）。
- 15:30:30 重新安装最终 `dist/QQPet-0.20.0.apk`（Success，lastUpdate 15:30:30），预授权 `SYSTEM_ALERT_WINDOW` 与 `POST_NOTIFICATIONS`，`monkey -p net.ankio.qqpet -c android.intent.category.LAUNCHER 1` 启动。

### 6.2 最终运行证据（15:30–15:32）

- `adb shell pidof net.ankio.qqpet` → `12656`（15:31:20、15:32:47 两次快照仍在）。
- `dumpsys activity services net.ankio.qqpet`：`net.ankio.qqpet/.PetService`，`isForeground=true`，前台通知 channel=pet；WebView sandbox 进程存在；窗口列表有 `Window{... u0 net.ankio.qqpet}`（overlay 窗口）。
- 启动后 UI 实际渲染：截图 `tmp/reports/build-cli/verify/17-final-launch.png` 显示“领养一只企鹅宝宝”领养卡片（WebView 资源加载成功）。
- `adb logcat` FATAL/ANR 扫描：`FATAL EXCEPTION` / `ANR in net.ankio.qqpet` / `Process: net.ankio.qqpet` 均无记录；`chromium(12656)` 在最终启动窗口内仅有 `Failed to read DnsConfig`（无网络环境的正常警告）。**如实记录**：WebView 控制台曾出现 `Uncaught TypeError: r.checkVisibility is not a function`（15:29 的本 APK 进程 pid 12194，以及并发探针进程 pid 12449），属 JS console error、非 crash/ANR，UI 仍渲染成功；其归因不在构建 CLI（工作区 `src/renderer/main.ts` 在 15:26 有并发改动），见第 7 节第 10 项。
- 设备侧安装的确为最终构建文件：`adb install dist/QQPet-0.20.0.apk`（sha256 `e1a62593...`），`versionName=0.20.0`、`versionCode=2000`、`lastUpdateTime=2026-11-23 15:30:30`。

> 注意：模拟器由多个工作流共享，15:26–15:30 期间发生过外部安装/卸载/探针包安装。上述 PASS 基于 15:30 后的重新安装与 15:30–15:32 快照；若之后他人再次改动设备状态，需要复测。

## 7. 无法验证 / 限制

1. **GitHub Actions android 作业未实跑**：本地无 GitHub runner；只做静态审查。Linux CI 上的 `setup-java`/SDK 预装/`npm ci`/secrets 行为未实测。
2. **Windows 本地不支持**：实现按 POSIX 处理 `./gradlew` 与归档，文档已声明走 CI/WSL；未在 Windows 验证。
3. **Gradle wrapper 缺失/不可执行负路径未端到端**：需临时改动仓库内 `android/gradlew`，超出 verifier 写作用域；只有单元测试覆盖（用例 `scripts/tests/release-android.test.mjs:458`）。
4. **非 clean 构建**：未执行 `./gradlew clean`；Gradle 复用缓存（11 executed / 35 up-to-date），但 typecheck、Web 构建与关键打包 task 均真实执行，`out/android`/APK 均更新。
5. **human 模式真实构建未跑**：真实命令只跑 JSON 模式；human 摘要（含 `certificateSha256`）由单元测试覆盖（`scripts/tests/release-android.test.mjs:660`）。
6. **显式 `--env-file` 真实构建未跑**：默认 env 文件加载已真实发生；`--env-file`/`--no-env-file`/非法行由单元测试覆盖，`--no-env-file` 负路径已真实执行。
7. **`test:compat` 首跑 flake**：`lan.test.mjs` 共享真实 UDP 端口，受环境/并发影响；最终重跑通过，但不能保证该测试在其他网络环境稳定。
8. **模拟器并发干扰**：见 6.1；首装/覆盖安装曾因外部包签名变化失败，最终重新安装成功。
9. **`npm run validate:evidence` 不适用**：本报告是自由格式 Markdown 验收报告，不是 C12 gate/e2e/docker/proxy 的机器可读 JSON；未按该工具 schema 生成，也未运行 `gate:acceptance`（任务未要求发布门禁）。
10. **运行时 JS console error**：WebView 控制台记录 `Uncaught TypeError: r.checkVisibility is not a function`（0.20.0 进程 pid 12194；并发探针 pid 12449 亦有），未导致崩溃/ANR，UI（领养卡片）仍渲染。它可能来自并发中的 `src/renderer/main.ts` 改动或既有 Android WebView 兼容问题，**不属于构建 CLI 的判定范围**；应用侧 owner 应复核该错误是否影响具体 UI 路径。

## 8. PASS/FAIL 清单

| # | 项目 | 结论 | 依据 |
|---|---|---|---|
| 1 | 变更范围仅预期文件、无空白错误、旧 sh 删除且无残留引用 | **PASS** | `git diff --check`=0；`git grep build-android-release.sh` 无结果；工作区并发改动已单列并排除 |
| 2 | CI android 作业只调用 CLI，secrets 与 `dist/*.apk` 上传保留 | **PASS（静态）** | `build.yml:48-80` |
| 3 | 文档与实现一致（参数/产物/失败语义/JSON 字段/行号） | **PASS** | `package.json:34`、`package.json:10-39`、`build.yml` 行号实测；README/两份指南/doc-map |
| 4 | 无真实凭据进入代码/测试/文档/输出 | **PASS** | 假值 fixture；日志只打印路径；未读取 release.env |
| 5 | 新测试覆盖风险而非自我印证（40 tests） | **PASS** | 40/40 通过；顺序/环境/归档/证书 null 等断言 |
| 6 | `npm run typecheck` | **PASS** | exit 0（15:27、15:33 各一次） |
| 7 | `npm run check:docs` | **PASS** | exit 0（15:27、15:33 各一次） |
| 8 | `npm run test:compat` | **PASS（最终）** | 1086 tests / 1084 pass / 0 fail / 2 skip，exit 0；首跑 lan flake 已隔离复跑 |
| 9 | 负路径：未知参数纯 JSON exit 1 | **PASS** | `final-negA`：stdout 单 JSON，stderr 0 字节 |
| 10 | 负路径：缺签名在 Gradle 前失败、无新产物 | **PASS** | `final-negB`：exit 1，日志止于预检，dist 未新增，app-release mtime 不变 |
| 11 | 负路径：无 JDK 17 预检失败 | **PASS** | `final-negC`：exit 1，三种候选均被验证为 Java 8/不可用 |
| 12 | 真实构建 exit 0、`dist/QQPet-0.20.0.apk` 存在且大小合理 | **PASS** | exit 0；424,786,295 B；JSON 摘要 |
| 13 | 独立 apksigner/aapt2/shasum 核验 | **PASS** | v2 签名通过；package/versionName 正确；sha256 与 JSON/cmp 一致 |
| 14 | JSON 含 `certificateSha256` 且与证书一致 | **PASS** | JSON `f636e237...` = apksigner digest |
| 15 | 模拟器卸载旧包/安装/启动、进程存活、无 FATAL/ANR | **PASS** | pid 12656 持续存活；PetService 前台；截图显示 UI |
| 16 | 复现性：typecheck/web/gradle 真实执行、dist 覆盖 | **PASS（增量构建）** | 11 executed tasks；`out/android` 15:27:11；旧 sha 50b7→新 e1a6 |

**FAIL：无。** 需人工关注但不判 FAIL：`test:compat` 首跑 LAN flake（P3，环境/并发导致，已复跑通过）；README “不产出未签名/未校验 APK” 的表述可更精确（P3，交付物 `dist/` 语义）；env 合并传给 typecheck/web 子进程的暴露面（P3）；APK 运行时的 WebView `r.checkVisibility` console error（P3，非崩溃、UI 可渲染，归因并发 renderer 或既有 WebView 兼容问题，需应用侧复核）。

## 9. 交付建议

- **建议交付/合并**：构建 CLI 的契约、实现、文档、CI 静态接入、测试与真实产物链路均通过独立验收；未发现阻断级缺陷或安全问题。
- 合并/推送前建议：在真实 tag CI 上确认 android 作业（Linux、base64 keystore、`dist/*.apk` 上传），这是唯一未实跑的关键路径；合并时不要夹带本报告中列出的并发改动（它们属于其他工作流）。
- 现有 `dist/QQPet-0.20.0.apk` 与模拟器状态可作为交付证据；`dist/` 为忽略目录，原始大产物不进入提交。

## 10. 证据索引与任务状态

- 报告：`.agent-reports/acceptance/2026-11-23-build-cli-verification.md`（本文件；本任务唯一交付写入，未改实现文件）。
- 证据目录：`tmp/reports/build-cli/verify/`：
  - 门禁：`final-compat.log`、`compat-rerun.log`（首跑 flake 与复跑）；
  - 构建：`final-build-stdout.json`、`final-build-stderr.log`、`11-final-build.txt`、`10-final-pre-build.txt`；
  - 负路径：`12-final-artifact-verify.txt`、`18-final-negatives.txt`、`final-neg{A,B,C}-*.txt`；
  - 模拟器：`04-device-uninstall.txt`、`05-install.txt`、`06-launch.txt`、`13-final-emulator.txt`、`14-final-emulator-reinstall.txt`、`17-final-launch.txt`、`19-final-emulator-snapshot.txt`、`17-final-launch.png`（UI 截图）。
- 任务：`task-2`（revision 2，owner `verify-build-cli`）。Timeline tree `tree-c46924d889411887` 的 `verify-review` / `verify-negative` / `verify-real` / `verify-emulator` / `verify-gates` 叶子：本会话未暴露 timeline 更新工具，无法由 verifier 直接写入；请 Lead 按本报告结论更新（每项均为 PASS，无 FAIL）。
