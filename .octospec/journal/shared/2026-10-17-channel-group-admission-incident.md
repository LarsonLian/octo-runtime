---
type: Journal
title: 群聊明确点名无响应的事故调查
description: CLI 和 SDK 共用群范围缺陷已复现，处理计划建立，业务修复尚未实施。
tags: [channel, identity, incident, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 调查结果

本篇记录最初调查阶段，文中“未修复”和旧 [] 拒绝行为均为当时事实。后续用户已确认新合同并授权实施，当前进展见[修复交付](2026-10-17-channel-group-admission-delivery.md)，不以本历史记录定义当前配置语义。

用户报告 SDK 注入 Bot 私聊可回复、群聊明确点名无响应，随后补充 CLI 同样发生，要求作为事故形成 Octospec 分析处理计划。已建立[事故专项](../../tasks/channel-group-admission/brief.md)、[根因与证据](../../tasks/channel-group-admission/analysis.md)及[处理计划](../../tasks/channel-group-admission/plan.md)。当前状态为已定位、修复待实施，未宣布恢复。

共同原因是 acceptsImMessage 对省略 group_ids 的可选链结果取反，导致所有群/话题在 mention 和模型执行之前被拒绝；私聊提前返回。与 Schema 的“省略不限制”及默认 CLI 示例矛盾，历史代码早于本轮 SDK 函数装配。另发现发送者 Schema/README 的省略说明与 owner 默认设计不符，计划只纠正说明，不放宽授权。

本轮新增三个准入/transport 回归，在未修改业务代码的情况下均失败，原有两项通过。im-test 仅读取既有 QA 群历史，将真实 payload 在本地重放：显式指定群通过、省略群拒绝；空名单、名单外、未授权、错 Space 和无 mention 均拒绝。发送消息和模型调用均为 0，不将该重放称为实时 WS/回复闭环。

本机 CLI Bot 配置已通过安全字段投影核对为 group_ids 省略，服务指向正式环境，因此未访问该业务环境。未更改配置、Home、身份或安装；第三方 App 的完整配置及截图报文元数据尚未取得，不宣称所有部署均已核实。当前的失败回归是事故复现证据，后续实施必须转绿；本轮不重复全量测试并将预期失败伪装成通过。
