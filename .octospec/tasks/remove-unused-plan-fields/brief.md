---
type: Task
title: 删除没有执行消费者的计划字段
description: 删除 required_execution_features 和 provider_compatibility，核实场景、快照及派生执行参数的真实用途。
tags: [protocol, context, architecture]
timestamp: 2026-10-15T00:00:00Z
---

# 范围

用户同意删除 `required_execution_features`、`provider_compatibility`。两者仅定义和校验格式，Core 不生成，Host 不据此执行匹配。同步删除 schema、生成类型、校验和正向样例；旧字段由现有严格字段白名单拒绝。保持 Run=7、Context=v3 和 Adapter transport=2。

另核实 `scenarioBuilders`、`contextSnapshot` 与 `ResolvedExecutionPlan` 的生产调用链，纠正前次审查中可能将内部派生参数描述成调用方必须维护多份协议的歧义。这三项本次仅澄清事实和后续收敛方向，不声称已移除。

## 验收

- 生产定义、生成类型和校验不再接受两个字段；保留删除回归样例。
- 保留实际审批、工作区、模型、envs、MCP 和执行身份校验。
- 构建 Runtime、Worker、桌面；运行相关跨包测试，记录真实联调及未验证范围。
- 不删除或重置 Home、身份、profile、配置、Provider 状态或数据库。
