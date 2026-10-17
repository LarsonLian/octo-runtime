---
type: Journal
title: Mention 人类协议与首次 Context 决策
description: 记录源码核查后的发送分工、首次 guidance、设计修正和纯文档验证边界。
tags: [channel, context, identity, decision]
timestamp: 2026-10-15T00:00:00Z
---

# Mention 人类协议与首次 Context 决策

## 结果

在[六专项初稿](2026-10-15-channel-six-topic-alignment.md)之后，按用户继续讨论更新[mention 简报](../../tasks/channel-mention-context/brief.md)：普通回复不自动 @ 的决策保持；用户明确要求点名同频道真人时，模型按需查询身份，在最终回答中使用现有标记，由 Channel 随最终回答发送。

新增[协议依据](../../tasks/channel-mention-context/protocol.md)、[Context 指引](../../tasks/channel-mention-context/context-guidance.md)和[完整 v3 JSON 样例](../../tasks/channel-mention-context/first-context.example.json)。补充旧设计把语义意图、身份查询及实际发送混在一起的问题，明确工具查询不需要重复承担最终总结发送。同步专项 context.yaml、目录及变更记录。

## 证据与限制

人类 Web、Work App 及旧 codex-channel-octo 的可查发送端实现使用可读正文与 mention 元数据；本机 octo-cli schema/help 已确认成员查询命令。本次没有取得 IM Server 对应实现，不能声称原始标记单独发送必然产生通知，也不声称服务端绝不会解析标记。

这是设计与文档交付，Gateway 接线尚未实施。Bot 目标、广播及原生 reply 的通知行为保留待决；无新持久化状态。后续真实通知、高亮和模型执行必须在 im-test 验证。

## 检查范围

OKF lint、git diff --check 均通过；首次 JSON 样例通过现有 Context v3 校验器，协议 JSON 可解析且 UTF-16 entity 位置正确。未修改业务代码、运行配置或进程，未发送线上消息，未执行模型或 CDP 功能验收。
