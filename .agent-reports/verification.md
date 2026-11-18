# 独立验收报告：文档同步体系

- 结论：**阻塞，不可合并**。
- Tree / task：`tree-01e984be8db7a476` / `task-10`；关联 Timeline：`p5-redgreen`、`p5-hook`、`p5-commit`。
- 候选：`docs/standards-init`，HEAD `bc0a9f618a445974eb917e4a78a7ca26d32a57b0`。
- 验收时间：2026-11-18（Asia/Shanghai）。
- 方法：真实 worktree 只读验收；所有变更型反例均在 `/tmp/qqpet-docs-verifier.NozYrA/repo` 临时 clone 中执行。未读取 `.env`、凭据或生产数据，未修改真实代码、living 文档或 `docs/reviews/**`，未 commit / merge。
- 总结：基线 docs 检查、77 个 docs 测试、typecheck、server 89 个测试均通过，冻结迁移也满足 R100/字节一致；但独立反例证明 hook 与检查器仍有多个失败关闭/规则缺口，且完整 compat 门禁失败。

## 1. 阻断问题

### B1. 实际启用 `.githooks` 后，LFS forwarder 不转发旧 hook

- 位置：`.githooks/pre-push:7`；`post-checkout:7`、`post-commit:7`、`post-merge:7` 使用同一逻辑。
- 根因：`git rev-parse --git-path hooks` 会遵循 `core.hooksPath`。候选 worktree 实际返回 `.githooks`，不是旧 `.git/hooks`，所以 `LEGACY` 指向 wrapper 自身；`[ "$LEGACY" != "$0" ]` 后直接 no-op。
- 临时 clone 实证：设置 `core.hooksPath=.githooks`，在 `.git/hooks/pre-push` 安装会写 marker 的旧 hook，执行 `.githooks/pre-push origin verifier-url`：
  - `git rev-parse --git-path hooks` 输出 `.githooks`；
  - hook 退出 `0`，但 `legacy_forwarded=no`，marker 未创建。
- 现有测试为何漏报：`scripts/docs/tests/hooks.test.mjs:270-284` 的 fixture 没有设置真实安装后的 `core.hooksPath=.githooks`，因此测到的是另一环境。77/77 绿不能证明该契约。

### B2. 通过 `/tmp` 符号链接别名调用时，检查器无输出且退出 0

- 位置：`scripts/docs/check-docs.mjs:305-306`。
- 根因：入口 guard 比较 `path.resolve(process.argv[1])` 与 `fileURLToPath(import.meta.url)`；macOS 上 `/tmp` 是 `/private/tmp` 的别名，Node 解析模块 realpath 后二者不相等，`main()` 完全不执行。
- 反例：在非 git 临时目录执行 `node /tmp/qqpet-docs-verifier.NozYrA/repo/scripts/docs/check-docs.mjs --json`，**退出 0、无输出**。这违反“检查器自身出错必须显式失败，不得静默放行”。
- 对照：同一目录改用 `$(realpath scripts/docs/check-docs.mjs)` 后，正确输出 `当前目录不是 git 仓库` 并退出 `2`。因此必需的非 git 契约本身可实现，但别名入口存在 fail-open。
- `install-hooks.mjs:148-149` 有同样的 guard 形状；本次未把它作为单独 blocker 计数，但应一起修并补回归。

### B3. “恰好一个 H1”未执行：零 H1 的 living 文档可通过

- 位置：`scripts/docs/doc-lib.mjs:406-429` 只在 `h1Count > 1` 时报错；`h1Index < 0` 时也跳过结论检查。
- 临时反例：新增 `docs/standards/no-h1-verifier.md`，无 H1、至少 5 个非空行，并在 `docs/README.md` 直接索引。
- 命令：`node "$script" --json`。
- 结果：`{"mode":"full","ok":true,"issues":[]}`，退出 `0`。违反 `docs/specs/docs-sync-standards.md:68-70` 的“恰好一个 H1”及结论位置契约。

### B4. `docs/reports` / `docs/slides` 被隐式豁免，非法目录可静默通过

