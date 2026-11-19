# Reviews（验收评审与历史设计归档）

> 结论：本目录只读；历史证据按字节冻结，新证据不得写入。

本目录保存**已冻结**的验收报告与历史设计文档，属于只读证据区。

## 冻结内容

| 目录 | 内容 |
| --- | --- |
| `c12-final-gate/` | C12 最终验收门禁的 3 份冻结报告（2026-10-22、2026-10-23、2026-11-18）及其机器可读 artifacts |
| `legacy/` | 历史设计文档（2026-10-20 本地/服务端宠物数据设计） |

## 旧路径映射

`docs/superpowers/` 已迁移并删除，旧路径对应关系如下：

| 旧路径 | 新路径 |
| --- | --- |
| `docs/superpowers/acceptance/` | `docs/reviews/c12-final-gate/` |
| `docs/superpowers/specs/` | `docs/reviews/legacy/2026-10-20-local-or-server-pet-data-design.md` |

冻结文件内容按字节原样迁移（git rename 100%），报告正文中的历史路径字符串保留为历史事实，未做改写。

## 新证据写到哪里

新的验收证据**不再写入本目录**，统一写到仓库根的 `.agent-reports/acceptance/`：

- 报告：`.agent-reports/acceptance/<YYYY-MM-DD>-c12-final-gate.md`
- 机器可读 artifacts：`.agent-reports/acceptance/artifacts/c12-{e2e,docker,proxy,gate}/`

`.agent-reports/` 用于提交的实现/验收证据，具体是否提交由对应任务决定；临时复现材料放 `tmp/reports/`，不要放在这里。

## 规则

- **禁止新增或修改**本目录下的冻结报告与 artifacts；它们只代表当时那次验收的事实。
- 不得用新证据覆盖、编辑或"修复"冻结报告，历史结论与限制保持原样。
- 需要新的验收结论时，输出到 `.agent-reports/acceptance/`，不要在这里追加。
- 上述历史路径映射只用于追溯，不是当前可写路径。
