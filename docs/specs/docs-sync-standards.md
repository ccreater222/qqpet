# 文档同步规范（初始化批准稿）

> 结论：本方案为 qqpet 建立一套零依赖、可执行的文档同步体系：`docs/` 只保留 living 文档与冻结证据，代码域通过 `docs/doc-map.json` 映射到文档，`check:docs` 与 `check:docs:staged` 分别做全量和提交前校验，不通过即阻塞。历史 `docs/superpowers/` 已按字节迁移到 `docs/reviews/` 并删除原目录；新证据只写 `.agent-reports/acceptance/`。

- 状态：已批准（2026-11-18）
- 范围：`docs/**`、`scripts/docs/**`、`.githooks/**`、`package.json`、`.gitignore`、`.github/workflows/ci.yml`、`AGENTS.md`、`CLAUDE.md`
- 不在范围：业务功能实现、线上部署变更、冻结证据正文改写

## 1. 背景与问题

当前仓库的文档分散在根 `README.md`、`server/README.md`、`ios/README.md`、`docs/superpowers/**` 与代码注释中，存在四类问题：

1. 一次性验收报告与长期文档混在一起，读者分不清哪些是现状、哪些是历史快照。
2. 代码契约（IPC、同步协议、SQLite schema、原生桥、部署）缺少与实现同步的架构文档。
3. 没有稳定的文档入口，链接、命名、行数和结论位置依赖人工记忆。
4. 没有可执行的文档门禁，代码改动可以完全绕过文档更新。

本方案不引入第三方依赖，使用 Node.js 22 内置能力与 `node:test`，避免为文档检查增加安装负担。

## 2. 目标

1. 建立唯一入口 `docs/README.md`，按“先读/规格/架构/指南/运维/冻结证据”分组，直接链接所有 living 文档。
2. 将 `docs/` 收敛为六类：入口、规范、规格、架构、指南、运维；冻结证据单独放 `docs/reviews/`。
3. 用 `docs/standards/documentation.md` 固化命名、结构、结论先行、行数上限、同提交更新、一次性记录边界。
4. 用 `docs/doc-map.json` 把 8 个契约代码域映射到目标文档，4 条 `require` 阻塞、4 条 `warn` 提醒。
5. 提供零依赖检查器：全量结构/索引/链接/命名/行数/代码注释引用/doc-map 检查，以及 staged 代码-文档同步检查。
6. 通过 `.githooks` 把检查接到提交前；提供明确的跳过开关与审计理由。
7. 迁移历史证据到 `docs/reviews/`，删除 `docs/superpowers/`，新证据改写到 `.agent-reports/acceptance/`。
8. 在 `AGENTS.md` 固化质量门禁、分支/合并规则、安全红线和三个人类门禁。

## 3. 非目标

- 不引入 ESLint、Prettier、TypeDoc、文档站点生成器或第三方链接检查库。
- 不自动重写文档、不自动生成架构文档正文、不自动修复链接。
- 不做发布站点、搜索、版本化文档快照；历史只通过 `docs/reviews/` 保留。
- 不改变现有业务行为、协议、数据库 schema 或部署方式。
- 不把检查器做成“尽量放行”：工具错误必须显式失败。
- 不覆盖或改写 `docs/reviews/**` 中的冻结报告与 artifacts。

## 4. 目录与分类

```text
docs/
  README.md                 唯一入口索引
  doc-map.json              代码域 → 文档映射
  standards/                协作与工程规范
  specs/                    已批准方案（含本文件）
  architecture/             当前实现与契约
  guides/                   操作、构建、部署、质量门禁
  runbooks/                 故障处置（README.md 为二级索引）
  reviews/                  冻结证据（只读）
    README.md               冻结说明与历史路径映射
    c12-final-gate/         历史验收报告 + artifacts
    legacy/                 历史设计稿
  screenshots/              根 README 使用的截图
```

分类规则：

| 分类 | 判定 | 处理 |
|---|---|---|
| living | `docs/README.md`、`docs/reviews/README.md`、`docs/{standards,specs,architecture,guides,runbooks}/**/*.md` | 可改，受结构/索引/行数/链接检查 |
| frozen | `docs/reviews/**`（除 `README.md`） | 只读，禁止新增/修改/删除 |
| invalid | 其它 `docs/**/*.md` | 检查失败，要求移动或删除 |

