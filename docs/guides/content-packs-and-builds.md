# 内容包与多平台构建

> 结论：宠物内容（`resources/pet`）与外壳程序分离。内容包是一份「store 模式 zip + manifest.json」的定长校验产物，分为全量包与基于某个标签的增量包，增量包可以声明 `deletes` 来删除下层文件；外壳按 `minShell` 判断能否使用某个包。构建侧一条命令对应一个平台，产物目录固定（`out/*`、`dist/`、`dist/packs`），CI 的 tag 工作流在发布前必须跑完整验收工作流并重新生成内容包与 `packs.json`。

## 1. 范围

代码位置写作 `path:line`。省略前缀的约定：`pack-content.mjs`、`pack-harmony.mjs`、`prepare-ios-assets.mjs`、`import-assets.mjs` 在 `scripts/`；`content-pack.ts`、`content.ts`、`first-run.ts` 在 `src/main/`；`ci.yml`、`build.yml` 在 `.github/workflows/`。

本文覆盖：内容包格式与安装/查找规则、打包脚本、三端 Web 产物与壳工程构建、桌面安装包配置（完整版/精简版）、iOS 资源准备、CI 工作流与产物。服务端镜像与部署见 `docs/guides/server-deployment.md`；本地宠物运行时见 `pet-runtime-and-save.md`。

## 2. 内容包格式

`src/main/content-pack.ts` 定义全部格式与校验：

