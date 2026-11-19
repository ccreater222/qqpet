# 合并与推送记录

> 结论：候选分支已合并进 `main` 并推送到 `origin/main`；文档门禁在 GitHub Actions 的独立 `Docs gates` 工作流首次运行即通过。主 `ci.yml` 工作流仍存在合并前就有的 0 秒失败，与本合并无关，需单独排查。

## 1. 合并结果

| 项 | 值 |
|---|---|
| 合并提交 | `b23109a2`（merge: docs standards, native lexical scan and anti-bypass gates） |
| 初始化基线更新 | `2ebcc90e`（`rangeBaseline` 指向合并提交） |
| 独立 Docs gates 工作流 | `e6bb98d5`（新增 `.github/workflows/docs.yml`） |
| 分支/远端 HEAD | `e6bb98d5` / `origin/main = e6bb98d5` |
| 合并方式 | `--no-ff` merge commit；保留 `docs/standards-init` 历史与 `rangeBaseline` |

## 2. 合并后门禁（本地，合并后的 main）

| 命令 | 结果 |
|---|---|
| `npm run test:docs` | 106 tests / 106 pass / 0 fail，exit 0 |
| `npm run check:docs` | exit 0 |
| `npm run check:docs:staged` | exit 0 |
| `npm run check:docs:range` | exit 0（`b23109a2..HEAD`，2 个提交均已同步） |
| `npm run test:compat` | 811 tests / 809 pass / 0 fail / 2 skip，约 91 秒，exit 0 |
| `npm run typecheck` | exit 0（四套） |
| `npm --prefix server run typecheck` | exit 0 |
| `node --check scripts/docs/*.mjs` / `git diff --check` | exit 0 |

## 3. CI 结果

- **Docs gates**（`.github/workflows/docs.yml`，run `44475452310`）：**success**，15 秒；步骤 `test:docs`、`check:docs`、`check:docs:range` 全部通过。
- **ci.yml**（`C12 acceptance`）：本次运行 `44475113988` 在 0 秒失败且无 job；合入前的 main（`44465213299`、`44295249670`、`44277925384`）同样 0 秒失败，属于合并前已有的工作流级故障，不是本合并引入。独立的 Docs gates 工作流因此补位，保证文档门禁不静默失效。
- **iOS shared compatibility**：在 “Fetch upstream release tags for fork versions” 步骤失败；该步骤未在本合并中修改，属于既有上游标签拉取问题。Docs gates 不依赖该步骤。

## 4. 冻结证据与钩子

- `docs/reviews/**` 迁移仍为 8 个 R100；自 `40fcf872` 起零 diff；`docs/superpowers` 不存在。
- `main` worktree 已执行 `node scripts/docs/install-hooks.mjs`：`core.hooksPath=.githooks`，`.githooks/runtime` 已写入且被 gitignore。
- 主 worktree 既有未跟踪 `audit/` 与 pnpm 文件保持原样，未纳入合并提交。

## 5. 维护提醒

- `ci.yml` 的 0 秒失败需要在 GitHub Actions 侧单独定位（工作流级；无 job、无日志）；修复前，文档门禁由 `Docs gates` 工作流保证。
- `rangeBaseline` 已指向合并提交 `b23109a2`；未来不要 squash/rebase 掉该提交，否则 range 会按配置错误 2 失败关闭。
- 新分支从当前 `main` 创建时，`Docs gates` 会按 `rangeBaseline` 检查新提交；`git commit --no-verify`/`git push --no-verify` 的漏检由 `Docs gates` 的 range 步骤兜底。