- 位置：`scripts/docs/doc-lib.mjs:60` 定义豁免，`:449-451` 跳过整棵目录。
- 临时反例：新增未索引、无规范结构的 `docs/reports/unvalidated-verifier.md`。
- 结果：全量检查 `ok:true`、`issues:[]`、退出 `0`。
- 规范只允许入口、standards/specs/architecture/guides/runbooks 与 reviews；`docs/specs/docs-sync-standards.md:62-64` 明确其它 `docs/**/*.md` 为 invalid。该豁免未在规范中定义，且让“非法目录 → 失败”可被绕过。

### B5. 不可读 tracked 源码被当作“没有内容”跳过，全量检查仍通过

- 位置：`scripts/docs/doc-lib.mjs:747-759` 对 `statSync` / `readFileSync` 异常直接 `continue`；`collectMarkdownFiles` 在 `:438-444` 也吞掉目录读取异常，`existsWithExactCase` 在 `:79-83` 把读取异常当作不存在。
- 临时反例：`chmod 000 server/src/db.ts` 后运行全量检查。
- 结果：`{"mode":"full","ok":true,"issues":[]}`，退出 `0`；随后恢复权限。检查器无法读取应检查的 tracked 文件却静默放行，直接违反工具错误退出 `2` 的硬约束。
- 补充：不可读 `docs/standards` 时被误报成一批 broken/missing link，退出 `1` 而非工具错误 `2`，说明 I/O 错误与校验失败也没有区分。

### B6. `npm run test:compat` 不是绿色门禁

- 原始必需命令：`npm run test:compat`。
- 实际运行已出现 `pets discover, link, deliver, and go home` 失败；运行超过 10 分钟仍未自然结束，为取得有界诊断而手动终止，**不能记为通过或正常退出 0**。
- 有界完整诊断：`node --experimental-strip-types --test --test-force-exit scripts/tests/*.test.mjs`，退出 `1`：`tests 767 / pass 764 / fail 1 / skipped 2`；失败为 `scripts/tests/lan.test.mjs:33`，`丙 never got the message: +甲,+乙`。
- 单独诊断：`node --experimental-strip-types --test --test-force-exit scripts/tests/lan.test.mjs`，退出 `1`，4 个中 3 通过；另一次失败为 `a crashed pet is missed within the timeout`（`:69`），事件序列不符合预期。
- 不同运行出现不同 LAN 失败，呈网络/时序敏感性；本验收不声称由 docs 分支引入，但候选当前不满足批准稿 `docs/specs/docs-sync-standards.md:229` 的合并门禁。

## 2. 必做正向命令

| 命令 | 退出码 | 关键输出 |
|---|---:|---|
| `npm run test:docs` | 0 | `tests 77`, `pass 77`, `fail 0`, `skipped 0` |
| `npm run check:docs` | 0 | `文档检查通过：目录结构、索引、链接与代码引用均有效。` |
| `npm run check:docs:staged` | 0 | `本次 staged 变更未命中代码域映射。` |
| `node --check scripts/docs/*.mjs` | 0 | 无错误；另逐文件执行 `node --check` 也全部 0 |
| `npm run typecheck` | 0 | node/web/harmony/e2e 四套 `tsc --noEmit` 均通过 |
| `npm run test:compat` | 未正常结束 | 已出现失败且 >10 分钟未退出；有界完整诊断为 1，详见 B6 |
| `npm --prefix server run typecheck` | 0 | `tsc -p tsconfig.json` 通过 |
| `npm --prefix server test` | 0 | `tests 89`, `pass 89`, `fail 0` |

## 3. 必做反例矩阵

除特别注明外，均在临时 clone 中执行；`script=$(realpath scripts/docs/check-docs.mjs)` 用于避开 B2，从而验证目标场景本身。

