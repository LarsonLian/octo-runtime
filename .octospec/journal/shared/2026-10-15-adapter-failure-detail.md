---
type: Journal
title: Adapter 执行失败详情透传验证
description: 统一 run.failed 展示，保留 Provider 原始原因并区分工作目录与命令缺失。
tags: [adapter, channel, testing]
timestamp: 2026-10-15T04:30:00Z
---

# 结果

所有 Adapter 共用 CanonicalEvent run.failed，卡片统一显示“执行失败”。Host 分类只追加既有 failure 信息，不再用目录摘要覆盖 message，也不再丢弃 error 等脱敏后的原始字段；InvocationExperience 保留完整终态。没有新增按 Provider 划分的错误码。

Codex 保留 turn error 与 RPC error 的 code/message/data，Claude Code 保留 result 的 subtype/errors。卡片摘要优先显示实际 message，展开内容及最终文本补充结构化 error；没有实际详情时才使用既有错误码摘要。展示遵循服务端字符、动作数量与字节预算，最终文本最多 8000 字符。凭据继续脱敏。

Node spawn 的 ENOENT 同时可能来自命令或 cwd 缺失。Host 对相关 errno 核查工作目录，补充不存在、不是目录或进入权限不足的原因；不会自动创建显式配置的目录。Claude Code 的启动失败还修复了 exitPromise 在消费前触发未处理拒绝的问题。

# 验证

- Workspace 构建、pnpm lint、tsc -p tsconfig.json --noEmit 通过。
- 全量 Node 测试 747 项：740 通过、7 跳过、0 失败。覆盖 Codex/Claude Code 的真实 spawn、任意 Adapter 的 canonical 错误、结构化错误、凭据脱敏及 0.4.0/0.4.1 卡片合同。
- 两条旧测试要求不显示错误正文，按本次合同更新为验证正文保留且凭据被替换；未改变终态数量、分类和清理行为断言。
- 使用现有测试配置读取 im-test.deepminer.com.cn 的真实卡片能力，协商 ai.reasoning-process 0.4.1。
- 用真实 Codex 命令和不存在的 /srv/octo/workspaces/dev 产生失败，卡片正文为“配置的工作目录不存在（adapter.workdir=/srv/octo/workspaces/dev）。spawn codex ENOENT”；原始 error.code/message 仍保留。卡片报文 1009 字节，合同校验及预算校验通过。
- 未调用模型、未发送或编辑 IM 消息；线上验证范围为能力读取与真实本地失败生成的报文，不宣称已完成 IM 收发闭环。

# 运行状态

未更改既有 Home、profile、身份、凭据或 Bot 配置。本机全局 CLI 链接指向当前 checkout 的 dist。当前用户启动的是前台 daemon，构建不会热替换已经加载的代码；需在原终端停止后重新运行 octo-runtime daemon run。本次不切换为后台服务，也不停止其他应用持有的 daemon。

Run=7、Context=v3、FailureEnvelope 与 HostFrame 的协议版本和 schema 均未修改。
