# 文档同步与开发规范初始化：实现与验收证据

> 结论：本次初始化已把文档规范、检查器、doc-map 和 git hook 接入为可执行门禁；候选分支 `docs/standards-init` 的最终代码 HEAD 为 `bf4d9dba`，独立 verifier Round 2 判定“可合并（本任务范围内）”。尚未合并 `main`，等待人类合并门禁。

## 1. 范围与结果

- 分支：`docs/standards-init`；工作树：`.worktrees/docs-standards`；基于 `main@2b3f4ef7`。
- 最终代码 HEAD：`bf4d9dab`；独立验收报告：[verification.md](verification.md)。
- 交付：唯一入口 `docs/README.md`、5 份规范、已批准方案、8 篇领域文档、runbook、`docs/doc-map.json`、零依赖检查器、CLI、hooks 安装器、`pre-commit`/`commit-msg`、LFS 转发器、AGENTS/CLAUDE 入口。
- 存量 `docs/superpowers/` 已按批准要求全部迁移：验收证据 → `docs/reviews/c12-final-gate/`，历史设计 → `docs/reviews/legacy/`；8 个文件均为 R100，字节一致。
- 未合并、未 push、未改动 main；主工作区原有的未提交 TS 改动、`audit/` 与 pnpm 文件未触碰。

## 2. 提交序列

| 提交 | 内容 |
|---|---|
| `5930b187` | `refactor(acceptance): migrate frozen evidence to docs/reviews`：8 个文件 R100；新验收输出改 `.agent-reports/acceptance/` |
| `70601f35` | `test(docs): add check-docs contract tests`：61 个契约测试（红灯基线） |
| `40fcf872` | `docs(reviews): fix legacy spec path mapping`：冻结索引路径映射修正 |
| `4a98d56d` | `docs: establish living documentation standards and doc map`：入口、规范、架构、指南、runbook、doc-map、AGENTS/CLAUDE |
| `bc0a9f61` | `feat(docs): add zero-dependency docs checker and git hooks`：检查器、CLI、安装器、hooks、CI |
| `9eec5dbc` | `fix(docs): close independent verification gaps`：B1–B5 失败关闭修复 + 7 个回归 + 文档同步 |
| `bf4d9dba` | `fix(test): serialize compat tests to avoid LAN flake`：`test:compat` 固定 `--test-concurrency=1` |

## 3. 测试先行（红灯 → 绿灯）

- 红灯提交：`70601f35`（只有测试，没有实现）。
- 红灯命令与结果：`node --test scripts/docs/tests/*.test.mjs` → 退出 `1`，`tests 61 / pass 0 / fail 61`；失败原因均为 `ERR_MODULE_NOT_FOUND`（`doc-lib.mjs` / `check-docs.mjs` 不存在），而非语义断言失败。
- 实现后：`npm run test:docs` → 退出 `0`，`tests 77 / pass 77 / fail 0`。
- 独立验收后补 B1–B5 回归：`tests 84 / pass 84 / fail 0 / skipped 0`。

## 4. 正向门禁

| 命令 | 退出码 | 关键结果 |
|---|---:|---|
| `npm run test:docs` | 0 | 84 tests / 84 pass / 0 fail / 0 skip |
| `npm run check:docs` | 0 | 目录、命名、H1/结论/行数、索引、链接、代码引用、doc-map 全部通过 |
| `npm run check:docs:staged` | 0 | 当前 staged 未命中映射；独立反例中 require 缺文档→1 |
| `node --check scripts/docs/*.mjs` | 0 | 三个实现文件均无语法错误 |
| `npm run typecheck` | 0 | node/web/harmony/e2e 四套 `tsc --noEmit` 通过 |
| `npm run test:compat` | 0 | 767 tests / 765 pass / 0 fail / 2 skip（既有条件跳过），约 89 秒，自然退出 |
| `npm --prefix server run typecheck` | 0 | 独立 verifier 通过 |
| `npm --prefix server test` | 0 | 独立 verifier Round 1：89 tests / 89 pass / 0 fail；Round 2 未重复（无 server 业务代码改动） |
| `git diff --check` | 0 | 无空白错误 |

