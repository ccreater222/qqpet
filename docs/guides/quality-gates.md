# 质量门禁与证据

> 结论：本仓库的质量门禁按「类型 → 单元/契约测试 → 构建 → 服务端 → 端到端 → 部署冒烟 → 发布验收」分层，每一层都有确定的命令、退出码和证据落点。文档检查器使用 0/1/2 三态退出码（2 表示检查器没跑成，不得当作通过）；验收门禁则用 0/1 表示整体通过/失败，且退出码 0 本身不算通过——门禁会重新解析 E2E、Docker、TLS/WSS 报告，要求它们绑定当前 HEAD 且证据齐全。

## 1. 命令清单与适用条件

代码位置写作 `path:line`。省略前缀的约定：`acceptance-gate.mjs`、`validate-evidence.mjs` 在 `scripts/`；`acceptance-evidence.mjs` 在 `scripts/lib/`；`ci.yml`、`build.yml` 在 `.github/workflows/`；`package.json` 指仓库根。

根 `package.json` 的脚本即事实源（`package.json:10-34`），服务端脚本在 `server/package.json:13-23`。

| 命令 | 实际执行 | 何时必须 | 退出码 |
| --- | --- | --- | --- |
| `npm run typecheck` | 四套 `tsc --noEmit`：node、web、harmony、e2e（`package.json:14`） | 任何 TypeScript 改动 | 0/非 0 |
| `npm run test:compat` | `node --experimental-strip-types --test --test-concurrency=1 scripts/tests/*.test.mjs`（`package.json:31`） | `src/shared/**`、`src/main/**`、移动桥、脚本改动 | 0/1 |
| `npm run test:docs` | docs 检查器自身的单元/契约测试（`scripts/docs/tests/*.test.mjs`） | 任何 `scripts/docs/**` 改动 | 0/1 |
| `npm run check:docs` | 全量文档结构、H1/结论/行数、索引、链接、命名、代码注释引用、doc-map 死规则；I/O 错误显式失败 | 任何 `docs/**`、`AGENTS.md`、`CLAUDE.md`、doc-map 改动 | 0/1/2 |
| `npm run check:docs:staged` | staged 代码是否同步了 `require` 文档、`warn` 提醒、index/worktree 一致性 | 提交前（`pre-commit` 自动执行） | 0/1/2 |
| `npm run check:docs:range` | 逐提交检查（默认从 doc-map `rangeBaseline` 初始化边界起，缺失回退 `origin/main..HEAD`/`main..HEAD`；可显式传 `<base>..<head>`）的 `require`/`warn`，并用第一父 diff 覆盖 merge commit；触碰冻结证据直接失败；忽略 `DOCS_CHECK=off` | 推送前（`pre-push` 自动执行）、CI root job | 0/1/2 |
| `npm run build` | `electron-vite build`（主进程/preload/渲染层） | 影响打包、入口、资源、构建配置 | 0/非 0 |
| `npm run build:android-web` / `build:harmony-web` / `build:ios-web` | 三个平台 Web 产物到 `out/{android,harmony,ios}` | 影响对应平台 | 0/非 0 |
| `npm --prefix server run typecheck` | `tsc -p tsconfig.json`（`noEmit`，含 `src/**`、`test/**`、`../src/shared/**`） | 任何 `server/src/**`、`server/test/**` 改动 | 0/非 0 |
| `npm --prefix server test` | 先 `build`（`tsc -p tsconfig.build.json` + `fix-esm-imports.mjs`），再 `node --test dist/server/test/*.test.js` | 服务端行为、协议、SQLite、调度改动 | 0/1 |
| `npm --prefix server run build` | 生成 `server/dist` | 服务端改动、部署验证前 | 0/非 0 |
| `npm run test:e2e` | `node scripts/e2e/renderer-e2e.mjs`：真实服务端 + 两个 Electron 渲染进程 | IPC、存储、同步、启动流程改动 | 0/1 |
| `npm run test:e2e:main-process` | `node scripts/e2e/run-e2e.mjs`：主进程级 E2E | 主进程/远程仓库路径改动 | 0/1 |
| `npm run smoke:compose` | `scripts/compose-smoke.mjs`：Compose 凭据失败关闭 | 部署/Compose 改动 | 0/1 |
| `npm run smoke:docker` | `scripts/docker-smoke.mjs`：镜像、就绪、非 root、备份恢复 | 镜像/服务端/部署改动 | 0/1 |
| `npm run smoke:proxy` | `scripts/e2e/proxy-smoke.mjs`：Nginx 自签 TLS + WSS | 代理/TLS/健康路由改动 | 0/1 |
| `npm run validate:evidence -- <kind> [路径]` | 校验一份证据报告本身（`kind` 为 `e2e`/`docker`/`proxy`/`gate`） | 收到/提交验收证据时 | 0/1 |
| `npm run gate:acceptance` | `scripts/acceptance-gate.mjs`：12 条发布阻断命令 + 证据解析 | 发布前或任务明确要求 | 0/1 |
| `npm run hooks:install` | 安装 `.githooks`（`core.hooksPath`） | worktree 环境准备 | 0/非 0 |

