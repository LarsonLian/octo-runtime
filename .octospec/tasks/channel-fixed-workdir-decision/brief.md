---
type: Guide
title: IM Agent 固定工作目录与 reset 架构决策
description: 已确认的 IM 业务架构约束，不是功能开发计划，也不扩大为通用 invoke 的目录策略。
tags: [channel, workspace, session, architecture]
timestamp: 2026-10-16T00:00:00Z
---

# IM Agent 固定工作目录与 reset 架构决策

## 决策与状态

2026-10-15 用户明确：“每会话工作目录”是伪需求，不实施。Agent 像 OpenClaw 一样使用固定 workdir；/reset 只切换会话身份及 Provider binding，不切换或清理工作目录。本决策撤回本轮助手将会话目录分区列为缺口的建议。

本文件记录决策依据与评估，不新增随机目录模式，不要求重构现有工作区，不修改代码或宣称完成线上验收。当前实现已有固定目录基础，见[默认目录任务](../channel-default-cwd/brief.md)。

2026-10-16 分类纠正：本文件是已接受的 IM Agent 架构决策，不是待开发 plan，不参与功能计划准备度评分。保留历史专项路径以便追溯；实际规则已写入[架构合同](../../rules/architecture.md)、[渠道合同](../../rules/channel-integration.md)与[会话合同](../../rules/session-reset.md)。

本决策约束 Channel 管理的 IM Agent，不把所有 `AdapterHost.invoke` 调用视为同一个长期 Agent。通用 Host 按本轮请求准备目录，其他业务可以显式选择合法目录；Host 不因 sessionId 变化自动创建目录。完整责任矩阵见[IM Agent 与 invoke 边界](../../guides/im-agent-invocation-boundary.md)。

## 行为合同

- 同一 IM 后台配置对应的 Agent 执行不同任务、普通续聊、不同 DM/群/话题、新会话、进程重启和 /reset 均复用其已配置固定目录，不按任务、conversationId 或 sessionId 生成新目录。
- Channel 已有默认目录为 ~/octo-runtime/channels/{bot_id}；显式 adapter.workdir 指 Agent 配置，不是每任务覆盖项。任务级 workdir 或 workspace Context 不得改变该 Agent 的目录。OpenClaw 保留 Provider 自己管理的固定工作区，不要求 Gateway 重新指定目录。
- /reset 的业务会话标识 conversationId 不变；清除当前业务 session/Provider binding，增加 generation，下一条普通输入延迟分配新逻辑 session 和 Provider session。用户所说“变一下 providerSessionId”表示进入新会话，不是篡改旧 Provider 返回的 opaque ID。
- /reset 本身不调用模型，不删除文件、聊天记录、长期记忆或产物，不隐式取消当前执行。旧执行和已排队请求保留冻结身份，迟到 session.update 不得写回新 binding。
- /reset 后下一条普通输入按[历史专项](../channel-new-session-history/brief.md)尝试一次最近历史补取，允许包含 reset 前聊天；不要求全新无历史对话，也不更换工作目录。

## 方案评估

| 方案 | 对 Agent 的影响 | 结论 |
| --- | --- | --- |
| Agent 固定 workdir | 文件、仓库与产物在会话切换后继续可用，符合长期 Agent 工作方式；重置只处理模型会话 | 采用，延续当前方向 |
| 每会话独立 workdir | 为已有工作树、依赖、产物增加复制或查找问题，并把会话重置扩大为工作区生命周期 | 不采用，不是本次需求 |

固定目录不是安全隔离机制。同一 Agent 的多个会话可能访问相同文件，并发修改存在冲突；是否需要 Agent 级并发约束应按具体业务另行评估，不以此擅自恢复会话目录方案。重置也不会清除文件中的状态，模型在新会话仍可能读到原有产物；这符合本次固定工作区决策。

配置变更导致 workdir 改变是宿主的显式配置行为，不属于 /reset。决策不授权移动、删除或重建 Runtime Home、profile、身份、Provider 数据和工作目录。

## 一致性核对

依据：[请求目录选择](../../../packages/octo-runtime-extra-channel-gateway/src/execution/dispatcher.ts)、[reset 与迟到更新](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)、[会话规则](../../rules/session-reset.md)、[Context 工作目录规则](../../rules/context-input.md)。

后续涉及目录或会话的实现变更，按此架构约束回归：同一 IM Agent 在不同频道及 reset 前后 workdir 相同，Provider session 按合同换新，原文件仍存在；reset 不取消，旧排队身份及迟到更新保持既有约束。其他通用调用方的合法目录配置仍应有效，不能被 IM 策略覆盖。这些是一致性核对项，不是新增功能待办。需要真实调试时连接 https://im-test.deepminer.com.cn/；本轮只改文档。

任务携带不同 workdir/workspace 时也不得改变 IM Agent 目录；Agent 配置显式变更另行处理。当前 resolver 合并路径不代表上述不可覆盖约束已强制实现，核对位置及状态见[渠道规则](../../rules/channel-integration.md)。