| 场景 / 命令 | 实际退出码 | 关键证据 |
|---|---:|---|
| 断链后 `node scripts/docs/check-docs.mjs --json` | 1 | `broken-link`，`docs/specs/does-not-exist.md` |
| 新增未索引 living doc 后同一全量命令 | 1 | 含 `unindexed-doc`（fixture 另有 `empty-doc`，不影响目标判定） |
| staged `server/src/db.ts`，无映射文档，`--staged --json` | 1 | `failures` 指向 `docs/architecture/server-data.md` |
| 同批 staged `docs/architecture/server-data.md` | 0 | `ok:true`, `failures:[]`, `stagedDocs` 含目标文档 |
| 移走 `docs/doc-map.json` 后全量检查 | 2 | `缺少 docs/doc-map.json` |
| 写入坏 JSON 后全量检查 | 2 | `doc-map.json 不是合法 JSON` |
| 非 git cwd，使用 realpath 后的检查器 | 2 | `当前目录不是 git 仓库` |
| staged `docs/reviews/README.md` 后直接运行 `.githooks/pre-commit` | 1 | 先输出 frozen history；即使 runtime 缺失也先拒绝 |
| 将 reviews legacy 文件 `git mv` 到目录外（删除侧）后 pre-commit | 1 | 同样 frozen history，rename 删除侧不能绕过 |
| 无 frozen staged、缺 `.githooks/runtime` 后 pre-commit | 2 | `runtime is missing` / `Run npm run hooks:install` |
| `DOCS_CHECK=off .githooks/commit-msg <无理由文件>` | 1 | 要求 `Docs-Check: off — <至少 8 个字符的理由>` |
| 同上但写入 `Docs-Check: off — 独立反例验证理由` | 0 | 有合法理由时通过 |
| 已有 `core.hooksPath=.custom-hooks` 后运行 installer | 1 | 未覆盖；检查后仍为 `.custom-hooks` |
| 旧 `.git/hooks/pre-commit` 为自定义 hook 后运行 installer | 1 | 拒绝切换；hooksPath 仍未设置 |
| `.githooks/pre-commit` 为非 managed 自定义 hook | 1 | 拒绝接管 |

额外反例（B2–B5）均得到与规范相反的结果，详见上文。所有临时场景结束后临时 clone 的 tracked 工作树恢复干净。

## 4. 冻结证据与迁移

| 命令 | 退出码 / 结果 |
|---|---|
| `git show --summary 5930b187` | 0；显示 8 个 rename，均 `(100%)` |
| `git show --format= --name-status -M 5930b187` | 0；恰好 8 个 `R100`，3 份验收报告 + 4 份 artifacts + 1 份历史设计 |
| `git show --format= --raw -M 5930b187 -- docs/superpowers docs/reviews` | 0；每对旧/新 blob 缩写完全相同，确认字节一致 |
| `git diff --name-status 40fcf872..HEAD -- docs/reviews` | 0；空输出，迁移后零改动 |
| `git ls-files docs/superpowers` | 0；空输出 |
| `test ! -e docs/superpowers` | 0；旧目录不存在 |

迁移目标符合 `docs/reviews/c12-final-gate/**` 与 `docs/reviews/legacy/2026-10-20-local-or-server-pet-data-design.md`。本报告写 `.agent-reports/`，未向 reviews 添加证据。

## 5. Hook 配置与安装边界

- 候选 effective `core.hooksPath=.githooks`，来源为 `.git/worktrees/docs-standards/config.worktree`；`git config --worktree --get core.hooksPath` 返回 `.githooks`（0）。
- shared main `<repo-root>` 的 `git config --show-origin --get core.hooksPath` 返回 1（未设置），未受候选 worktree 配置影响。
- `.githooks/runtime` 存在且可执行；`git check-ignore -v .githooks/runtime` 命中 `.gitignore:9`（0）；`git ls-files --error-unmatch` 返回 1，未被 tracked。
- installer 对其它 hooksPath、旧默认自定义 hook、目标自定义 hook 均失败关闭，见反例矩阵。
- **LFS 转发不合格，见 B1。** 因而本节整体不能判通过。

## 6. 文档、doc-map 与事实源