## 5. 文档规则（检查器执行）

1. 每篇 living 文档恰好一个 H1；代码块内的 `#` 不计。
2. H1 后第一段内容必须以 `> 结论：` 开头。
3. 至少 5 个非空行；空文档视为失败。
4. 行数上限：`architecture`/`specs`/`standards` 600 行，`guides` 1000 行，`runbooks` 900 行，索引 500 行。
5. 文件名禁止版本号与临时标记：`v2`/`v3`/`v4`/`final`/`old`/`copy`/`tmp`/`draft`，以及 `副本`/`备份`/`最终版`/`草稿`。
6. `docs/README.md` 必须直接链接所有 living 文档；`docs/runbooks/README.md` 必须登记每个 runbook。
7. 相对链接必须逐级大小写匹配真实文件；行内链接、reference-style 链接、HTML `src`/`href` 都检查；fence 与 inline code 内忽略；外链、纯锚点、URL 编码按规则解析。
8. 代码注释引用 `docs/*.md` 时必须存在；带 `§N` 时对应标题必须存在；字符串字面量中的路径不误报。
9. 一次性记录不进 living docs：草稿 `tmp/specs/`，新证据 `.agent-reports/acceptance/`，临时报告 `tmp/reports/`。

## 6. `docs/doc-map.json` 契约

结构：

```json
{
  "version": 1,
  "rules": [
    {
      "include": ["server/src/db.ts"],
      "exclude": [],
      "docs": ["docs/architecture/server-data.md"],
      "mode": "require",
      "reason": "SQLite schema 与恢复世代是部署契约"
    }
  ]
}
```

字段与语义：

- `include`：仓库相对 glob；`*` 不跨目录，`**` 可跨目录；必须至少匹配一个 `git ls-files` 的 tracked 文件，否则是死规则。
- `exclude`：同一 glob 语义的排除列表，可为空数组。
- `docs`：至少一个已存在的 living 文档；不能指向 `docs/reviews/**` 或不存在路径。
- `mode`：`require` 表示代码变更必须同时更新目标文档；`warn` 只提醒。
- `reason`：非空，说明该代码域为什么属于契约面。

初始 8 条规则（4 require / 4 warn）：

| # | 代码域 | 目标文档 | 模式 |
|---|---|---|---|
| 1 | Electron 主进程、preload、IPC/投影契约 | `docs/architecture/desktop-ipc-and-preload.md` | require |
| 2 | 宠物运行时、存档、本地权威 | `docs/architecture/pet-runtime-and-save.md` | require |
| 3 | 同步协议、远程仓库、服务端会话/命令 | `docs/architecture/sync-protocol.md` | require |
| 4 | SQLite schema、锁、覆盖度、portable import、备份恢复 | `docs/architecture/server-data.md` | require |
| 5 | Android/iOS/Harmony 原生桥与移动共享层 | `docs/architecture/native-bridge.md` | warn |
| 6 | 内容包、资源导入、各平台构建 | `docs/guides/content-packs-and-builds.md` | warn |
| 7 | 部署、TLS/WSS、服务配置 | `docs/guides/server-deployment.md`、`docs/runbooks/server-recovery.md` | warn |
| 8 | 验收证据、CI 门禁、docs 检查器/hook 与 `docs/doc-map.json` 自身 | `docs/standards/documentation.md`、`docs/guides/quality-gates.md` | warn |

具体 glob、exclude 与 reason 以 `docs/doc-map.json` 为准；本表只固定目标与模式。

规则 8 中的 `scripts/docs/*.mjs`、`.githooks/**`、`docs/doc-map.json` 与检查器/hook 同批纳入 tracked；在它们尚未提交时，规则 8 仍由 `.github/workflows/ci.yml` 命中，因此不会成为死规则。

## 7. 检查器契约

### 7.1 文件与命令

- `scripts/docs/doc-lib.mjs`：纯函数库（路径分类、glob、链接解析、doc-map 校验、staged 影响计算）。
- `scripts/docs/check-docs.mjs`：CLI，支持 `--staged`、`--json`。
- `scripts/docs/install-hooks.mjs`：hook 安装与 worktree 配置。
- `scripts/docs/tests/*.test.mjs`：`node:test` 契约测试。
- `npm run test:docs`：运行检查器测试。
- `npm run check:docs`：全量检查。
- `npm run check:docs:staged`：staged 同步检查。
- `npm run hooks:install`：安装 hook。