- `Manifest`（`content-pack.ts:18-26`）：`id`（`^[a-z0-9][a-z0-9-]{0,31}$`）、`version`、`minShell`（使用该包所需的最旧外壳版本）、可选 `base`、`files[]`（`path`、`size`、`sha256`）、可选 `deletes[]`。
- `PackIndex`（`content-pack.ts:40-43`）：发布在 release 旁的 `packs.json`，`schema: 1`，`packs` 是 `PackIndexEntry` 数组（含 `name`、`url`、`size`、`sha256`）。
- 路径规则的唯一实现是 `checkPath()`（`content-pack.ts:76-81`）：必须以 `pet/` 开头、长度 ≤ 512、不含 `\`、`:`、NUL、无空段/`.`/`..` 段。内容包只能写 `pet/` 下，不能越界到外壳或其他资源。
- `parseManifest()`（`content-pack.ts:83-101`）是 manifest 的单一校验入口：`version`/`minShell` 必须匹配 `x.y.z[-+…]`；有 `base` 时 `version` 必须严格高于 `base`；文件路径按小写去重；`deletes` 只允许出现在增量包（有 `base` 时）。
- zip 只接受 store 模式：`zipEntries()` 拒绝加密、非 store、符号链接、目录项（`content-pack.ts:180-191`）。`readPack()` 要求条目数恰好等于 `manifest.files.length + 1`（manifest 自身），逐项核对大小，并在提供回调时核对 SHA-256（`content-pack.ts:206-234`）。因此「装配进 zip 但没写进 manifest」的文件会被判为非法，而不是被忽略。

## 3. 安装、分层与查找

外壳不会把包解成覆盖式目录，而是把每个包解到 `packs/<id>@<version>/` 并保留自己的 manifest：

- `installPack()`（`content-pack.ts:301-323`）：先 `readPack()` 读头并做 `packBlocker()` 判定，再解压到 `packs/.tmp-<随机>`，成功后 `rename` 成最终目录；失败删除临时目录。安装是「先完整校验、再原子换名」，中途失败不会留下半包。
- `packBlocker()`（`content-pack.ts:294-299`）给出拒绝原因：外壳太旧（`minShell > shell`）、内容已不低于包版本、增量包的 `base` 与当前内容版本不符。
- `installedLayers()`（`content-pack.ts:251-278`）从内置内容出发向上串链：版本必须递增；全量包只要求比下层新，增量包必须正好坐在自己的 `base` 上；`minShell` 高于当前外壳的包被排除。结果按新→旧返回，外壳升级/降级都不会混用内容。
- `contentVersion()`（`content-pack.ts:280`）取最上层版本，没有安装包时回落到内置版本。
- `lookup()`（`content-pack.ts:329-337`）自上而下找文件；某层在 `deletes` 里列出该路径（大小写不敏感）时，对**所有更下层**都隐藏该文件。这是增量包能真正删除旧资源的原因。
- `FIRST_PACK_SHELL = '0.6.8'` 是第一个读内容包的外壳版本；`defaultMinShell(base)` 取 `base` 与它之中的较新者（`content-pack.ts:283-291`）。

运行期入口在 `src/main/content.ts`：

- `resourcesRoot`：打包后是 `process.resourcesPath`，开发时是 `<appPath>/resources`（`content.ts:11`）。
- `packsDir` 固定在 `userData/packs`，且刻意延迟取（`content.ts:18-19`）——因为 `index.ts` 可能在模块加载后重定向 `userData`。
- `layers()` 只读一次并缓存（`content.ts:20-22`）：安装包后会重启应用，所以运行期不需要热更新层列表。
- 索引地址是 `releases/latest/download/packs.json`（`content.ts:50`）。`findPack()` 只挑「增量包且能直接应用」的最新一条（`content.ts:55-63`）；`findFullPack()` 只给首次运行的精简版挑全量包（`content.ts:66-71`）。
- `downloadPack()` 只下载 `findPack`/`findFullPack` 记录过的条目，绝不接受页面传入的 URL；下载到临时文件后按 `packs.json` 的 sha256 校验，再走同一个 `installPack()`（`content.ts:73-87`）。

精简版首次运行窗口由 `src/main/first-run.ts` 负责：`registerPackIpc()` 注册 `packInfo`/`importPack`/`resetPacks`/`findPack`/`findFullPack`/`downloadPack` 与 `relaunch`（`first-run.ts:13-23`）；`openFirstRun()` 打开 520×420 的不可缩放窗口加载 `firstrun.html`，关闭即退出（`first-run.ts:29-57`）。

## 4. 打包脚本

`scripts/pack-content.mjs` 是唯一的内容包生成器，需要 `--experimental-strip-types` 运行（它直接 import 了 `.ts`）：

```bash
node --experimental-strip-types scripts/pack-content.mjs \
  --version 0.7.0 \
  [--base v0.6.6] [--full] \
  [--min-shell 0.6.8] \
  [--out dist/packs] \
  [--url-prefix https://example.invalid/releases/download/v0.7.0/]
```

行为要点（`pack-content.mjs`）：

- `--version` 必填，前导 `v` 会被去掉（`:24-25`）。`--out` 默认 `dist/packs`，`--url-prefix` 默认空串（`:20-21`）。
- 无 `--base` 时只产出全量包 `QQPet-content-<version>.qqpetpack`，文件清单来自 `git ls-tree -r --name-only HEAD -- resources/pet`（`:60-62`）。未跟踪文件不会被收录，这是刻意的：包内容必须来自已提交的树。
- 有 `--base` 时用 `git diff --name-status --no-renames <base> HEAD` 计算增删，产出 `QQPet-content-<base>-to-<version>.qqpetpack`，删除项写入 `deletes`（`:63-72`）。没有差异时不生成增量包。
- `--full` 与 `--base` 可以同时给出：一轮里既出全量包也出增量包（`:62-72`）。
- 稳定版不能以同号的 beta 为基线：若 `--base` 带 `-` 而 `version` 不带且主版本相同，会自动改用 `git describe --exclude=*-*` 找到上一个稳定标签（`:32-37`）。
- 任何文件若以 Git LFS 指针开头（`version https://git-lfs`）立即报错并要求 `git lfs pull`（`:39-43`）。这条防止把 130 字节指针打进包。
- 每个文件写 zip 前重新读取并计算 sha256；写完后立刻 `readPack(file)` 回读校验（`:45-58`）。因此「脚本退出 0」等价于「产物可被外壳读取」。
- 最后写 `packs.json`，列出本轮所有包的 `name`/`url`/`size`/`sha256`/`minShell`/`base`（`:73-75`）。

## 5. 各平台构建

### 5.1 桌面（Electron）

| 命令 | 作用 | 产物 |
| --- | --- | --- |
| `npm run build` | `electron-vite build`，主进程/preload/渲染层 | `out/main`、`out/preload`、`out/renderer` |
| `npm run dist` | typecheck → build → `electron-builder --publish never` | `dist/` 安装包 |
| `npx electron-builder --config electron-builder.lite.yml --publish never` | 精简版（不带 `resources/pet`） | 带 `Lite` 的文件名 |

`electron-builder.yml` 的事实：`files: out/**`；`extraResources` 把 `resources/{pet,icons,asr}` 放到包内根目录；`asar: true`；`publish: []`（发布由 GitHub 工作流负责）；Windows 固定 `x64`（NSIS 无法解压 ARM64 过滤的载荷）；macOS 同时出 `arm64` 与 `x64`，并带局域网发现用途说明；Linux 出 AppImage 与 deb（`electron-builder.yml:1-42`）。

`electron-builder.lite.yml` 与完整版共用 `appId`，但 `extraResources` 只含 `icons/**`、`asr/**`，且 `artifactName` 为 `QQPet-Lite-${version}-${arch}.${ext}`（Windows 为 `QQPet-Lite-Setup-…`）。两个文件刻意不互相 `extends`：electron-builder 会拼接 `extraResources`，继承会把 `pet/**` 带回来（`electron-builder.lite.yml:1-6`）。改一个必须同步另一个。

### 5.2 Android

```bash
npm run android   # = typecheck + build:android-web + cd android && ./gradlew assembleDebug
```

`vite.android.config.ts` 输出到 `out/android`，`base: './'`、`publicDir: false`，并在 `index.html` 的 `bootstrap.ts` 之前注入 `../android/bridge.ts`（`vite.android.config.ts:7-30`）。`resources/pet` 不进 Web 产物，而由 Gradle 作为 APK assets 打入。

### 5.3 HarmonyOS

```bash
npm run harmony   # = typecheck + build:harmony-web + node scripts/pack-harmony.mjs + cd harmony && ./hvigorw assembleHap -p product=default -p buildMode=debug
```

`vite.harmony.config.ts` 输出 `out/harmony` 并注入 `../harmony/bridge.ts`。`scripts/pack-harmony.mjs` 做三件事：清空并重建 `harmony/entry/src/main/resources/rawfile`，把 `out/harmony` 整个复制进去，再把 `resources/pet` 复制成 `rawfile/pet`（`pack-harmony.mjs:4-13`）。缺 `out/harmony` 或 `resources/pet` 时直接报错，不会产出缺内容的 HAP。

### 5.4 iOS

```bash
npm run ios                 # = typecheck + build:ios-web + bash ios/build.sh
npm run build:ios-web       # 仅 Vite 产物
npm run prepare:ios-assets  # 显式下载/校验资源到 out/ios-assets
npm run check:ios-assets    # 只校验，不下载
```

`vite.ios.config.ts` 输出 `out/ios`，`base: './'`、`publicDir: false`，并给 `index.html`/`game.html` 注入 `../ios/bridge.ts` 与禁止缩放的 viewport meta（`vite.ios.config.ts:21-33`）。找不到页面入口脚本时抛错（`:27-28`），不会静默生成没有桥的页面。

`scripts/prepare-ios-assets.mjs` 是显式准备步骤：按 `git ls-files resources` 列出资源，非 LFS 文件直接复制（`COPYFILE_FICLONE`），LFS 指针则从 `media.githubusercontent.com` 按仓库+完整提交 SHA 下载（`:44-89`、`:104-135`）。每个文件校验 size 与 sha256，失败重试 3 次；`--check` 只校验并列出缺失项；成功后写 `out/ios-assets/manifest.json` 记录 `repository`、`revision`、`files`（`:88-90`）。可用环境变量：`QQPET_RESOURCES_ROOT`、`QQPET_ASSET_REVISION`（必须是 40 位 SHA）、`QQPET_ASSET_REPOSITORY`（必须是 `owner/repo`）、`QQPET_ASSET_JOBS`（1~6）。

### 5.5 资源导入（一次性）

`npm run import-assets -- [app.asar]` 从既有安装包的 `app.asar` 提取 `dist/pet/**` 到 `resources/pet`，跳过 `smallGame.zip`，并把托盘 `.ico` 解出 PNG 供 macOS/Linux 使用（`scripts/import-assets.mjs:1-10`）。它是资源来源工具，不参与日常构建。

## 6. CI

`.github/workflows/ci.yml`（名称 `C12 acceptance`）在 push/PR 上跑五个作业：

| 作业 | 关键命令 | 说明 |
| --- | --- | --- |
| `root` | `npm ci` → `typecheck` → `test:compat` → `build` → 三个平台 Web 构建 | 四个产物构建都要过（`ci.yml:18-44`） |
| `server` | `npm --prefix server run typecheck` → `npm --prefix server test` | 服务端独立包（`ci.yml:46-61`） |
| `e2e` | `xvfb-run -a npm run test:e2e` → `validate-evidence.mjs e2e …` | 真实服务端 + 两个 Electron 进程（`ci.yml:64-101`） |
| `docker-smoke` | `smoke:compose` → `smoke:docker` → `validate:evidence -- docker …` | 镜像、就绪、非 root、备份恢复（`ci.yml:104-145`） |
| `proxy-wss` | `smoke:proxy` → `validate:evidence -- proxy …` | Nginx 自签 TLS + WSS 升级（`ci.yml:148-171`） |

`.github/workflows/build.yml` 由 `v*` tag 触发：

1. `acceptance` 作业 `uses: ./.github/workflows/ci.yml`，即发布构建依赖完整验收工作流，不是另跑一套（`build.yml:9-13`）。
2. `build` 矩阵（windows/macos/ubuntu/ubuntu-arm）跑 `npm run dist`，再跑一次 `electron-builder --config electron-builder.lite.yml` 产出精简版（`build.yml:16-46`）。
3. `android` 作业用 JDK 17 + Gradle 跑 `./gradlew assembleRelease`，产物改名 `QQPet-<version>.apk`（`build.yml:48-84`）。
4. `harmony` 作业跑 `build:harmony-web` + `pack-harmony.mjs`，改版本号后 `assembleHap`（`build.yml:86-130`）。
5. `ios` 作业复用 `ios-build.yml`（`build.yml:132-136`）。
6. `release` 作业 `needs` 全部上述作业，`git lfs pull --include "resources/pet/**"` 后调用 `pack-content.mjs --version … --full --base <上一个 tag> --out artifacts --url-prefix <release 下载前缀>`，把包、`packs.json` 与各平台产物一起上传（`build.yml:138-195`）。带 `-` 的 tag 标记为 prerelease 且不设为 latest，精简版首次运行因此不会挑到 beta。

## 7. 不变量清单

1. 内容包只能写 `pet/` 下的相对路径；zip 必须是 store 模式，且不含 manifest 之外的文件、符号链接、目录项。
2. 每个文件在包内与 `packs.json` 两处都有 SHA-256；下载与安装都必须校验，不允许「先装上再说」。
3. 增量包必须有 `base`，版本严格高于 `base`；`deletes` 只属于增量包，且对更下层生效。
4. `minShell` 是硬门禁：外壳版本低于它时该包不可用，不是警告。
5. 安装/卸载以整个版本目录为单位，使用临时目录 + rename，失败不留半包。
6. 全量包与增量包的命名固定：`QQPet-content-<version>.qqpetpack`、`QQPet-content-<base>-to-<version>.qqpetpack`；`packs.json` 的 `schema` 固定为 `1`。
7. 完整版与精简版安装包共用 `appId` 但内容不同；两者配置文件必须手工保持同步。
8. 各平台 Web 产物目录固定为 `out/{android,harmony,ios,renderer}`；打包脚本以这些路径为输入，路径改名会直接断链。

## 8. 验证命令

```bash
# 内容包格式/分层/安装/查找的单元测试
node --experimental-strip-types --test scripts/tests/content-pack.test.mjs

# 生成一个临时全量包并回读（产物写 tmp/reports 之外的临时目录）
node --experimental-strip-types scripts/pack-content.mjs --version 0.0.1 --out /tmp/qqpet-packs
node --experimental-strip-types -e \
  "import('./src/main/content-pack.ts').then(m => console.log(m.readPack('/tmp/qqpet-packs/QQPet-content-0.0.1.qqpetpack').version))"

# 各平台 Web 构建（也是最常用的快速回归）
npm run build && npm run build:android-web && npm run build:harmony-web && npm run build:ios-web

# iOS 资源只校验不下载
npm run check:ios-assets

# Harmony 打包脚本前置检查（缺产物/资源会直接报错）
node scripts/pack-harmony.mjs
```

内容包测试会校验 manifest 的边界（版本高于 base、`deletes` 仅增量、重复路径、越界路径），改 `content-pack.ts` 后必须重跑。

## 9. 变更影响

- 改 manifest 字段或 `packs.json` schema：已发布的外壳会读不懂新包。必须提升 `packs.json` 的 `schema` 并让新旧外壳各自选择，不能原地改语义。
- 改 `pack-content.mjs` 的文件清单来源（例如改用工作区而非 `HEAD`）：未提交/未跟踪文件会进包，破坏「包内容可追溯到提交」。
- 改 `minShell` 默认值或 `FIRST_PACK_SHELL`：决定旧外壳能否用新包，直接影响精简版首次运行与增量升级路径。
- 改 `deletes` 语义或 `lookup` 的隐藏顺序：会出现「旧文件复活」或「新文件被误隐藏」，只能靠安装层测试发现。
- 改注入脚本的 HTML 入口匹配（`vite.*.config.ts` 的 `transformIndexHtml`）：桥接脚本可能不被打进产物，页面会报无 `window.qqpet`。
- 改完整版/精简版的 `extraResources`：会让精简版意外带内容，或完整版缺资源；两份 yml 必须一起评审。
- 改 CI 的 tag 触发或 release 作业的 `needs`：内容包可能在验收失败时仍被发布，破坏「发布依赖完整验收工作流」的约束（`build.yml:9-13`、`build.yml:138-139`）。