- 基线 `check:docs=0` 证明当前已索引 living 文档、现有链接、runbook 二级索引、现有单/双 H1 检查、结论、行数与死规则检查均通过；但 B3/B4 说明边界覆盖不完整。
- 直接解析 `docs/doc-map.json`：`version:1`、8 条规则、4 `require` / 4 `warn`；目标与批准稿 8 个契约域一致，基线无 dead rule / 非 living target。
- `docs/README.md` 直接索引现有 living 文档，并直接链接 `docs/reviews/README.md`、`server/README.md`、`ios/README.md`；冻结分组只链接 reviews 说明。
- `docs/runbooks/README.md` 登记唯一 runbook `server-recovery.md`。
- `AGENTS.md` 声明唯一事实源；`CLAUDE.md` 只有一行指针，无规则复制。
- 在 docs、相关 md/mjs/json/yml/ts 中检索项目特定禁用串（已脱敏）无匹配；docs 中另检索 `arctic|penguin|t800|参考项目` 无匹配。
- 实时旧路径检查未发现业务代码仍写 `docs/superpowers`；现存文本均为迁移历史/规范说明或测试非法路径 fixture。

## 7. 代码审查、范围与分支

- 退出码主路径：`check-docs.mjs` 顶层异常会设置 2；缺/坏 doc-map 与非 git realpath 场景均为 2。但 B2/B5 证明并非所有执行/I/O 失败都失败关闭。
- `pre-commit` 顺序符合规范：先 reviews 冻结，再 skip 判断，再 runtime >=22，再 full，最后 staged；full 非零原样返回，staged 用 `exec` 返回。
- `DOCS_CHECK=off` 仍先执行 reviews 冻结；`commit-msg` 对无理由/短理由拒绝，有理由通过。
- `git diff main...HEAD -- scripts/tests` 显示既有测试仅做证据路径迁移，没有删除断言或放宽原断言；问题在新测试 fixture 没覆盖真实 hook 配置及上述反例，而非既有断言被弱化。
- 完整 diff 为 58 个文件，范围与批准稿一致：docs、scripts/docs、hooks、package/CI、证据出口迁移、AGENTS/CLAUDE；未发现业务行为夹带或临时凭据/生成物 tracked。
- 初始真实工作树 `git status --short` 为空；验收结束时只有本报告为新增未跟踪交付物（server test 生成物走 ignored 路径）。没有实现者遗留的其它未跟踪文件需要提交或清理。
- `git merge-base --is-ancestor HEAD main` 返回 1，`git merge-base --is-ancestor main HEAD` 返回 0：候选包含 main 但尚未合回 main，符合要求。

## 8. 剩余风险与建议复验

1. 修复 B1–B5 后必须新增对应回归，尤其是**真实设置 core.hooksPath 后**验证全部 4 个 LFS wrapper，而不可只重复当前 fixture。
2. 对入口路径应覆盖 symlink/alias 调用；对所有文件枚举/读取错误应区分“校验失败 1”与“无法完成检查 2”，禁止 catch 后静默 continue。
3. 补零 H1、docs/reports、docs/slides、不可读 tracked 源码与不可读 docs 子目录反例。
4. `test:compat` 的 LAN 用例需定位网络/时序不稳定性并重新跑完整原始命令至自然退出；不能以 `--test-force-exit` 作为门禁替代。
5. 本次未跑 build、Electron E2E、Docker/proxy smoke；这些不是当前 docs 初始化额外实跑项，不能据此声明发布级验收通过。
6. LFS 实际旧 hook 的实证在 macOS 临时 clone 完成；修复后仍建议在 Linux CI 环境覆盖同一场景。

**最终判定：阻塞。必须先修复 B1–B5，并让原始 compat 门禁通过，再进行独立复验；当前候选不可合并。**

---

# Round 2：修复后独立复验