## 5. 失败关闭与反例

| 场景 | 实际退出码 | 关键证据 |
|---|---:|---|
| 断链 | 1 | `broken-link`，指向不存在的目标 |
| 新增 living 文档未进 `docs/README.md` | 1 | `unindexed-doc` |
| 零 H1 且已索引 | 1 | `missing-h1` |
| `docs/reports/foo.md` / `docs/slides/foo.md` | 1 | `invalid-location`，不再被目录豁免 |
| staged 命中 `require` 代码但未更新文档 | 1 | `failures` 指向映射文档 |
| 同批 staged 目标文档 | 0 | `stagedDocs` 含目标文档 |
| 删除映射文档冒充“更新” | 1 | 删除状态不计入文档更新 |
| index 与工作区不一致 | 1 | `staged-worktree-divergence` |
| 缺少 / 损坏 `docs/doc-map.json` | 2 | JSON error，`ok:false` |
| 非 git cwd（含 `/tmp` symlink 别名） | 2 | 输出“当前目录不是 git 仓库” |
| `chmod 000` tracked 源码 | 2 | `EACCES`，不再静默跳过 |
| `chmod 000` docs 子目录 | 2 | `EACCES`，不再误报 broken-link/1 |
| staged `docs/reviews` 变更（含 rename 删除侧） | 1 | pre-commit 先拒绝冻结区 |
| `docs/reviews` 无变更但 runtime 缺失 | 2 | pre-commit 提示 `npm run hooks:install` |
| `DOCS_CHECK=off` 无理由行 | 1 | commit-msg 要求 `Docs-Check: off — <≥8字符理由>` |
| `DOCS_CHECK=off` 有理由行 | 0 | commit-msg 放行 |
| 已有其它 `core.hooksPath` / 旧自定义 hook | 1 | 安装器失败关闭、不覆盖 |
| LFS 旧 hook（真实 `core.hooksPath=.githooks`） | 转发 | 4 个 wrapper 均转发参数并透传退出码；不存在/不可执行时 no-op |

## 6. 检查器契约

- 语言/形态：纯 Node 22 ESM `.mjs`，零第三方依赖；`doc-lib.mjs` 纯函数库，`check-docs.mjs` CLI，`install-hooks.mjs` 安装器。
- 命令：`check:docs`、`check:docs:staged`、`test:docs`、`hooks:install`。
- 退出码：`0` 通过（或显式 `DOCS_CHECK=off` 跳过）；`1` 校验失败；`2` 工具/配置/I/O 错误。
- `--json`：full `{mode,ok,issues}`；staged `{mode,ok,failures,warnings,impacts}`；error `{mode,ok:false,error}`；skip `{mode,ok:true,skipped,reason}`。
- 覆盖：living/冻结目录、直接索引与 runbook 二级索引、inline/reference-style/HTML 链接、大小写逐级、禁用文件名、空文档、行数、恰好一个 H1、结论先行、代码注释与 living 文档中的 docs 路径与 `§N`、doc-map 字段/目标/死规则、staged require/warn、index/worktree 分歧。
- 失败关闭：缺/坏 doc-map、非 git、缺 docs、未知参数、Node <22、不可读 tracked 源码或 docs 子树均退出 2，不静默放行。

## 7. doc-map 初始规则

8 条规则，4 `require` / 4 `warn`：