`npm run test:compat` 也可以只跑单个文件（Node 原生 test runner）：

```bash
node --experimental-strip-types --test scripts/tests/sync-protocol.test.mjs
```

兼容测试固定 `--test-concurrency=1`：`lan.test.mjs` 使用真实 UDP 端口 47777 和短时序断言，并行跑其它测试文件会造成假失败；串行后 767 个用例约 90 秒，仍远低于 CI 的 root 作业超时。

## 2. 退出码语义

### 2.1 文档检查器：0 / 1 / 2

`check:docs`、`check:docs:staged` 与 `check:docs:range` 的退出码是三态的，含义不可互换（`AGENTS.md` §5.1）：

| 退出码 | 含义 | 处理方式 |
| --- | --- | --- |
| `0` | 全部检查通过 | 可继续 |
| `1` | 校验失败：结构、索引、链接、命名、行数、doc-map 规则、staged 缺文档、range 内某个提交缺文档 | 修文档/代码，不得跳过 |
| `2` | 工具或配置错误：非 git 仓库、缺 `docs/`、缺或损坏 `doc-map.json`、未知参数、`--range` 基线不存在、Node 版本不足，或无法读取 tracked 源码 / docs 子树 / git 对象（EACCES、EPERM 等） | 修环境或工具；**这不代表检查通过** |

`2` 的存在意义是把「检查没完成」和「检查发现有错」分开。把 `2` 当成 `0` 或直接跳过，等于让文档门禁失效。

`check:docs:range` 逐提交比对 doc-map：`require` 命中代码但同一提交没有更新映射文档 → `1`；`warn` 只打印提醒 → `0`；删除文档不算更新，删除代码仍算变更；空范围 → `0`；`--range` 与 `--staged` 同用 → `2`。它包含 merge commit，并用第一父 diff 评估冲突解决时引入的改动；任何提交触碰 `docs/reviews/**` 或 `docs/superpowers/**` → `1`（`frozen-evidence-modified`），即使 doc-map 未命中或提交信息带跳过 trailer。

基线优先级：显式 `--range <base>..<head>` > doc-map 顶层 `rangeBaseline`（一次性初始化边界，完整 40 位 SHA）> `origin/main..HEAD` > `main..HEAD`。`rangeBaseline` 只是初始化边界，不是免检开关：基线之后仍逐提交检查；字段存在但不是仓库内提交或格式非法 → `2`，三种来源都不可用 → `2`。当前值指向文档体系首次合入 `main` 的 merge commit `b23109a2bd468a8d30c08ed066b8ffb96469915a`。

跳过开关只有一个：`DOCS_CHECK=off`，且只跳过全量与 staged 两种**文档检查**；提交信息必须包含一行 `Docs-Check: off — <至少 8 个字符的理由>`，由 `commit-msg` 钩子强制校验。它不影响 `typecheck`、测试、构建、服务端门禁，也不会让 `check:docs:range` 放行——range 只接受提交信息里带合法 trailer 的豁免。

