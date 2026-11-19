# 文档规范

> 结论：qqpet 的文档只描述当前实现与可验证契约，一篇文档只保留一个事实版本；代码或契约变化时必须在同一个提交里更新 `docs/doc-map.json` 映射到的文档，并让 `npm run check:docs` 与 `npm run check:docs:staged` 通过。

## 1. 事实源与适用范围

- `AGENTS.md` 是 agent 协作的唯一事实源；本文件只规定**文档怎么写、放在哪、如何被检查**。
- `docs/README.md` 是唯一文档入口，必须直接链接所有 living 文档。
- `docs/doc-map.json` 是代码域到文档的同步映射；`require` 规则阻塞提交，`warn` 规则只提醒。
- `CLAUDE.md` 只有一行指针，不承载规则。
- 本规范适用于 `docs/standards`、`docs/specs`、`docs/architecture`、`docs/guides`、`docs/runbooks` 与 `docs/README.md`；`docs/reviews/**` 是冻结证据，不按本规范改写。

## 2. 文档分类与目录

| 类别 | 路径 | 写什么 | 是否可改 |
|---|---|---|---|
| 入口 | `docs/README.md` | 分组索引、阅读路径、检查入口 | 可改，随 living 文档增减同步 |
| 规范 | `docs/standards/*.md` | 协作规则、角色约定、工程约束 | 可改；改规则要同步 `AGENTS.md` |
| 方案 | `docs/specs/*.md` | 已批准的目标、非目标、契约、验收标准 | 可改，但重大范围变更需重新批准 |
| 架构 | `docs/architecture/*.md` | 当前实现的边界、契约、不变量、失败模式 | 可改，随代码同提交 |
| 指南 | `docs/guides/*.md` | 可执行操作步骤、命令、产物、排错 | 可改 |
| 运维 | `docs/runbooks/*.md` | 故障处置顺序、验证、回滚 | 可改；`README.md` 为二级索引 |
| 冻结证据 | `docs/reviews/**`（`README.md` 除外，它是说明与索引） | 历史验收报告、旧设计、artifacts | 只读，禁止新增或修改 |

新增长期文档只能落在上述 living 目录；其它目录（如 `docs/superpowers/`、`docs/notes/`、`docs/tmp/`）不再允许。历史旧目录已按字节迁移到 `docs/reviews/`，原目录删除。

## 3. 文件命名

- 使用稳定、单一、描述性的小写 kebab-case 名称，例如 `sync-protocol.md`、`server-data.md`；标题写在 H1，不靠文件名表达版本。
- 禁止在文件名中出现版本号或临时标记：`v2`、`v3`、`v4`、`final`、`old`、`copy`、`tmp`、`draft`，以及中文的 `副本`、`备份`、`最终版`、`草稿`。检查器按分隔后的单词和子串判定。
- 同一主题只有一个文件；需要保留历史时，历史进入 `docs/reviews/`，不复制出第二份 living 文档。
- 日期只用于冻结证据：`docs/reviews/<主题>/YYYY-MM-DD-<名称>.md`。living docs 不使用日期后缀。

## 4. 文档结构

每篇 living 文档必须满足：

1. 恰好一个 H1（`# 标题`），代码块内的 `#` 不计入。
2. H1 后第一段内容以 `> 结论：` 开头，用一到三句话给出可执行结论；不要先写背景。
3. 至少 5 个非空行；空文档或占位文档应删除而不是提交。
4. 不超过行数上限：

| 目录/类型 | 上限 |
|---|---|
| `docs/architecture/**` | 600 行 |
| `docs/specs/**` | 600 行 |
| `docs/standards/**` | 600 行 |
| `docs/guides/**` | 1000 行 |
| `docs/runbooks/**` | 900 行 |
| 索引类（`docs/README.md`、各目录 `README.md`） | 500 行 |

5. 长文档优先用表格、列表和小节拆分；超过上限时把细节移到专题文档，并在原处留链接。

示例结构（放在代码块中仅作示意）：

```markdown
# 文档标题

> 结论：一句话说明这份文档解决什么问题、读者应据此做什么。

## 1. 适用范围
## 2. 契约与不变量
## 3. 代码位置
## 4. 失败模式
## 5. 验证命令
## 6. 变更影响
```

## 5. 内容要求

- **写当前实现**：以仓库代码、`package.json`、CI、真实命令为依据；不写愿望、路线图或“以后应该”。未实现的内容放在 `docs/specs/` 并标注状态。
- **给出代码位置**：关键结论后跟仓库相对路径与行号，例如 `src/main/storage-ipc.ts:23`、`server/src/config.ts:72`；行号随代码变化时同提交更新。
- **写不变量**：说明什么必须始终成立（顺序、幂等、权限、边界、失败关闭），以及违反时的可观察后果。
- **写失败模式**：至少列出认证失败、输入越界、配置缺失、断线重连、版本不匹配等与实际代码相关的失败路径。
- **写验证命令**：给出可直接执行的命令与预期退出码；不要写“自行测试”。
- **写变更影响**：说明修改该契约会牵动哪些端、哪些文档、哪些测试。
- **不做通用说教**：不抄“保持代码整洁”“遵循最佳实践”等与本仓库无关的内容；每条规则都应能指向 qqpet 的具体文件或行为。
- **单一事实源**：同一个事实只在一处详细描述，其它文档用链接引用；不复制大段表格或代码。

