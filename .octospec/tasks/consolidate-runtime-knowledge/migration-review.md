---
type: Task
title: 旧文档逐份审查清单
description: 31 份原始材料的去向、保留范围与删除理由。
tags: [documentation, migration]
timestamp: 2026-10-15T00:00:00Z
---

# 逐文件审查与去向

基准：当前源码与 `df63c8f`。旧文件路径仅用于 Git 追溯，不是当前可访问文档。

| 原材料 | 当前位置 | 取舍 |
| --- | --- | --- |
| `docs/01-architecture.md` | [rules/architecture.md](../../rules/architecture.md) | 合并至已有架构规则，删除重复拓扑正文。 |
| `docs/02-module-and-transport-flow.md` | [rules/local-execution.md](../../rules/local-execution.md) | 按统一公共输入、内部 RPC 与源流重写。 |
| `docs/03-monorepo.md` | [guides/workspace.md](../../guides/workspace.md) | 保留 workspace、构建、包依赖及扩展步骤。 |
| `docs/04-prompt-and-workdir.md` | [rules/context-input.md](../../rules/context-input.md) | 合并模型输入、控制通道和 cwd 边界。 |
| `docs/05-provider-adapters.md` | [guides/providers.md](../../guides/providers.md) | 保留 Provider 矩阵与恢复/权限差异，历史验证改为引用摘要。 |
| `docs/06-openclaw-local-adapter.md` | [rules/openclaw.md](../../rules/openclaw.md) | 并入连接合同，移除重复入口。 |
| `docs/07-operations.md` | [guides/operations.md](../../guides/operations.md) | 保留真实状态判断、排障与日志使用。 |
| `docs/08-adapter-authoring.md` | [guides/adapter-authoring.md](../../guides/adapter-authoring.md) | 保留接口示例、清理约束与验收步骤。 |
| `docs/09-transport-and-multinode.md` | [rules/local-execution.md](../../rules/local-execution.md) | 并入执行规则；多节点只保留外部业务责任，不写成已实现功能。 |
| `docs/10-protocol-schema-codegen.md` | [rules/protocol-schema.md](../../rules/protocol-schema.md) | 保留 Schema/生成/校验分工和协议版本。 |
| `docs/15-openclaw-external-agent-binding-design.md` | [rules/openclaw.md](../../rules/openclaw.md) | 保留当前连接合同；修正 enrollment、目标默认值及重复术语。 |
| `docs/15-stateless-executor-design.md` | [rules/stateless-execution.md](../../rules/stateless-execution.md) | 提炼当前纯执行约束；移除迁移计划措辞，历史验证归 journal。 |
| `docs/25-run-mcp-context.md` | [rules/mcp.md](../../rules/mcp.md) | 保留字段、合并、模板展开、Adapter 限制和测试入口。 |
| `docs/26-channel-local-stream-and-ack-plan.md` | [rules/channel-integration.md](../../rules/channel-integration.md) | 提炼渠道与 Host 边界；不将 Work App 的 SQLite 批写策略写成 Runtime 实现。 |
| `docs/27-native-canonical-protocol-contract.md` | [rules/output-protocol.md](../../rules/output-protocol.md) | 保留帧、接纳、交互和源流合同；公共签名按源码更新，旧里程碑与验收归 journal。 |
| `docs/agent-source-and-react-capabilities-requirements.md` | [rules/adapter-capabilities.md](../../rules/adapter-capabilities.md) | 保留来源和能力声明，区分代码支持与真实可用。 |
| `docs/context-envs.md` | [rules/environment.md](../../rules/environment.md) | 保留列表、合并、冻结、环境优先级及不支持路径。 |
| `docs/context-extensions.md` | [rules/context-extensions.md](../../rules/context-extensions.md) | 保留未知可选字段与 extra 固定渲染边界。 |
| `docs/context-llm-injection.md` | [rules/context-input.md](../../rules/context-input.md) | 保留完整分类矩阵与每轮业务归属，补当前输入/目录准备依据。 |
| `docs/extra-plugins.md` | [rules/extras.md](../../rules/extras.md) | 拆为加载规则和配置指南；移除未实现的布局/启动展示教程，历史说明其状态。 |
| `docs/openclaw-runtime-unification-validation.md` | [journal/shared/provider-validation-history.md](../../journal/shared/provider-validation-history.md) | 压缩日期、真实证据和未验收范围，不保留旧操作教程。 |
| `docs/reasoning-level-mapping.md` | [rules/reasoning.md](../../rules/reasoning.md) | 保留当前映射与警告码，失败及未验收项另存历史摘要。 |
| `docs/runtime-local-and-online-contract.md` | [rules/runtime-lifecycle.md](../../rules/runtime-lifecycle.md) | 保留当前 SDK 生命周期、事实判断与安装归属。 |
| `docs/runtime-machine-identity-spec.md` | [rules/runtime-lifecycle.md](../../rules/runtime-lifecycle.md) | 并入生命周期规则，补身份文件独立版本及源码校验。 |
| `docs/session-ownership-reset-ipd-se.md` | [rules/session-reset.md](../../rules/session-reset.md) | 保留当前内存 reset、代次防迟到与容量约束。 |
| `packages/octo-runtime-protocol/docs/invoke-input.md` | [rules/invoke-input.md](../../rules/invoke-input.md) | 统一放入知识包，保留完整字段、多模态和默认值。 |
| `docs/validation/openclaw-workspace-ignored-2026-10-14.md` | [journal/shared/provider-validation-history.md](../../journal/shared/provider-validation-history.md) | 提炼为历史证据摘要，保留失败和未验收边界；详细原文留在 Git。 |
| `docs/validation/extra-sse-demo.md` | [journal/shared/provider-validation-history.md](../../journal/shared/provider-validation-history.md) | 提炼为历史证据摘要，保留失败和未验收边界；详细原文留在 Git。 |
| `docs/validation/obsolete-package-cleanup-2026-10-15.md` | [journal/shared/provider-validation-history.md](../../journal/shared/provider-validation-history.md) | 提炼为历史证据摘要，保留失败和未验收边界；详细原文留在 Git。 |
| `docs/validation/run-mcp-context-2026-10-14.md` | [journal/shared/provider-validation-history.md](../../journal/shared/provider-validation-history.md) | 提炼为历史证据摘要，保留失败和未验收边界；详细原文留在 Git。 |
| `docs/validation/context-envs-2026-10-13.md` | [journal/shared/provider-validation-history.md](../../journal/shared/provider-validation-history.md) | 提炼为历史证据摘要，保留失败和未验收边界；详细原文留在 Git。 |

另外补充 [架构演进](../../journal/shared/architecture-evolution.md)，按 Git 提交说明被撤回的设计及替代结论。当前规则与历史事实分开维护，不做旧方案镜像。
