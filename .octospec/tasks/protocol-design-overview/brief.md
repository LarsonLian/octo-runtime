---
type: Task
title: 补齐 Runtime 总体协议与调用设计
description: 将散落的输入、传输、输出与交互合同串成可导航的总体说明。
tags: [protocol, invocation, interaction, documentation]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与范围

用户指出 `.octospec` 缺少总体协议与调用设计。以当前源码和专项规则为依据，补充调用方、daemon、AdapterHost、Adapter 与 Provider 的关系、协议分层、执行时序、身份、审批／追问往返及取消续流边界。

## 关键合同

- 不新增执行协议，不修改代码、Runtime 配置、身份或运行状态。
- 区分公共 InvokeInput、内部 InvokeRequest、两层 RPC、Host 输出与 Provider 原生协议。
- 明确当前没有通用 Adapter 互调协议；不虚构编排能力。
- 区分统一交互信封和 Provider 特定的问题／答案结构，不宣称追问 schema 已完全统一。
- 保持 Run=7、Context=v3、Adapter transport=2 和 approval=v1 独立。

## 验收

- 总览位于 rules 并进入目录及机器索引，专项规则和开发指南可回到总览。
- 接口名称、模式、交互结果与当前实现对应，并提供源码入口。
- OKF、索引和本地 Markdown 链接检查通过；记录检查范围，不声称重新完成线上验收。