| # | 域 | 目标文档 | 模式 |
|---|---|---|---|
| 1 | desktop-ipc | `docs/architecture/desktop-ipc-and-preload.md` | require |
| 2 | pet-runtime | `docs/architecture/pet-runtime-and-save.md` | require |
| 3 | sync-protocol | `docs/architecture/sync-protocol.md` | require |
| 4 | server-data | `docs/architecture/server-data.md` | require |
| 5 | native-bridge | `docs/architecture/native-bridge.md` | warn |
| 6 | content-packaging | `docs/guides/content-packs-and-builds.md` | warn |
| 7 | deploy-security | `docs/guides/server-deployment.md` + `docs/runbooks/server-recovery.md` | warn |
| 8 | docs-tooling / acceptance | `docs/standards/documentation.md` + `docs/guides/quality-gates.md` | warn |

每条规则都有 `include`/`exclude`/`docs`/`mode`/`reason`；目标均为 living 文档；`include` 均匹配 tracked 文件，无死规则。

## 8. 冻结证据与迁移

- `git show --format= --name-status -M 5930b187`：恰好 8 个 `R100`（3 份验收报告 + 4 份 artifacts + 1 份历史设计）。
- `git diff --name-status 40fcf872..HEAD -- docs/reviews`：空输出；迁移后冻结区零改动。
- `git ls-files docs/superpowers`：空；`docs/superpowers` 目录不存在。
- 冻结报告正文里的旧路径字符串原样保留为历史事实；`docs/reviews/README.md` 记录旧→新映射。
- 新验收证据出口为 `.agent-reports/acceptance/`；新证据不再写入 `docs/reviews/`。
- 候选 worktree 的 `core.hooksPath=.githooks` 是 worktree 级配置；shared/main 未设置，不影响其它 worktree。

## 9. 独立验收

- Round 1（HEAD `bc0a9f61`）：独立 verifier 判定阻塞，发现 B1–B6（LFS 转发、symlink 入口、零 H1、非法目录豁免、I/O 静默、compat 门禁）；原始报告保留在 [verification.md](verification.md)。
- 修复：`9eec5dbc`（B1–B5 + 7 个回归）与 `bf4d9dba`（compat 串行化）。
- Round 2（HEAD `bf4d9dba`）：B1–B6 全部关闭；`test:docs` 84/84、`check:docs` 0、`test:compat` 767/765/0/2、typecheck 0、server typecheck 0；冻结证据 R100/零改动；最终判定“可合并（仅本任务范围）”。

## 10. 未覆盖项与剩余风险

1. **native 注释扫描范围**：检查器的源码扩展名未包含 `.kt`、`.ets`、`.m`、`.h`；这些文件中的 `docs/*.md` 注释引用目前不进入全量链接/章节扫描。native 域仍由 doc-map 的 `warn` 规则提醒。建议后续补词法扫描与 fixture。
2. **`--no-verify`**：本地 Git 允许显式绕过 hook；规范把它列为审查红旗，CI 的 `check:docs` 与合并审查兜底，但无法从历史重建每次 staged 的意图。
3. **compat 串行化的长期稳定性**：`lan.test.mjs` 使用固定 UDP 端口 47777 和短时序断言；固定 `--test-concurrency=1` 消除并行竞争，仍建议在 CI 持续观察。
4. **未跑发布级门禁**：本轮未执行 build、Electron E2E、Docker/proxy smoke 与 `gate:acceptance`；本次变更只触及 docs/scripts/hooks/CI/测试路径，不据此声明发布级验收通过。
5. **已知桌面调度缺陷**：`docs/architecture/pet-runtime-and-save.md` 记录了桌面宿主 `lastSchedulerWallMs` 在不足一分钟的 pump 中前移的问题；未在本任务修复，建议单独开修复任务。
6. 主工作区原有未提交 TS 改动、`audit/`、pnpm 文件保持原样，未纳入本分支。

## 11. 合并请求

候选分支已准备好，等待人类合并批准。批准后建议：

1. 在合并后的主 checkout 运行 `npm run hooks:install`（共享 `core.hooksPath=.githooks`）；
2. 运行 `npm run test:docs`、`npm run check:docs`、`npm run test:compat`；
3. 确认 `docs/reviews/**` 零改动后再合并。

本任务不执行合并、不 push、不发布。