本地 Git 无法从技术上阻止 `git commit --no-verify`；防绕过依赖 `.githooks/pre-push`（range 不通过即拒绝推送，且不转发 LFS）与 CI root job 的 `check:docs:range`。不得用 `--no-verify` 绕过 hook。

### 2.2 验收门禁：0 / 1

`scripts/acceptance-gate.mjs` 只有两种终态：全部通过时进程不设置 `exitCode`（即 0），否则设置 `1`（`acceptance-gate.mjs:519-527`）。它没有「工具错误」这一档：门禁自身抛错也以 `1` 结束，错误信息写 `[gate] FAILED TO RUN: …`。因此看到 1 时必须读报告里的失败段，区分「某条命令失败」与「门禁没跑起来」。

`validate-evidence.mjs` 同样是 0/1：校验通过打印 `[evidence] PASS <kind>: <path>`，失败逐条打印 `- <error>` 并以 1 结束（`validate-evidence.mjs:214-249`）。

## 3. 验收门禁的 12 条命令

`REQUIRED_GATE_COMMAND_IDS` 固定了发布阻断集合（`scripts/lib/acceptance-evidence.mjs:101-115`）：

| id | 命令 |
| --- | --- |
| `root-typecheck` | `npm run typecheck` |
| `root-compatibility-tests` | `npm run test:compat` |
| `desktop-build` | `npm run build` |
| `android-web-build` | `npm run build:android-web` |
| `harmony-web-build` | `npm run build:harmony-web` |
| `ios-web-build` | `npm run build:ios-web` |
| `server-typecheck` | `npm --prefix server run typecheck` |
| `server-tests` | `npm --prefix server test` |
| `real-server-two-electron-e2e` | `npm run test:e2e` |
| `docker-compose-credential-smoke` | `npm run smoke:compose` |
| `docker-image-backup-restore-smoke` | `npm run smoke:docker` |
| `tls-wss-proxy-smoke` | `npm run smoke:proxy` |

门禁不是简单串行执行命令。三条硬约束写在 `acceptance-gate.mjs:1-10`：

1. **退出码 0 不够**：E2E、Docker、TLS/WSS 三份报告必须被重新解析，独立证明其必需证据在**当前 revision** 上成立。
2. **报告必须绑定当前提交**：每份报告的 `codeRevision` 必须等于当前 HEAD（`acceptance-evidence.mjs:346-351`、`:816-821`）；gate summary 还会把 e2e/docker/proxy 的 `reportSha256` 与 `codeRevision` 绑进自身（`validate-evidence.mjs:204-219`），只有 summary 被改写而底层报告没变是过不了的。
3. **工作区必须干净**：命令执行前后都检查 `git status --porcelain`，唯一允许的脏文件是生成物——`.agent-reports/acceptance/artifacts/**`、日期命名的 gate 报告，以及 `out/{docker-smoke-,compose-smoke-,proxy-smoke-,acceptance-gate-}` 前缀的临时产物（`acceptance-evidence.mjs:197-204`）。

## 4. 证据落点

证据分三处，用途不同，不能互相顶替：

| 位置 | 内容 | 性质 |
| --- | --- | --- |
| `docs/reviews/c12-final-gate/` | 3 份冻结验收报告（2026-10-22、2026-10-23、2026-11-18）及其 artifacts | **只读历史证据**；禁止新增、修改、覆盖 |
| `docs/reviews/legacy/2026-10-20-local-or-server-pet-data-design.md` | 历史设计文档 | 冻结，被测试读取，不修改 |
| `.agent-reports/acceptance/` | 新的验收报告与机器可读 artifacts | 新证据落点；可作为任务交付证据提交，原始大体积 artifacts 由任务决定是否保留/清理 |
| `tmp/reports/` | 临时复现材料、一次性日志、排查输出 | 临时材料，不进 living docs，不作为交付证据 |

