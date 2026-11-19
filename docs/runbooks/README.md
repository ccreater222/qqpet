# Runbook 索引

> 结论：所有运维手册必须先在本页登记，再从 `docs/README.md` 进入。当前只有服务端恢复一本；新增 runbook 时同时更新本页、文档入口与 `docs/doc-map.json`（如涉及代码域）。

## 1. 手册清单

| 手册 | 适用场景 | 不适用 |
|---|---|---|
| [服务恢复](server-recovery.md) | `qqpet-server` 无法启动、备份/恢复、数据库锁、`/readyz` 不就绪、authority/恢复世代异常 | 首次部署（见 [服务端部署指南](../guides/server-deployment.md)）、普通客户端联调、桌面本地存档问题 |

## 2. 使用约定

- 先确认影响面：单机、Docker/Compose、systemd、反代/TLS 还是数据库；按手册里的顺序执行，不跳步。
- 涉及停服、恢复、删除备份、修改 restore generation 的操作属于不可逆操作，必须先获得人类批准；执行前保留原库与证据。
- 命令统一在仓库根执行；服务端命令使用 `npm --prefix server ...` 或 `node server/dist/server/src/index.js ...`，不要假设全局安装。
- 任何时候都不要读取 `.env`、凭据文件或生产数据内容；需要凭据时只传路径并保持 `0600`。
- 恢复后至少验证 `/healthz`、`/readyz`、authority/revision/eventSeq、一次无害命令和第二个客户端的投影更新。
- 失败时保留日志与现场，按 `docs/standards/agent-change-review.md` 的根因模板记录；不要用静默降级或删除证据来“恢复”。

## 3. 新增 Runbook 检查表

- [ ] 文件名稳定、描述性，无版本号/临时标记。
- [ ] 一个 H1，H1 后第一段以 `> 结论：` 开头。
- [ ] 写清触发条件、处置顺序、验证命令、回滚方式、禁止操作。
- [ ] 在本页登记，并在 `docs/README.md` 运维分组直接链接。
- [ ] 如改动映射代码域，同步更新 `docs/doc-map.json` 与相关架构/指南文档。

## 4. 相关入口

- 文档入口：[docs/README.md](../README.md)
- 服务端部署：[服务端部署指南](../guides/server-deployment.md)
- 质量门禁：[质量门禁](../guides/quality-gates.md)
- 后端约束：[后端规范](../standards/backend.md)