- Tree / task：`tree-01e984be8db7a476` / `task-12`。
- 最终候选 HEAD：`bf4d9dbad50dbd3efe8f72b646b0c86d537e7c90`。
- 修复提交：`9eec5dbc fix(docs): close independent verification gaps`、`bf4d9dba fix(test): serialize compat tests to avoid LAN flake`。
- **Round 2 最终结论：可合并（仅指本次 docs 初始化任务范围，仍需遵守人类合并门禁）。Round 1 的 B1–B6 均已关闭，本轮未发现新 blocker。**
- 方法：真实 worktree 只跑只读门禁；变更型反例全部在新的 `/tmp/qqpet-docs-verifier-r2.KnMJLV/repo` 临时 clone 执行。保留上方 Round 1 原始失败记录，不以修复后的结果覆盖历史。

## R2.1 B1–B6 逐项复验

### B1 LFS forwarding：通过

临时 clone 中真实执行 `git config core.hooksPath .githooks`，此时 `git rev-parse --git-path hooks` 仍返回 `.githooks`，而 wrapper 已改用 `git rev-parse --git-common-dir` 定位旧目录。逐一在 `.git/hooks/<hook>` 放 marker，旧 hook 输出参数并以 23 退出：

| wrapper | marker 内容 | wrapper 退出码 | 旧 hook 不存在 | 旧 hook 不可执行 |
|---|---|---:|---|---|
| `post-checkout` | `2\|arg-one\|arg-two` | 23 | 0，无 marker | 0，无 marker |
| `post-commit` | `2\|arg-one\|arg-two` | 23 | 0，无 marker | 0，无 marker |
| `post-merge` | `2\|arg-one\|arg-two` | 23 | 0，无 marker | 0，无 marker |
| `pre-push` | `2\|arg-one\|arg-two` | 23 | 0，无 marker | 0，无 marker |

四个 wrapper 均转发参数、透传旧 hook 退出码，不存在/不可执行时 no-op。Round 1 的真实配置盲点已覆盖。

### B2 symlink 入口：通过

在非 git 临时 cwd 中故意使用未 realpath 的 `/tmp/...` 别名：

- `node /tmp/qqpet-docs-verifier-r2.KnMJLV/repo/scripts/docs/check-docs.mjs --json` → **2**，输出 `{mode:"full",ok:false,error:"当前目录不是 git 仓库..."}`。
- `node /tmp/qqpet-docs-verifier-r2.KnMJLV/repo/scripts/docs/install-hooks.mjs` → **1**，输出 `当前目录不是 git 仓库，无法安装 docs hooks。`，不再静默 0。

### B3 零 H1：通过

新增无 H1、至少 5 个非空行且被 `docs/README.md` 直接索引的 living doc，运行 `node scripts/docs/check-docs.mjs --json` → **1**，issue 为 `missing-h1`，路径与消息准确。

### B4 非法目录：通过

同时新增 `docs/reports/foo.md` 与 `docs/slides/foo.md` 后运行全量检查 → **1**；两者均产生 `invalid-location`，不再被跳过。

### B5 I/O 失败关闭：通过

- `chmod 000 server/src/db.ts` 后全量检查 → **2**，JSON error 为 `EACCES: permission denied, open .../server/src/db.ts`；随后恢复 0644。
- `chmod 000 docs/standards` 后全量检查 → **2**，JSON error 为 `EACCES: permission denied, scandir .../docs/standards`；不再误报 broken-link/1，随后恢复 0755。
- 临时 clone 最终 tracked 工作树干净。

### B6 原始 compat 门禁：通过

直接运行原始 `npm run test:compat`（实际为 `node --experimental-strip-types --test --test-concurrency=1 scripts/tests/*.test.mjs`），**自然结束、退出 0**，未使用 `--test-force-exit`：

- `tests 767` / `pass 765` / `fail 0` / `cancelled 0` / `skipped 2` / `todo 0`；
- `duration_ms 89082.563167`（约 89.08 秒）；
- Round 1 失败的 `pets discover, link, deliver, and go home` 与 `a crashed pet is missed within the timeout` 本轮均通过。

