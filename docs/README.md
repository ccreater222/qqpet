# qqpet 文档索引

> 结论：这是 qqpet 开发文档的唯一入口。先读 `AGENTS.md` 与文档规范，再按任务查规格、架构、指南或 runbook；历史验收证据只通过冻结证据说明进入，不直接链接具体报告。

## 先读

| 文档 | 内容 |
|---|---|
| [项目总览](../README.md) | 产品功能、平台、安装与构建入口 |
| [Agent 协作事实源](../AGENTS.md) | 唯一事实源：质量门禁、分支/合并、安全红线、三个人类门禁 |
| [文档规范](standards/documentation.md) | 目录、命名、结构、结论先行、行数上限、同提交更新、检查器与跳过规则 |
| [变更管理](standards/change-management.md) | 重大/小变更分级、测试先行流程、人类三个门禁、证据要求 |
| [Agent 变更审查](standards/agent-change-review.md) | 八条可执行不变量、合并前硬门禁、禁止合并红旗、根因分析模板 |

代码域到文档的映射在 [doc-map.json](doc-map.json)；提交前运行 `npm run check:docs` 与 `npm run check:docs:staged`。

## 规格

| 文档 | 内容 |
|---|---|
| [规格索引](specs/README.md) | 已批准方案列表与状态说明 |
| [文档同步规范](specs/docs-sync-standards.md) | 本次文档体系初始化的批准稿：目录、检查器契约、hook、迁移与验收标准 |
| [客户端数据上游迁移](specs/client-upstream-via-qqpet-server.md) | 客户端数据上游迁到 qqpet-server：`/v1/client/*` HTTP API、客户端上游地址与内容包托管 |

## 架构

| 文档 | 内容 |
|---|---|
| [桌面 IPC 与 preload](architecture/desktop-ipc-and-preload.md) | 主进程窗口/托盘/协议、IPC 通道、preload 白名单、投影投递 |
| [宠物运行时与存档](architecture/pet-runtime-and-save.md) | 共享运行时、存档 schema、本地 v2 权威、原子写与迁移 |
| [同步协议](architecture/sync-protocol.md) | WebSocket hello、命令幂等、revision/eventSeq、resync、关闭码 |
| [服务端数据](architecture/server-data.md) | SQLite schema、WAL/锁、覆盖度、portable import、备份与恢复世代 |
| [原生桥](architecture/native-bridge.md) | Android/iOS/Harmony 双侧方法对齐、能力降级、移动共享层 |
| [手机 UI 层](architecture/mobile-ui.md) | Android 手机 1 CSS px = 1 dp 设计空间、底部菜单/面板、触摸手势、逐界面适配状态与验证 |

## 指南

| 文档 | 内容 |
|---|---|
| [内容包与构建](guides/content-packs-and-builds.md) | 内容包 manifest/base-deletes/minShell、打包、各平台构建与 CI 产物 |
| [服务端部署](guides/server-deployment.md) | `QQPET_SYNC_*` 配置、Docker/systemd、TLS/WSS、secret 挂载、健康检查 |
| [质量门禁](guides/quality-gates.md) | typecheck、测试、构建、服务端、e2e、验收命令与证据位置 |

## 规范（角色约定）

| 文档 | 内容 |
|---|---|
| [后端规范](standards/backend.md) | 服务端权威、协议/数据不变量、SQLite 与恢复、失败策略、验证命令 |
| [前端规范](standards/frontend.md) | Electron 三层结构、`window.qqpet` 契约、投影/本地状态、跨端约束 |

## 运维

| 文档 | 内容 |
|---|---|
| [Runbook 索引](runbooks/README.md) | 所有运维手册的登记入口 |
| [服务恢复](runbooks/server-recovery.md) | 备份/恢复、数据库锁、健康检查、故障处置顺序与验证 |

## 冻结证据

| 文档 | 内容 |
|---|---|
| [冻结证据说明](reviews/README.md) | `docs/reviews/**` 只读规则、历史路径映射、新证据出口（`.agent-reports/acceptance/`） |

本分组只链接冻结证据说明；历史报告与 artifacts 不再逐份索引，也不允许新增或修改。

## 模块说明

| 文档 | 内容 |
|---|---|
| [服务端说明](../server/README.md) | 服务端运行时要求、协议、认证、配置、部署与运维 |
| [iOS 说明](../ios/README.md) | iOS 宿主构建、存储生命周期、输入与平台限制 |

## 维护规则

- 新增/删除 living 文档时，必须同步更新本索引与 [doc-map.json](doc-map.json)；未索引文档会被 `npm run check:docs` 判为失败。
- 新增 runbook 时，同时登记到 [Runbook 索引](runbooks/README.md)。
- 行为或契约变更与文档更新放在同一个提交；确无需更新文档时按 [文档规范](standards/documentation.md) 使用 `DOCS_CHECK=off` 并在提交信息写明理由。
