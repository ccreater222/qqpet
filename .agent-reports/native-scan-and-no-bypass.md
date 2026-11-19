# Native 词法扫描与防绕过门禁：实现与验收证据

> 结论：本轮两个目标已完成。检查器现在扫描 native/前端宿主语言的注释引用并带 fixture；`--no-verify` 造成的漏文档提交会在 `pre-push` 与 CI 的逐提交 `--range` 门禁被检出并阻断。候选分支 `docs/standards-init` 的代码 HEAD 为 `cb6c5714`，独立 verifier Round 3 判定可合并（本任务范围）；尚未合并 `main`。

## 1. 范围

- 分支：`docs/standards-init`；代码 HEAD：`cb6c571421e1fa1d2e17088dabab13fc2197c8c0`。
- 基线：`docs/doc-map.json` 的 `rangeBaseline = e2eb3400...`（上一轮文档体系初始化的最终提交）。
- 本轮只改 docs 工具链、hooks、CI、测试与规范；未改业务代码、未改 `docs/reviews/**`、未合并/推送。

## 2. Native 词法扫描

- `SOURCE_EXTENSIONS` 新增：`.kt`、`.kts`、`.java`、`.m`、`.mm`、`.h`、`.swift`、`.ets`、`.xml`、`.plist`、`.html`、`.css`、`.gradle`。
- C 系语言：保留 `//` 与 `/* */`，屏蔽字符串；支持 Kotlin/Swift `"""..."""` 原始字符串，原始字符串里的 `//` 不会被误判为注释。
- XML/.plist/.html：只保留 `<!-- -->`；CSS：只保留 `/* */`。
- 扫描跳过 `scripts/docs/tests/fixtures/`，避免测试样本被真实仓库全量检查当作死引用。
- Fixture：`scripts/docs/tests/fixtures/native/{comments,strings}/` 共 17 个样本，覆盖 9 种扩展；测试断言注释中的缺失 docs 路径 → `missing-code-doc`，字符串/属性/文本节点中的同一路径 → 不命中。

## 3. `--range` 逐提交门禁

- 命令：`npm run check:docs:range` → `node scripts/docs/check-docs.mjs --range`。
- 范围优先级：显式 `--range <base>..<head>` > `docs/doc-map.json` 的 `rangeBaseline` > `origin/main..HEAD` > `main..HEAD`；都不存在或 baseline 非法 → 2。
- 逐提交检查：`git rev-list --reverse --parents` + `git diff-tree`；merge commit 使用 first-parent diff，冲突解决夹带的代码不会成为盲区。
- `require` 命中代码但同一提交没有更新映射文档 → 1；`warn` → 提醒、0；删除文档不算更新；删除代码仍算变更。
- 唯一豁免：该提交 message 含合法 `Docs-Check: off — <至少 8 个字符的理由>`。`DOCS_CHECK=off` 环境变量不能跳过 range。
- **冻结证据 backstop**：任何提交触碰 `docs/reviews/**` 或 `docs/superpowers/**` → `frozen-evidence-modified` / 1，不受 skip trailer 影响；覆盖新增、修改、删除与 rename 删除侧。
- `--range` 与 `--staged` 同用 → 2；空范围 → 0；JSON 输出 `{mode:"range",ok,range,commits,failures,warnings}`。
- `rangeBaseline` 是一次性初始化边界，不是免检开关：基线之后每个提交仍逐提交检查；基线之前的历史不反噬，但基线之后触碰冻结证据仍失败。

## 4. pre-push 与 CI

- `.githooks/pre-push` 顺序：解析 `.githooks/runtime`（缺失/不可执行/Node <22 → 2）→ `check:docs:range`（失败直接退出，不转发 LFS）→ 通过后才转发旧 `.git/hooks/pre-push`，参数与退出码原样透传。
- 真实候选 HEAD 执行 pre-push → 0，range 通过并正常完成旧 hook 链。
- CI root job 在 `check:docs` 后运行 `npm run check:docs:range`；范围由 `rangeBaseline` 控制，不再依赖 PR base 参数。
- 本地 Git 仍无法技术上阻止 `git commit --no-verify`；防线的目标是“不能静默绕过”：坏提交会在 pre-push 被拒绝，`git push --no-verify` 会在 CI 的 range 检查被阻断。绝对禁止本地产生坏提交不是 Git 能提供的保证。

## 5. 测试先行与红灯 → 绿灯

