---
type: Journal
title: 总体协议与调用设计文档核对
description: 记录协议总览的源码依据和文档验证范围。
tags: [protocol, invocation, interaction, documentation]
timestamp: 2026-10-15T00:00:00Z
---

# 核对范围

按 [任务简报](../../tasks/protocol-design-overview/brief.md)，基于 Git `836135d` 与当前工作树核对 SDK、daemon、Host RPC、HostRunService、交互类型及 Codex／ACP／native 回答实现，形成 [总体协议与调用设计](../../rules/protocol-design.md)。

文档明确区分统一交互信封、审批 schema 和 Provider 特定的追问／elicitation 内容。当前不存在通用 Adapter 互调协议；多个业务调用由业务层编排。

## 验证

- `uv run --with pyyaml python .octospec/scripts/lint.py` 通过：65 个 OKF 单元、20 条规则、565 个本地文件链接。
- `git diff --check -- .octospec` 通过。

系统 Python 缺少 PyYAML，改用仓库说明中的 uv 临时依赖环境完成检查。本次只改文档，不修改协议或运行配置，不运行真实 Provider、线上接口或 CDP，不将历史结果写成本次验收。
