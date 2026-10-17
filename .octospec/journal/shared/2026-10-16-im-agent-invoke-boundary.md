---
type: Journal
title: IM Agent 与通用执行职责纠正
description: 撤回将固定目录视为功能计划的分类，明确业务 Agent 与 invoke 的边界。
tags: [architecture, channel, invoke, workspace, decision]
timestamp: 2026-10-16T00:00:00Z
---

# IM Agent 与通用执行职责纠正

用户指出此前混淆了 IM 长期 Agent 管理与通用 AdapterHost.invoke 的两类需求。将固定 workdir 与 reset 纳入六项开发准备度评分不准确：它是已接受的 IM 架构决策，不是新功能。

新增[分层责任矩阵](../../guides/im-agent-invocation-boundary.md)，接入基础架构、渠道、InvokeInput、Context 工作目录与会话规则。IM 管理 Agent 固定目录、会话映射、reset、背景及投递；通用 Host 执行本轮已给定的请求，Provider 继续处理原生协议。业务 session、Provider binding、一次 invoke 与目录不互相推导。

[原固定目录专项](../../tasks/channel-fixed-workdir-decision/brief.md)保留链接路径，类型改为 Guide，状态为已接受架构决策，不是开发 plan。通用固定/随机目录准备能力保持其合同，不转化为 IM 每 session 一个目录的需求，也不因 IM 固定目录约束其他业务。评审要求先声明规则所属层次，再决定修改边界。

本次仅更新文档，不修改业务代码、运行配置或进程，不执行线上消息或模型调用。文档检查不构成实现与线上验收证明。

OKF lint 与 git diff --check 均通过，规则索引及本地文件链接检查通过。

用户进一步确认目录归属 IM 后台配置对应的 Agent，所有任务固定使用该目录，不接受任务 workdir/workspace 切换。已修正渠道规则中 Context 覆盖默认目录的表述，并同步架构、业务边界与固定目录记录。源码 createImInvocation 仍把目录作为 defaults 交给 resolver 合并；本次没有修改或验收强制限制实现，不能把架构结论写成实现已完成。通用 Host 目录合同继续保持。