## 6. 索引与链接

- `docs/README.md` 必须直接链接每个 living 文档（含 `docs/reviews/README.md`、`server/README.md`、`ios/README.md`），不能只链接目录或间接页面。
- `docs/runbooks/README.md` 是 runbook 二级索引，新增/删除 runbook 时同步维护。
- `docs/reviews/README.md` 只说明冻结规则、历史路径映射和新证据出口；不索引具体报告正文。
- 链接使用相对路径，大小写与实际文件逐级一致；Linux CI 区分大小写，macOS 的“能打开”不算通过。
- 优先使用行内链接 `[标题](相对路径)`；reference-style 链接与 HTML `<a href>` 也会被检查。
- 外链、纯锚点（`#section`）和 URL 编码路径按检查器规则处理；不要用绝对文件路径或 `file://`。
- 不链接不存在的文件；文档迁移时先改链接再删旧文件。

## 7. 同提交更新与 doc-map

- 行为、接口、协议、schema、部署方式或质量门禁发生变化时，映射文档必须与代码在**同一个提交**中更新；不允许“先合并，稍后补文档”。
- `docs/doc-map.json` 的每条规则包含 `include`、`exclude`、`docs`、`mode`、`reason`：
  - `include`：仓库相对 glob；`*` 不跨目录，`**` 可跨目录。
  - `exclude`：同一匹配语义下的排除项，可为空数组。
  - `docs`：至少一个已存在的 living 文档路径；不能指向 `docs/reviews/**`。
  - `mode`：`require` 表示代码改动必须同时更新文档，`warn` 只输出提醒。
  - `reason`：说明这个代码域为什么属于契约面，禁止空字符串。
- 每条 `include` 必须能匹配 `git ls-files` 的 tracked 文件，否则视为死规则并失败；新增代码域时增加规则，删除代码域时删除或改写规则。
- doc-map 顶层可选 `rangeBaseline`：一次性初始化边界，值为完整 40 位 commit SHA。`check:docs:range` 默认只检查该提交之后的提交；字段缺失时回退 `origin/main..HEAD`/`main..HEAD`，字段存在但不是仓库内提交或格式非法 → `2`。它是初始化边界，不是免检开关：基线之后仍逐提交检查，冻结证据 backstop 不受影响。
- 同一代码文件可以命中多条规则；每条 `require` 规则都要求至少更新一个目标文档。改动确实不需要文档时，按 §10 的跳过流程处理。

## 8. 一次性记录与冻结证据

- 草稿与未批准方案放 `tmp/specs/`，不进入 `docs/`；批准后才以稳定文件名写入 `docs/specs/`。
- 运行产物、临时报告、复现日志放 `tmp/reports/`，`tmp/` 一律忽略；验收证据与交付报告放 `.agent-reports/acceptance/`，可提交；原始大体积 artifacts 由任务决定是否提交或清理。
- 历史验收证据在 `docs/reviews/c12-final-gate/`，旧设计在 `docs/reviews/legacy/`；只读引用，不修改、不新增。
- living docs 只链接证据路径，不复制报告正文、命令行大段输出或带时间戳的流水账。
- 聊天记录、任务分配、一次性事故复盘不进入 living docs；需要沉淀时提炼成规则、架构结论或 runbook 步骤。

## 9. 模块 README 例外

- 根 `README.md`、`server/README.md`、`ios/README.md` 是模块/入口说明，不强制 `> 结论：` 与 living docs 行数上限，但必须事实准确、命令可执行。
- 它们必须被 `docs/README.md` 直接链接；模块 README 与 `docs/architecture/**` 不应重复同一份契约细节，跨模块结论上移到架构文档并在 README 留指针。
- 模块 README 中的安全示例不得包含真实凭据；凭据只写占位符与文件权限要求。

## 10. 检查器、退出码与跳过

### 10.1 命令

| 命令 | 作用 |
|---|---|
| `npm run test:docs` | 检查器自身测试；`node --test scripts/docs/tests/*.test.mjs` |
| `npm run check:docs` | 全量检查：目录、命名、结构、H1/结论/行数、索引、链接、代码注释中的文档引用、doc-map；I/O 错误显式失败 |
| `npm run check:docs:staged` | 只针对 staged 变更：`require` 缺文档失败、`warn` 提醒、index/worktree 分歧失败 |
| `npm run check:docs:range` | 逐提交检查一个提交范围（默认 `origin/main..HEAD`，回退 `main..HEAD`）：某个提交命中 `require` 但同提交未更新文档 → 失败；`warn` → 提醒；触碰 `docs/reviews/**` 或 `docs/superpowers/**` → 失败 |
| `npm run hooks:install` | 安装 `.githooks` 下的 `pre-commit` / `commit-msg`；`pre-push` 先跑 range 门禁；LFS 旧 hook 通过 `.githooks/post-*` 与 `pre-push` 转发 |

