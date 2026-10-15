---
type: Task
title: 修复 IM 调度条目累计耗尽
description: 让 Octo 和 WeCom 只保留在途编排对象，验证单设备每天一万个独立 Session 的接待及资源回收。
tags: [channel, session, testing]
---

# 目标

修复 Alpha review F2：删除累计 128 个业务会话的接待门槛，排队和本轮投递全部结束后立即回收调度对象。每天一万个不同 Session 不要求一万个并发模型执行。

## 关键合同

- `#sessions` 只登记在途编排，不承担历史列表。无活动执行、无排队消息时删除，失败和控制命令也必须释放。
- Channel 作为业务调用方继续通过注入的 session store 管理 binding、reset 代次和消息幂等；不把这些职责迁入 AdapterHost。默认 store 的容量和期限不是调度对象的回收策略，本任务不增加另一份缓存或持久化。
- 同一聊天串行排队；reset 不改写已排队快照，旧执行更新不得覆盖新代次。卡片重试必须进入当前调度队列，不复用已移除对象。
- 活动状态查询只显示在途条目；`/session` 通过业务 binding 返回当前标识及最近 Run 元数据。
- Run=7、Context=v3 保持；不更改身份、Home、凭据或已有运行状态。

## 范围外

不实施完整 AdapterHost 无缓存改造，不更改默认业务 store 的 TTL/容量、远端会话恢复或可靠投递合同，不声称修复所有 Adapter/IPC 清理风险。

## 验收

两种 Channel 分别模拟一天内一万个不同聊天，逐轮闲置后调度条目为零；验证续聊、控制命令、容量拒绝、prepare/Provider 故障、排队、reset、交互、卡片重试和关闭。不把内存 store 的业务绑定当作调度泄漏。

运行 lint、typecheck、全量测试和 OKF 检查。真实接口验证仅使用 im-test；凭据不入日志或文档，不用发送外部消息制造流量。
