# AGENTS.md

> 结论：本文件是 qqpet 仓库内所有 agent 的唯一协作事实源；`CLAUDE.md` 只指向本文件，`docs/README.md` 是文档入口。凡本文件与任务描述、聊天记录或历史报告冲突，先按本文件执行，并在交付说明中指出冲突。

## 1. 仓库事实

- 根包 `qqpet` 是 Electron + TypeScript 桌面应用（`package.json`），主进程、preload、渲染层、共享契约分别在 `src/main`、`src/preload`、`src/renderer`、`src/shared`。
- `server/` 是独立的 `qqpet-server` 包（Node.js >= 22、ESM、`node:sqlite`、运行时依赖仅 `ws`），是共享宠物数据的唯一权威端；构建时从仓库根导入 `src/shared/**`，所以 Docker 必须在仓库根构建。
- 多端宿主复用同一份 `window.qqpet` 契约：桌面走 Electron IPC，Android/HarmonyOS 走 `src/android`、`src/harmony` 桥，iOS 走 `src/ios` 与 `ios/native`。
- 文档事实源：`docs/README.md` 是唯一入口；`docs/standards/` 是规则，`docs/specs/` 是已批准方案，`docs/architecture/` 是现状，`docs/guides/` 是操作指南，`docs/runbooks/` 是故障处置；`docs/reviews/**` 是冻结证据，只读。
- 代码与文档的同步关系由 `docs/doc-map.json` 定义，`require` 规则未更新文档即失败，`warn` 规则只提醒。

## 2. 安全红线（不可协商）

1. 不读取 `.env`、凭据文件、token、私钥、生产数据库或生产数据。需要配置样例时只读 `.env.example`、`server/.env.example`；不要把任何真实值写进代码、日志、文档、提交信息或对话。
2. 不修改 `docs/reviews/**`（冻结证据）与已删除的 `docs/superpowers/**`；新验收证据写 `.agent-reports/acceptance/`，临时材料写 `tmp/reports/`。
3. 不静默兜底：缺少凭据、配置、权限、依赖或数据时显式报错并报告；不得编造默认值、空实现、假数据或“先跑通再说”的降级路径来掩盖问题。
4. 不在 URL、查询串、日志或前端可见位置放置配对码、设备 token、owner 凭据、会话答案；服务端只保存哈希，明文只返回一次。
5. 不执行不可逆操作：`git push --force`、删除共享分支、`reset --hard` 覆盖他人提交、恢复/覆盖生产数据库、删除备份、发布 tag/Release、轮换线上密钥、部署生产。未获人类批准一律不做。
6. 不越界写文件：只改任务写作用域；发现他人未提交改动不覆盖、不暂存、不提交。除任务明确要求外不运行 `git add`、`git commit`、`git checkout`。

## 3. 三道人类门禁

人类只保留以下三个门禁，其余执行细节由 agent 负责：

| 门禁 | 触发条件 | 未批准时 |
|---|---|---|
| 规格门禁 | 重大变更开始实现前，批准 `tmp/specs/` 草稿并允许写入 `docs/specs/` | 只做调查和草稿，不写实现 |
| 不可逆门禁 | 任何不可逆操作（见 §2 第 5 条） | 停在操作前，给出影响与回滚方案 |
| 合并门禁 | 分支合入 `main`、发布分支或受保护分支 | 保持分支可评审，不合并 |

测试职责不下放给人类复核：测试 agent 全权负责测试设计、失败复现、实现、执行与迭代；人类只评审需求、规格、权衡和最终合并。重大变更的独立 verifier 必须是未参与实现的 agent。

## 4. 分支与合并规则

- `main` 受保护：不直接提交，不未经批准合并；合并必须同时满足 §5 质量门禁、独立审查、无未决阻塞。
- 分支按变更类型命名：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`agent/<主题>`；多 agent 并行时使用独立 worktree（`.worktrees/<主题>`）。
- 一个分支只做一个逻辑变更；提交信息用 Conventional Commits（`feat(scope): ...`、`fix(scope): ...`、`docs(scope): ...`、`test(scope): ...`）。
- 不 rebase 已共享分支；同步主线用 merge，不用强推改写历史。
- 不提交 `node_modules/`、`out/`、`dist/`、`tmp/`、运行时凭据、`.DS_Store`；`.agent-reports/` 的交付报告/验收证据可提交，原始大体积 artifacts 由任务决定是否提交或清理；不把生成物混进文档提交。
- 合并前必须检查完整 diff（含未跟踪文件），确认没有夹带无关改动、调试输出、硬编码路径或密钥。