| 阶段 | 红灯 | 绿灯 |
|---|---|---|
| native 词法 | native 用例 1 fail：注释引用缺失文档却 exit 0（native 扩展未扫描） | native 3/3 pass |
| range/pre-push | 11/13 fail：`--range` 未知参数、pre-push 无门禁、CI/package 未接线 | 13/13 pass |
| frozen/merge/CI 补强 | 3 fail：frozen/merge/TLS 顺序返回 0 | 4/4 pass |
| rangeBaseline | 1 fail：默认 range 未按 baseline 生效 | 2/2 pass |
| 最终 | — | `npm run test:docs`：106 tests / 106 pass / 0 fail / 0 skip |

## 6. 最终门禁

| 命令 | 退出码 | 关键结果 |
|---|---:|---|
| `npm run test:docs` | 0 | 106 / 106 pass |
| `npm run check:docs` | 0 | 结构、索引、链接、native/代码引用、doc-map 全部通过 |
| `npm run check:docs:staged` | 0 | 无 staged 映射影响 |
| `npm run check:docs:range` | 0 | `e2eb3400..HEAD`：1 个提交已同步文档 |
| `npm run test:compat` | 0 | 767 tests / 765 pass / 0 fail / 2 skip，约 89.6 秒 |
| `npm run typecheck` | 0 | node/web/harmony/e2e 四套通过 |
| `npm --prefix server run typecheck` | 0 | 独立 verifier 通过 |
| `node --check scripts/docs/*.mjs` / `sh -n .githooks/pre-push` / `git diff --check` | 0 | 通过 |
| 真实 `.githooks/pre-push` | 0 | range + 旧 LFS 转发链通过 |

## 7. 独立反例（Round 3）

- native：9 种扩展注释缺失引用 → `missing-code-doc`/1；字符串、属性、文本节点 → 0。
- range：code-only require → 1；同提交补文档 → 0；合法 trailer → 0；缺/短理由 → 1；warn → 0；空范围 → 0；缺 base → 2；`--range --staged` → 2；`DOCS_CHECK=off` 下仍 1。
- frozen：修改、复活、rename 删除侧、删除 `docs/reviews` → `frozen-evidence-modified`/1。
- merge：merge commit 的 first-parent diff 夹带 require 代码 → 1，证明不是盲区。
- baseline：基线之前不反噬、基线之后逐提交检查、非法 baseline → 2。
- pre-push：docs 失败 → 1 且不执行旧 LFS；通过 → 旧 hook marker 生成、参数与退出码透传；runtime 缺失/Node 20 → 2。
- CI：root job 含 `check:docs:range`，按 baseline 执行。

## 8. 不变量

- `docs/reviews/**` 自迁移修正后零 diff；`docs/superpowers` 不存在；8 个迁移仍为 R100。
- doc-map 8 条规则，4 require / 4 warn；新增完整 40 位 baseline。
- AGENTS 唯一事实源；CLAUDE 一行指针；无禁用项目名/用户名；候选未合入 main。
- 只改 docs 工具链、hooks、CI、测试与规范；未改业务代码、冻结证据。

## 9. 剩余风险

1. **本地 `--no-verify`**：Git 允许本地跳过 commit hooks；本增量保证坏提交会在 pre-push/CI 被检出并阻断，但不能阻止本地产生坏提交；`git push --no-verify` 同样依赖 CI 红线。
2. **baseline 与 squash/rebase**：`rangeBaseline` 指向初始化最终提交；合并本分支应使用 merge commit，不要 squash/rebase 掉该 SHA。若确实 squash，需要人类显式把 `rangeBaseline` 更新为 main 上仍存在的提交或移除该字段；否则 range 以 2 失败关闭。
3. **serial compat**：767/765/0/2 连续自然通过；固定 UDP 端口/短时序用例的长期稳定性继续由 CI 观察，不要通过放宽断言消 flake。
4. **native 边界**：九种格式有直接 fixture；`.java/.mm/.h/.gradle` 共享 C-like lexer 但无独立 fixture。复杂嵌套注释、非标准模板语法仍属轻量词法扫描边界，遇到误判应补回归。
5. 未跑发布级 build/E2E/Docker/proxy smoke；本结论只覆盖 docs 工具链增量。

## 10. 合并状态

候选分支已更新，**未合并 `main`、未 push**。等待人类合并批准；合并后建议：

```bash
npm run test:docs
npm run check:docs
npm run check:docs:range
npm run test:compat
npm run hooks:install   # 共享 core.hooksPath
```

完整独立报告见 [verification.md](verification.md)（Round 1 阻塞 → Round 2 修复 → Round 3 增量可合并）。