`.agent-reports/acceptance/` 的目录约定由脚本固定（`acceptance-gate.mjs:30-39`、`validate-evidence.mjs:17-23`）：

```
.agent-reports/acceptance/<YYYY-MM-DD>-c12-final-gate.md
.agent-reports/acceptance/artifacts/c12-e2e/c12-e2e-report.json
.agent-reports/acceptance/artifacts/c12-docker/docker-smoke-report.json
.agent-reports/acceptance/artifacts/c12-proxy/proxy-smoke-report.json
.agent-reports/acceptance/artifacts/c12-gate/gate-summary.json
```

历史报告中的旧路径字符串保持原样，不要"修正"；需要追溯时按 `docs/reviews/README.md` 的映射表换算。

## 5. 校验证据（而不是相信结论）

`npm run validate:evidence` 有四种 kind，缺省路径见上表；也可以显式传路径（`validate-evidence.mjs:148-150`）。它检查的要点：

- 结构与必填字段：`kind`、`result`、`codeRevision`、时间戳、`passed`/`evidence` 段。
- 新鲜度：报告不能来自另一个 revision，也不能引用不存在的证据文件。
- 内容真实性：E2E 报告必须包含 `REQUIRED_E2E_SCENARIO_NAMES` 全部场景与渲染进程证明；Docker 报告必须证明非 root、`journal_mode=WAL`、`synchronous=FULL`、备份/恢复内容一致；代理报告必须证明 TLS 终结、`/v1/sync` 与 `/sync` 的认证 WSS 升级、四个健康路由。
- 绑定关系：`gate` kind 会重新读取三份默认报告，按 sha256、result、revision 与 summary 对照（`validate-evidence.mjs:204-219`）。

这解释了为什么「手工写一份看起来通过的 md」没有意义：md 报告只是人读摘要，机器校验读的是 JSON 与 git revision。

## 6. Hook 与 staged 一致性

- `npm run hooks:install` 把 `core.hooksPath` 指向仓库内的 `.githooks`；安装器在已有自定义 hook、非仓库目录、Node 版本不足时显式失败，不覆盖用户配置。
- LFS 旧 hook 通过 `.githooks/post-checkout`、`post-commit`、`post-merge` 转发到 `$(git rev-parse --git-common-dir)/hooks/<hook>`；旧 hook 不存在或不可执行时 no-op，不能因为切换 hooksPath 而禁用 LFS。
- `pre-push` 是防绕过门禁：先解析 `.githooks/runtime`（缺失、不可执行或 Node < 22 → `2`），再跑 `check-docs.mjs --range`；range 非 `0` 直接退出且**不转发**旧 LFS hook；range 通过后才转发旧 `pre-push`（同一 common-dir 定位），参数与退出码原样透传。
- `pre-commit` 的顺序是：先拒绝任何 `docs/reviews/**` 的 staged 变更（冻结区不可改），再跑全量 `check:docs`，最后跑 `check:docs:staged` 校验本次 staged 代码是否同步了文档。
- `commit-msg` 只在提交信息含跳过声明时校验 `Docs-Check: off — <理由>`。
- `check:docs:staged` 的判定基于 index 与工作区的对比：`require` 规则命中的代码有 staged 变更而目标文档没有同批更新 → 1；`warn` 规则只提示 → 0；删除文档不算更新；index 与 worktree 对同一路径的分歧 → 1。完整规则见 `docs/standards/documentation.md` 与 `docs/doc-map.json`。

## 7. CI 与本地门禁的对应关系

| CI 作业（`.github/workflows/ci.yml`） | 覆盖 |
| --- | --- |
| `root`（`:18-48`） | `typecheck`、`test:docs`、`check:docs`、`check:docs:range`、`test:compat`、`build`、三个平台 Web 构建 |
| `server`（`:49-64`） | `npm --prefix server run typecheck`、`npm --prefix server test` |
| `e2e`（`:65-104`） | `xvfb-run -a npm run test:e2e`，随后 `validate-evidence.mjs e2e …` |
| `docker-smoke`（`:105-148`） | `smoke:compose`、`smoke:docker`、`validate:evidence -- docker …` |
| `proxy-wss`（`:149-175`） | `smoke:proxy`、`validate:evidence -- proxy …` |