## 5. 质量门禁

按从快到慢执行；受影响范围必须跑，不能只跑“看起来相关”的子集。

| 命令 | 覆盖 | 何时必须 |
|---|---|---|
| `npm run typecheck` | 根仓库 node/web/harmony/e2e 四套 `tsc --noEmit` | 任何 TypeScript 改动 |
| `npm run test:compat` | `scripts/tests/*.test.mjs`（含共享运行时、协议、存储、桥接测试） | 任何 `src/shared/**`、`src/main/**`、移动桥或脚本改动 |
| `npm run test:docs` | docs 检查器自身的单元/契约测试 | 任何 `scripts/docs/**` 改动 |
| `npm run check:docs` | 全量文档结构、H1/结论/行数、索引、链接、命名、代码注释引用、doc-map 死规则；I/O 错误显式失败 | 任何 `docs/**`、`AGENTS.md`、`CLAUDE.md`、doc-map 改动 |
| `npm run check:docs:staged` | staged 代码是否同步了 `require` 文档、`warn` 提醒、index/worktree 一致性 | 提交前（hook 自动执行） |
| `npm run check:docs:range` | 逐提交检查（默认从 doc-map `rangeBaseline` 初始化边界起，缺失回退 `origin/main..HEAD`/`main..HEAD`）：`require` 缺文档失败、`warn` 提醒、触碰冻结证据失败、merge 用第一父 diff；忽略 `DOCS_CHECK=off` | 推送前（`pre-push` 自动执行）与 CI |
| `npm run build` | Electron 主进程/preload/渲染层构建 | 影响打包、入口、资源或构建配置 |
| `npm run build:android-web` / `npm run build:harmony-web` / `npm run build:ios-web` | 对应平台 Web 产物 | 影响对应平台 |
| `npm --prefix server run typecheck` | 服务端 TypeScript | 任何 `server/src/**`、`server/test/**` 改动 |
| `npm --prefix server test` | 服务端集成测试（构建后运行） | 任何服务端行为、协议、SQLite、调度改动 |
| `npm --prefix server run build` | 服务端产物 | 服务端改动或部署验证前 |
| `npm run test:e2e` | 真实服务端 + 两个 Electron 渲染进程 | 影响 IPC、存储、服务端同步、启动流程 |
| `npm run test:e2e:main-process` | 主进程级 E2E（真实服务端与远程仓库路径） | 主进程/远程仓库路径改动 |
| `npm run validate:evidence -- <e2e\|docker\|proxy\|gate> [路径]` | 校验一份证据报告本身 | 提交或接收验收证据时 |
| `npm run smoke:compose` / `npm run smoke:docker` / `npm run smoke:proxy` | Compose 失败关闭、镜像/备份恢复、TLS/WSS 代理 | 部署、镜像、代理、健康检查改动 |
| `npm run gate:acceptance` | 发布阻断级完整验收，证据写 `.agent-reports/acceptance/` | 发布前或任务明确要求时 |

CI 事实：`.github/workflows/ci.yml` 含 `root`（typecheck、test:docs、check:docs、check:docs:range、compat、四个 Web 构建）、`server`（typecheck + test）、`e2e`、`docker-smoke`、`proxy-wss` 五个作业；`.github/workflows/build.yml` 负责 tag 发布产物。CI 绿灯不能替代本地针对性验证，CI 未覆盖的改动必须在交付说明中写明验证方式。

### 5.1 文档门禁的退出码与跳过