### 7.2 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 通过；或 `DOCS_CHECK=off` 显式跳过 |
| `1` | 文档/映射/staged 同步校验失败 |
| `2` | 工具或配置错误：非 git 仓库、缺 `docs/`、缺/损坏 `doc-map.json`、未知参数、Node < 22、hook runtime 缺失或版本不足 |

退出码 `2` 必须显式失败并说明原因，不得降级为 `0`。

### 7.3 全量检查项

- 目录：living 目录合法；`docs/reviews/**` 只读；非法目录下的 `.md` 报错。
- 命名：禁用 token/片段；空文档；超行数；双 H1；缺 `> 结论：`。
- 索引：`docs/README.md` 链接每个 living 文档；`docs/runbooks/README.md` 链接每个 runbook。
- 链接：行内/reference-style/HTML；大小写逐级；URL 编码；断链；fence/inline code 忽略。
- 代码引用：源码注释中的 `docs/*.md` 与 `§N`；字符串不误报；裸文件名仅在唯一时解析。
- doc-map：缺失/损坏 → `2`；空规则、空 `include`/`docs`、缺 `reason`、缺目标、非 living 目标、死规则 → `1`。
- 冻结：`docs/reviews/**` 被 staged 修改时由 hook 先拒绝。

### 7.4 staged 检查项

- `require` 规则命中代码文件但目标文档未 staged → `1`。
- `warn` 规则命中但未更新文档 → 输出提醒，退出 `0`。
- 命中代码文件且目标文档已 staged → `0`。
- 删除文档不算更新。
- index 与工作区对同一路径不一致 → `1`（检查读取工作区，无法代表将提交内容）。
- `git rm --cached` 后仍在工作区但被忽略的文件放行。
- rename 按 `D + A` 拆分处理，不折叠为更新。

### 7.5 JSON 输出

- 全量：`{ mode: "full", ok, issues }`。
- staged：`{ mode: "staged", ok, failures, warnings, impacts }` 或含 `issues`。
- 工具错误：`{ mode, ok: false, error }`。
- 跳过：`{ mode, ok: true, skipped: true, reason }`。

## 8. Hook 与跳过机制

### 8.1 安装

- `core.hooksPath` 为空或默认（`.git/hooks`）→ 设为 `.githooks`。
- 已经是 `.githooks` → 幂等成功。
- 已被其它值占用 → 报错退出，不覆盖。
- `--prepare` 模式只警告，不阻塞安装流程。
- `--worktree` 使用 `extensions.worktreeConfig` + `git config --worktree` 设置 per-worktree hooksPath。
- 记录 Node 绝对路径到 `.githooks/runtime`（gitignore），避免 hook 运行时 PATH 缺失。
- 检测到已有自定义 `pre-commit` / `commit-msg` → 拒绝安装并提示人工合并。
- 保留 Git LFS 的 `post-*` / `pre-push` 链式转发。

### 8.2 `pre-commit`

1. 若 staged 变更包含 `docs/reviews/**` → 直接失败。
2. 运行全量 `check:docs`。
3. 运行 `check:docs:staged`。
4. runtime 缺失或 Node < 22 → 退出 `2`。

### 8.3 `commit-msg`

- 当 `DOCS_CHECK=off` 时，提交信息必须包含一行：

  ```text
  Docs-Check: off — <至少 8 个字符的理由>
  ```

- 缺失或理由过短 → 拒绝提交。
- 未设置 `DOCS_CHECK=off` 时不要求该行。

## 9. 迁移方案

1. **冻结证据迁移（R100，字节不变）**：
   - `docs/superpowers/acceptance/**` → `docs/reviews/c12-final-gate/**`（3 份报告 + artifacts）。
   - `docs/superpowers/specs/` 下设计稿 → `docs/reviews/legacy/2026-10-20-local-or-server-pet-data-design.md`。
   - 删除空的 `docs/superpowers/`；不编辑报告与设计正文。
