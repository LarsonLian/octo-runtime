---
type: Task
title: 删除 Runtime 业务能力标签与预留执行目标
description: 从本地执行框架及消费端移除无执行语义的能力标签和 AbilityProvider 预留合同。
tags: [architecture, adapter, context, protocol]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与范围

用户明确要求彻底删除自有 `metadata.capabilities`、执行计划 `required_capabilities` 及整个 `ExecutionTarget`（包括 `standard_harness_agent`、`ability_provider`、`executor_id`、`provider_binding_ref`）。不提供旧字段转换、默认标签或替代能力注册中心。

业务标签、业务 Agent 定义和业务执行目标由业务方管理；本地框架仅通过明确的 Adapter 选择及执行合同调用 Provider。删除范围覆盖 SDK、Adapter、Host 加载与发现、Context schema/校验器、生成类型、fixture、桌面消费者和当前工程知识。

Provider 原生 ACP/MCP/Codex 握手 capabilities 保持原协议语义。`executionFeatures`、`protocolSupport`、`agentSources`、审批、输入、MCP 和工作目录检查仍按实际执行合同处理；不能将删除标签扩大为跳过身份、权限或执行校验。

## 验收

- 自有 Adapter 元数据、发现结果和桌面映射不再声明或依赖 capabilities。
- 执行计划不再定义 required_capabilities；原有严格字段检查拒绝已删除字段，不做静默转换。
- 本地协议不再导出 ExecutionTarget 或其校验器，不保留 AbilityProvider 占位执行分支。
- Run=7、Context=v3、Adapter transport=2 保持不变；既有 Home、身份、profile、配置及 Provider 状态保留。
- 运行协议生成、类型检查、跨包测试和构建；消费者同步构建，受影响进程重启并连接 im-test 验证。未验证项单独记录，不以 mock 代替实测。
- 可复用合同写回 rules/guides，验证结果写入 journal，目录与日志更新。