- `check:docs`、`check:docs:staged`、`check:docs:range` 退出码：`0` 通过；`1` 校验失败（结构/索引/链接/命名/行数/doc-map/staged 缺文档/range 内提交缺文档）；`2` 工具或配置错误（非 git 仓库、缺 `docs/`、缺/损坏 `doc-map.json`、未知参数、`--range` 基线不存在、Node 版本不足，或无法读取 tracked 源码 / docs 子树 / git 对象）。
- `2` 表示检查器没有完成检查，不得当作通过，也不得用跳过开关掩盖；先修工具链或环境。
- 仅当确认本次改动无需更新文档时，才允许 `DOCS_CHECK=off` 跳过**文档检查**；提交信息必须包含一行 `Docs-Check: off — <至少 8 个字符的理由>`，由 `commit-msg` 钩子强制校验。该开关不影响 `typecheck`、测试、构建、服务端门禁。
- 该开关只影响全量与 staged 检查：`check:docs:range` 始终执行，只在提交信息带合法 trailer 时豁免该提交的 `require` 缺文档；缺行或理由少于 8 个字符仍判 `1`。冻结证据（`docs/reviews/**`、`docs/superpowers/**`）不接受任何豁免。
- `docs/doc-map.json` 顶层 `rangeBaseline` 是**一次性初始化边界**（完整 40 位 commit SHA），只用于让新门禁不反噬初始化历史；它不是免检开关——基线之后的每个提交仍逐提交检查。字段缺失回退 `origin/main`/`main`；字段存在但格式非法或不是仓库内提交 → `2`。
- 本地 Git 无法从技术上阻止 `git commit --no-verify`，但绕过提交会在 `pre-push`（range 不通过即拒绝推送且不转发 LFS）与 CI root job 的 `check:docs:range` 被检出并阻断；不得用 `--no-verify` 绕过 hook，确需绕过时必须先获得人类批准，并在交付说明中记录跳过的检查、原因和补偿验证。
- Hook 安装：`npm run hooks:install`。`pre-commit` 先拒绝任何 `docs/reviews/**` 变更，再跑全量文档检查与 staged 文档同步检查；`commit-msg` 校验跳过理由；`pre-push` 先解析 `.githooks/runtime`（缺失/不可执行/Node < 22 → 2），跑 range 检查通过后才转发旧 LFS pre-push。未安装 hook 的 worktree 视为未完成环境准备。

## 6. 文档规则摘要

- 每篇 living 文档只有一个 H1；H1 后第一段以 `> 结论：` 开头，先给结论再展开。
- 行数上限：`architecture`/`specs`/`standards` 600 行，`guides` 1000 行，`runbooks` 900 行，索引类 500 行。
- 文件名稳定且唯一，禁止版本号、`final`、`old`、`copy`、`tmp`、`draft`、`副本`、`备份`、`最终版`、`草稿` 等标记；日期只用于 `docs/reviews/**` 冻结证据。
- 文档写当前实现和可验证事实：代码位置（`path:line`）、契约/不变量、失败模式、验证命令、变更影响；不写通用最佳实践、愿望清单或聊天记录。
- 行为或契约变更必须在**同一个提交**里更新映射文档；新增代码域时同步维护 `docs/doc-map.json`，不得留下死规则。
- 一次性记录不进 living docs：草稿放 `tmp/specs/`，证据放 `.agent-reports/acceptance/`，临时报告放 `tmp/reports/`；交付证据可提交，原始大体积生成物按任务清理；`tmp/` 一律忽略；living docs 用链接引用证据，不复制正文。
- 模块 README 例外：根 `README.md`、`server/README.md`、`ios/README.md` 是模块/入口说明，不套用 living docs 结构，但必须保持事实准确、被 `docs/README.md` 直接链接，且不与 `docs/architecture/**` 重复；跨模块结论应上移到架构文档并留下指针。

详细规则见 [文档规范](docs/standards/documentation.md)；变更分级见 [变更管理](docs/standards/change-management.md)；审查不变量见 [Agent 变更审查](docs/standards/agent-change-review.md)。

## 7. 变更分级与完成定义

- 重大变更：协议/线格式、存档 schema、权威与恢复世代、IPC/preload 契约、原生桥契约、部署安全边界、CI/质量门禁、不可逆数据操作。必须先有批准稿并走完整测试先行流程。
- 小变更：局部 UI/文案、测试补充、文档修订、不改变契约的修复。可直接实现，但仍须通过受影响的测试与合并门禁。
- 完成定义：失败测试先红且红灯原因正确 → 实现后目标测试转绿 → 受影响门禁命令全部通过 → 文档同提交更新 → 工作区无无关改动 → 交付报告包含文件清单、命令、退出码、证据路径和遗留风险。
- 任务终态只能是 `completed`（验收全部满足）或 `blocked`（给出具体阻塞条件、已尝试步骤、需要谁做何决定）；不得用“基本完成”“应该可以”代替。

## 8. 证据与交付

- 历史验收证据在 `docs/reviews/c12-final-gate/`，历史设计在 `docs/reviews/legacy/2026-10-20-local-or-server-pet-data-design.md`；只读引用，不修改。
- 新证据写 `.agent-reports/acceptance/`：交付报告/验收证据可提交，原始大体积 artifacts 由任务决定是否提交或清理；`tmp/` 一律忽略。命令输出只保留关键摘要和路径，不粘贴大段日志或任何敏感值。
- 向父 agent 汇报时带上：分配的 tree/task ID、新增/修改文件与行数、运行过的命令及退出码、关键证据路径、与其他作者路径的冲突、剩余工作。