全量检查读取工作区；doc-map 死规则以 `git ls-files` 的 tracked 文件为准，未跟踪文件不参与；staged 检查读取 `git diff --cached`（`ACMRD`，不做 rename 折叠）。

range 检查用 `git rev-list --reverse --parents` 枚举提交（含 merge commit），普通提交用 `git diff-tree --no-commit-id --name-status --no-renames -r -z <commit>`、merge 提交用第一父做同样的 diff，避免“冲突解决时夹带改动”成为盲区。对每个提交独立套用 doc-map：删除文档不算更新，删除代码仍算变更，warn 域只提醒。任何提交触碰 `docs/reviews/**` 或 `docs/superpowers/**` 一律失败（`frozen-evidence-modified`），与 doc-map 是否命中、是否有跳过 trailer 无关——冻结证据不参与“同步文档”的豁免。基线优先级：显式 `--range <base>..<head>` > doc-map `rangeBaseline`（一次性初始化边界）> `origin/main..HEAD` > `main..HEAD`；`rangeBaseline` 存在但无效或三种来源都不可用时以 `2` 失败。`--range` 与 `--staged` 同用 → `2`；空范围 → `0`。

### 10.2 退出码

| 退出码 | 含义 | 处理 |
|---|---|---|
| `0` | 通过，或按 §10.3 显式跳过 | 可继续 |
| `1` | 校验失败：结构/索引/链接/命名/行数/doc-map/staged 缺文档/range 内提交缺文档 | 修文档或修代码映射，不得忽略 |
| `2` | 工具或配置错误：非 git 仓库、缺 `docs/`、缺/损坏 `doc-map.json`、未知参数、`--range` 基线不存在或 `rangeBaseline` 无效、Node 版本不足，或无法读取 tracked 源码 / docs 子树 / git 对象（EACCES、EPERM 等） | 先修环境，不得当作通过 |

`--json` 输出用于自动化：全量/失败包含 `mode`、`ok`、`issues`；staged 包含 `failures`、`warnings`、`impacts`；range 包含 `{ mode: "range", ok, range, commits, failures, warnings }`，其中 `commits` 是 `{commit, subject}` 列表，doc-map 失败项带 `rule`、`codeFiles`、`missingDocs`，冻结证据失败项带 `code: "frozen-evidence-modified"` 与 `paths`；工具错误包含 `error`；跳过包含 `skipped` 与 `reason`。

### 10.3 跳过开关

- 仅当确认本次改动**确实不需要更新文档**时，才使用 `DOCS_CHECK=off` 跳过文档检查。
- 跳过时检查器输出 `skipped: true` 并以 `0` 退出；提交信息必须包含一行：

  ```text
  Docs-Check: off — <至少 8 个字符的理由>
  ```

- `commit-msg` 钩子强制校验该行；`pre-commit` 仍会先拒绝 `docs/reviews/**` 变更。跳过开关不影响 `typecheck`、测试、构建、服务端门禁与 e2e。
- 该开关只影响全量与 staged 检查；`check:docs:range` 始终执行，不会因为环境变量而跳过。带合法 trailer 的提交在 range 检查中才被豁免缺失文档；缺行或理由少于 8 个字符仍判失败。
- 本地 Git 没有机制从技术上阻止 `git commit --no-verify`：它绕过的是 hook，而不是文档同步义务。防线是 `.githooks/pre-push`（range 不通过直接拒绝推送，也不转发 LFS）与 CI root job 的 `check:docs:range`（检查落地后的提交历史）；两者以 `2` 表示门禁没跑成，以 `1` 表示确有提交缺文档。
- 不得用 `--no-verify`、删除 hook、改检查器规则或放宽 doc-map 来绕过失败；这些都属于审查红旗，需要在交付说明中说明并获得批准。

## 11. 违规处理

- 检查失败先判断是文档缺失、链接失效、命名违规还是代码注释引用了不存在的文档；按根因修复，不删除检查项。
- `check:docs:range` 失败时先看报告里的提交哈希与 `codeFiles`：回到该提交补文档（或在确实无需文档的提交信息里写合法 trailer），不得通过移动基线、改 doc-map 或放宽规则消掉失败。
- 文档确实要废弃时，同提交删除文件、更新 `docs/README.md`、更新 `docs/doc-map.json` 与所有入链。
- 规则本身需要调整时，先改 `docs/standards/documentation.md` 与 `AGENTS.md`，再改检查器和测试；不得只改实现让旧测试变绿。
