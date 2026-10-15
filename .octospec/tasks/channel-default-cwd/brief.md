---
type: Task
title: Channel Gateway 默认工作目录
description: 允许省略本地引擎 workdir，按 Agent 使用固定目录。
tags: [channel, workspace]
timestamp: 2026-10-15T00:00:00Z
---

省略 Octo Channel Gateway 的 adapter.workdir 时，使用并创建 ~/octo-runtime/channels/{bot_id}。显式绝对目录、Context 执行覆盖规则和 OpenClaw 原生工作区继续按原合同处理。不修改通用 extraset 的声明保存边界。

2026-10-16 架构决策修正上述历史覆盖表述：目录归属 IM 后台配置对应的 Agent，任务级 workdir/workspace 不得覆盖；显式目录指 Agent 配置，OpenClaw 保留其 Provider Agent 固定工作区。当前规则见[IM 业务目录边界](../../rules/channel-integration.md)，不把本历史记录作为任务切换目录的依据。

验收覆盖配置加载、目录创建、跨 Event 复用、显式路径、路径穿越拒绝及 OpenClaw。真实身份检查连接 im-test，凭据只从本机受保护文件读取，不写入验证记录。