2. **新证据路径**：`scripts/acceptance-gate.mjs`、`scripts/validate-evidence.mjs`、`scripts/lib/acceptance-evidence.mjs`、`scripts/docker-smoke.mjs`、`scripts/e2e/*` 的默认输出改为 `.agent-reports/acceptance/` 与 `.agent-reports/acceptance/artifacts/`。
3. **测试与注释**：更新 `scripts/tests/sync-protocol.test.mjs` 读取新设计稿路径；更新验收证据相关测试的 fixture；`scripts/e2e/electron-harness.ts` 注释指向 `docs/reviews/c12-final-gate/`。
4. **模块 README**：更新 `server/README.md` 中历史证据路径；根 `README.md` 不改。
5. **新增索引**：`docs/reviews/README.md` 说明冻结规则、旧→新映射、新证据出口；`docs/README.md` 直接索引所有 living 文档与模块 README。
6. **新增门禁**：`package.json` 增加 `test:docs`、`check:docs`、`check:docs:staged`、`hooks:install`；`prepare` 安装 hook；CI root job 增加 `test:docs` 与 `check:docs`。
7. **`.gitignore`**：只忽略 `.githooks/runtime`、`tmp/`、`node_modules/` 等生成物；`.agent-reports/` 不加入 gitignore，交付报告/验收证据按任务提交，原始大体积 artifacts 按任务清理。

迁移后不得存在对旧 `docs/superpowers/` 的实时路径引用；冻结报告正文中的历史字符串原样保留，不计为实时引用。

## 10. 验收标准

全部满足才视为初始化完成：

- [ ] `node --test scripts/docs/tests/*.test.mjs` 全绿；检查器自身无第三方依赖。
- [ ] `npm run check:docs` 退出码 `0`：无未索引文档、断链、双 H1、缺结论、超行数、禁用文件名、死规则。
- [ ] `npm run check:docs:staged` 在“代码改动 + 文档同提交”时退出 `0`，缺文档时退出 `1`，`warn` 时退出 `0`。
- [ ] doc-map 8 条规则，4 `require` / 4 `warn`；每条 include 命中真实文件；目标均为 living 文档。
- [ ] `docs/README.md` 直接链接全部 living 文档、`docs/reviews/README.md`、`server/README.md`、`ios/README.md`；冻结证据分组只链接 `docs/reviews/README.md`。
- [ ] 冻结迁移为 R100；`git diff -- docs/reviews` 对移动文件无内容改动；`docs/superpowers/` 不存在。
- [ ] 新证据写 `.agent-reports/acceptance/`；作为交付证据时提交，原始大体积 artifacts 按任务处理；`tmp/reports/` 为临时；测试与验收脚本已同步。
- [ ] `npm run typecheck`、`npm run test:compat`、`npm --prefix server run typecheck`、`npm --prefix server test` 通过。
- [ ] hook 安装幂等；`pre-commit` 拒绝 `docs/reviews` 变更；`commit-msg` 强制跳过理由。
- [ ] 工作区无 `node_modules/`、`out/`、`dist/`、`tmp/`、原始大体积生成物或临时凭据被提交；`.agent-reports/` 的交付报告/验收证据按任务提交。

## 11. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 检查器误报导致提交受阻 | 契约测试覆盖链接/注释/裸文件名边界；修复检查器而不是放宽规则 |
| 文档迁移破坏历史可追溯性 | R100 移动 + `docs/reviews/README.md` 映射；不改正文 |
| hook 覆盖个人配置 | 检测占用即拒绝；`--prepare` 只警告；`--worktree` 隔离 |
| 紧急提交被文档门禁阻塞 | `DOCS_CHECK=off` + commit message 理由；人类可审计；不绕过测试/构建 |
| doc-map 死规则随重构出现 | `check:docs` 每次校验 include 是否命中；新代码域同提交加规则 |

回滚顺序：先撤 `.githooks` 与 package/CI 门禁接入，再撤检查器；文档迁移用反向 rename 恢复；冻结证据不得编辑。回滚后仍需保证 `docs/superpowers/` 不再出现，历史证据路径以迁移后结构为准。

## 12. 后续维护

- 新增代码域 → 先加测试 fixture，再加 doc-map 规则，再写目标文档。
- 删除代码域 → 删除规则并更新所有入链；不得留下指向不存在文档的规则。
- 修改文档规则 → 同步更新 `docs/standards/documentation.md`、`AGENTS.md`、检查器测试与 CI。
- 每次发布前运行 `npm run gate:acceptance`，证据写 `.agent-reports/acceptance/`，不写入 `docs/reviews/`。