`root` 作业以 `fetch-depth: 0` 检出并直接运行 `npm run check:docs:range`：基线由 `docs/doc-map.json` 的 `rangeBaseline`（初始化边界）决定，因此 fork PR 也不会把上游无关历史算进来；基线缺失时回退 `origin/main`/`main`，三者都不可用时以 `2` 失败而不是放行。基线之后的所有提交仍逐提交检查。

`build.yml` 的 `acceptance` 作业直接 `uses: ./.github/workflows/ci.yml`（`build.yml:9-13`），发布产物依赖同一套验收，不存在"发布专用的宽松检查"。

CI 绿灯不能替代本地针对性验证：CI 不跑文档检查器的本地 hook 路径，也不一定覆盖你改到的具体平台；未覆盖的部分必须在交付说明里写明验证方式。

## 8. 不变量清单

1. 影响范围的命令必须真跑，不能用"看起来相关"的子集代替；受影响平台各自的 `build:*` 要单独过。
2. 文档检查的 `2` 不等于通过；出现 `2` 先修工具/环境。
3. 验收结论必须绑定当前 HEAD；换 revision 后旧证据作废，需要重跑。
4. 门禁运行前后工作区只能有生成物脏文件；源码/配置/测试改动一律阻断。
5. `docs/reviews/**` 只读；新证据只写 `.agent-reports/acceptance/`。
6. 跳过开关只影响文档检查，且必须留下理由行；不得用 `--no-verify`。
7. 证据的机器可读部分是 JSON 与 git revision，不是 markdown 叙述。

## 9. 验证命令

```bash
# 文档检查器自身测试
npm run test:docs

# 全量文档检查（0 通过 / 1 校验失败 / 2 工具或配置错误）
npm run check:docs

# 提交前 staged 同步检查
npm run check:docs:staged

# 逐提交检查 origin/main..HEAD（pre-push 与 CI 同款；可用 --range <base>..<head> 覆盖）
npm run check:docs:range

# 代码与产物门禁
npm run typecheck
npm run test:compat
npm run build
npm --prefix server run typecheck
npm --prefix server test

# 端到端与部署冒烟
npm run test:e2e
npm run smoke:compose
npm run smoke:docker
QQPET_PROXY_NGINX_IMAGE=nginx:1.27-alpine npm run smoke:proxy

# 完整验收（产物写 .agent-reports/acceptance/）
npm run gate:acceptance
npm run validate:evidence -- gate
```

## 10. 变更影响

- 改 `REQUIRED_GATE_COMMAND_IDS` 或门禁命令集合：发布阻断范围随之变化；必须同步 `ci.yml` 的作业、本文第 3 节与 `docs/standards/agent-change-review.md` 的硬门禁表。
- 改 `pack-content`/验收脚本的证据目录：`validate-evidence` 的缺省路径与 `isGeneratedAcceptancePath` 白名单必须同时改，否则门禁会把刚生成的文件当成"工作区脏"而失败。
- 改退出码语义（例如给验收门禁加 `2`）：所有消费方（CI、脚本、hook）都要同步，否则会把工具错误当成校验失败。
- 改 `check:docs` 的检查项或行数上限：会立刻改变现有文档的通过状态；必须同时更新 `docs/standards/documentation.md` 与本文档的命令表。
- 改 `pre-commit` 顺序：若把 `docs/reviews` 冻结检查放到文档检查之后，冻结区可能先被其它检查"合理化"，失去只读保护。
- 改 E2E/Docker/代理报告字段：会让历史报告与新版校验器不兼容；历史报告在 `docs/reviews/**` 不可改，只能保证校验器对旧报告的兼容或明确拒绝。