**serial 设置可接受**：`lan.test.mjs` 使用固定真实 UDP 端口和短时序断言，文件级并行会引入外部干扰；串行化没有删除/放宽断言，测试总数与平台 skip 数不变，约 89 秒也低于 CI root 作业 20 分钟上限。它是消除共享资源竞争，而不是掩盖业务失败。本轮仅独立自然通过一次，长期稳定性仍应由后续 CI 观察，但不构成当前 blocker。

## R2.2 正向门禁

| 命令 | 退出码 | 关键输出 |
|---|---:|---|
| `npm run test:docs` | 0 | `tests 84`, `pass 84`, `fail 0`, `skipped 0`；新增 7 个 B1–B5 回归均通过 |
| `npm run check:docs` | 0 | 目录结构、索引、链接与代码引用均有效 |
| `npm run check:docs:staged` | 0 | 当前 staged 未命中代码域映射 |
| `node --check scripts/docs/*.mjs` | 0 | 无语法错误；另逐文件检查也全部 0 |
| `npm run typecheck` | 0 | node/web/harmony/e2e 四套通过 |
| `npm --prefix server run typecheck` | 0 | server `tsc -p tsconfig.json` 通过 |
| `npm run test:compat` | 0 | 767 / 765 pass / 0 fail / 2 skip，约 89.08 秒，自然退出 |

`git diff --check bc0a9f61..HEAD` 退出 0。修复 diff 未显示删断言或放宽业务测试；主要变更为入口 realpath、I/O 错误重抛、缺失 H1、移除非法目录豁免、LFS common-dir 定位及 compat 串行化。

## R2.3 冻结证据、文档与分支不变量

- `git show --format= --name-status -M 5930b187 -- docs/superpowers docs/reviews`：8 个迁移仍为 `R100`。
- `git diff --name-status 40fcf872..HEAD -- docs/reviews`：退出 0、空输出；修复提交未触碰冻结证据。
- `git ls-files docs/superpowers` 为空，`test ! -e docs/superpowers` 为 0。
- doc-map 仍为 8 条，4 require / 4 warn；基线全量检查无死规则。
- `AGENTS.md` 仍为唯一事实源，`CLAUDE.md` 仍为 1 行指针。
- 相关 `md/mjs/json/yml/ts` 中检索项目特定禁用串（已脱敏）无匹配。
- 候选 worktree hooksPath 仍为 `.githooks`，`.githooks/runtime` 仍被 `.gitignore:9` 忽略。
- `HEAD` 不在 main 中、main 是 HEAD 祖先，仍未合并 main。
- 最终真实工作树只有本报告的未跟踪 `.agent-reports/`；没有其它作者改动需要处理。

## R2.4 非阻断剩余风险

1. **native 注释扫描范围**：`doc-lib.mjs` 的 `SOURCE_EXTENSIONS` 未包含 `.kt`、`.ets`、`.m`、`.h`，所以这些 native 文件中的 `docs/*.md` 注释引用不进入链接/章节扫描。doc-map 对 native 域仍提供 staged warn，但“所有 native 注释引用都被全量检查”目前没有覆盖；建议后续补词法扫描与 fixture。本项不属于本轮 B1–B6 回归，未据此推翻已明确的初始化验收范围。
2. **`--no-verify` 是流程红线而非技术不可绕过**：本地 Git 始终允许用户显式跳过 hook；仓库规范要求人类批准并记录，评审/CI 必须识别。CI 的 full docs 检查能发现结构问题，但无法从已提交历史重建每次 staged require 的意图，因此同提交文档契约仍依赖代码评审与审计。
3. **compat serial 的长期稳定性**：固定端口和真实网络时序仍可能受极端机器负载影响；本轮与实现者报告均通过，但建议在 CI 持续观察，不要为消 flake 再放宽断言。
4. 本轮未重复 server 89 项测试、build、Electron E2E、Docker/proxy smoke；Round 1 server 测试 89/89 通过，Round 2 没有 server 业务代码改动。本结论不是发布级 gate:acceptance 替代品。

**Round 2 最终判定：B1–B6 全部关闭，规定门禁通过，无未决 blocker；候选 `bf4d9dba` 在本任务范围内可提交给人类做合并决定。**
