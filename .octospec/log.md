# 工程知识变更记录

## 2026-10-15

- 按[任务](tasks/remove-unused-plan-fields/brief.md)删除未消费的 required_execution_features 和 provider_compatibility；同步 schema、生成类型、校验及样例。补充场景白名单、渠道快照和内部派生参数的[调用链澄清](journal/shared/2026-10-15-protocol-simplification-review.md)，验证及未完成范围见[记录](journal/shared/2026-10-15-remove-unused-plan-fields.md)。

- 按[任务简报](tasks/remove-business-capability-contract/brief.md)删除自有 Adapter capabilities、执行计划 required_capabilities 和 ExecutionTarget 预留设计；业务标签归业务方，真实执行与 Provider 原生握手协议独立保留。现行规则改为 [Adapter 执行元数据](rules/adapter-metadata.md)，验证范围见[实施记录](journal/shared/2026-10-15-remove-business-capability-contract.md)。

- 实施 [Playboard 统一 daemon 执行](tasks/playboard-daemon-execution/brief.md)：移除 CLI 的 Provider 特殊装配，复用 daemon 启动与本地 RPC，隔离 PID/socket/账本，保留既有配置和常驻实例。构建、类型、lint、全量回归和真实 Codex/OpenClaw 执行通过，线上环境与未验收边界见[验证记录](journal/shared/2026-10-15-playboard-daemon-execution.md)。

- 记录 [Playboard 统一 daemon 执行决策](tasks/playboard-daemon-execution/brief.md)：复盘直接启动 Host、重复 Provider 装配及 RPC 层次混淆，明确临时 daemon、状态隔离与验收要求；本次仅写入 OKF，代码和线上验收待实施。

- 修复 Alpha review F2：Octo/WeCom 回收闲置会话调度条目，移除累计 128 个会话门槛，旧卡片重试进入当前队列。双渠道分别验证模拟每日一万个会话，追加 [评审修正状态](journal/shared/2026-10-15-alpha-code-review.md)及[验证记录](journal/shared/2026-10-15-im-session-scheduling-release.md)；完整 AdapterHost 无缓存目标、S1/F1 保持待实施。

- 将 OpenClaw 自动发现和刷新移到 CLI 启动编排，SDK 显式配置，Adapter 只读连接；见 [合同](rules/openclaw.md)与[验证记录](journal/shared/2026-10-15-openclaw-cli-discovery.md)。

- 接入 octo-spec / OKF，补充中文 Agent 入口、规则索引与工作流。
- 将架构正文迁入 `rules/architecture.md`，根目录仅保留导航。
- 验证记录见 [接入与架构迁移](journal/shared/2026-10-15-okf-onboarding.md)。
- 按当前源码与 Git 演进审查全部 31 份旧材料，整理为规则、指南和历史摘要，移除根与协议包的 docs 目录。
- 修正过时接口与未实现拓扑，补充规则索引和本仓知识/链接校验；结果见 [全量整理验收](journal/shared/2026-10-15-knowledge-consolidation.md)。
