---
type: Journal
title: Mention 尽力点名与正文优先决策
description: 由模型决定目标不明时降级，去除额外失败提示，final 发送沿用现有链路。
tags: [channel, context, identity, decision]
timestamp: 2026-10-16T00:00:00Z
---

# Mention 尽力点名与正文优先决策

## 用户决策

在[协议与首次 Context 决策](2026-10-15-mention-protocol-context-decision.md)基础上，用户确认：能点名就点名；模型认为找不到合适目标时使用普通 @名字 或纯文本，不强制询问，也不展示“未完成点名任务”。发送前身份校验失败不影响最终正文，不新增反馈逻辑。

仅 final 文本正文中的显式标记参与转换，代码块内容保持原样；继续排除行内代码和引用示例。thinking、工具输出和进度不触发点名。沿现有最终回复链传递 content 与 mention，不让模型再用 CLI 发送总结，不为点名失败新增模型重跑、纯文本补发或持久账本。正文投递本身的失败仍按原发送合同处理。

## 文档变更

同步[专项简报](../../tasks/channel-mention-context/brief.md)、[Context 指引](../../tasks/channel-mention-context/context-guidance.md)、[首次 JSON 样例](../../tasks/channel-mention-context/first-context.example.json)、[协议说明](../../tasks/channel-mention-context/protocol.md)与 context.yaml。撤回此前“同名必须澄清”“点名失败必须追加可见反馈”的要求，并移除无效标记反馈形式的待决项。Bot 与广播范围仍独立待决。

## 验证范围

OKF lint、git diff --check、Context v3 样例校验及 Markdown/JSON guidance 一致性检查均通过。本次只更新计划，未修改业务实现、运行配置或进程，未发送线上消息；功能实现后仍须在 im-test 验证真实收发与通知。
