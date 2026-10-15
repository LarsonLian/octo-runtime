---
type: Task
title: OpenClaw 事件入队过滤与容量限制
description: 在 Adapter 内过滤无关 Gateway 广播并限制待消费事件，防止慢消费持续积累内存。
tags: [adapter, openclaw, storage, stream, testing]
timestamp: 2026-10-16T00:00:00Z
---

# OpenClaw 事件入队过滤与容量限制

## 状态与目标

状态：已实施，针对性回归和真实 Gateway 正常调用通过，见[交付记录](../../journal/shared/2026-10-16-openclaw-queue-bounds-delivery.md)。来自[长期运行审查](../../guides/runtime-long-running-review-plan.md)第 1 项。先过滤无关流量，再加固定阈值保证极端情况下仍有上限；不预设过滤一定降低某个数量级，验收记录实际被过滤数量。

[OpenClaw Adapter](../../../packages/octo-runtime-adapter-openclaw/src/index.ts) 的 EventQueue 当前无字节和条数上限，onEvent 接收所有广播，消费循环才过滤 runId。已复现暂停消费后，一万条其他 runId 事件使 GC 后堆增加约 40.8 MiB。目标是无关事件不保留，相关事件也不能无限堆积。

## 责任与范围

修改 OpenClaw Adapter 的单次调用接入、队列与清理；优先复用 [DriverQueue](../../../packages/octo-runtime-adapter-sdk/src/native.ts) 的已有边界，不增加通用总线、持久事件表或另一个重试器。Gateway 的单包 25 MiB 限制不能代替累计队列限制。Host 源流窗口保持自己的合同，不将其 TTL 或淘汰策略强加给 Provider 原始流。

## 首版合同

| 项目 | 固定首版值与行为 |
| --- | --- |
| 待消费事件 | 每 invocation 最多 4096 条，序列化累计最多 4 MiB |
| 单个入队项 | 最多 256 KiB，沿用 DriverQueue 的现有约束 |
| 计量 | UTF-8 JSON 序列化字节；出队、失败和关闭释放累计量 |
| 边界 | 等于上限可接纳；再加入一个项导致大于上限时失败 |
| 溢出 | 单次 STREAM_BUFFER_OVERFLOW；终止本 invocation，不丢 delta 后伪造成功 |
| 隔离 | 只关闭本 invocation 的监听、请求与客户端，不关闭共享 Host 或其他调用 |

入队前根据真实协议分类：

1. agent 事件只接受本次已明确 requestId 或 acceptedRunId 对应的事件。onAccepted 更新接受身份必须在对应后续事件过滤前可见；不能按 Bot 名称、正文或猜测 runId 放宽。
2. 审批请求先按本次真实 sessionKey 及已有 runId 条件过滤，仍执行原权限校验。审批 resolved 事件可按本次 activeApprovals 的真实 ID 匹配，不能因为 resolved 没有 sessionKey 就误丢本次有效结果。
3. 不消费的 Gateway 事件在回调处直接忽略，不先保存完整 payload 再出队丢弃。初始化 pending approvals 列表也按相同规则筛选后入队。
4. agent request 的完成、错误和取消是本次调用的控制结果，必须能够让等待者结束。队列溢出后不得继续排入控制结果，也不得把等待者永远留在 next()。

M1 必须用真实 Gateway 时序和 fixture 检查 acceptedRunId 何时可用。如果协议可能在接受回调之前发送合法任务事件，明确其可验证身份再处理；不引入“先无限保留未知广播”的兼容逻辑。没有证据时不添加预留缓存。

## 停止与释放

溢出在生产回调处立即标记失败并停止接纳，解绑监听、取消本次 RPC/订阅并关闭所属客户端；不能等一个已经暂停消费的调用者重新 next() 才释放后台资源。清理复用原 finally，保持幂等；清空待消费项、待决等待者和计数。已向 Provider 发起执行时，按现有 abort 合同停止，不能因为内存故障再次 invoke 或重新创建 session。

复用 DriverQueue 时检查其 fail/close 对已排队元素的保留语义；本任务要求失败时释放积压，不只是停止增长。错误控制状态必须保留一次，不能清空后又挂起消费方。正常完成仍完整保序，不静默裁剪本次事件。

## 实施里程碑

- [x] M1：本地十万条无关广播不入队，真实 Gateway 核对 accepted 与事件顺序；审批乱序由 fixture 覆盖。
- [x] M2：前置过滤、DriverQueue 容量及失败/取消/提前结束统一清理。
- [x] M3：容量与慢消费回归、3 轮 GC 趋势及监听释放；与既有 Adapter/原生测试联合 84 项通过。
- [x] M4：真实 Gateway 正常调用通过，并单独验证 im-test Channel 建联；真实 IM -> OpenClaw 全链审批/取消尚未覆盖，不据此宣称验收。

## 验收矩阵

| 场景 | 必须观察的结果 |
| --- | --- |
| 消费暂停，连续十万条其他 runId 广播 | 入队数为零；不解析为本次输出；GC 后不随历史条数线性增长 |
| 当前 invocation 的正常事件 | 顺序、delta、工具结果和终态与修复前相同 |
| 4096/4097 条边界及 4 MiB 前后一字节 | 上限内成功，超限只失败所属调用；字节和条数分别可触发 |
| 256 KiB 前后一字节的单项 | 按单项合同处理，无大对象持久滞留 |
| requestId 切为 acceptedRunId | 第一条有效输出不丢；其他任务事件仍不接纳 |
| 他人审批、本次审批、resolved 不含 sessionKey | 他人请求不入队；本次请求与结果完整，权限不放宽 |
| 消费方暂停时溢出、主动 abort、提前 return | 不等后续 next 才解绑；等待者终结，积压释放，重复清理安全 |
| 两个同时调用，一方溢出 | 另一方和共享 Host 正常完成 |

复用现有 OpenClaw 测试及 Node test，增加必要的容量/GC fixture；迭代先 build 后运行针对性测试，最终执行 pnpm typecheck、pnpm lint、pnpm lint:names 和 pnpm test。容量测试使用可控慢消费者，实际内存读数不当作精确 RSS 上限。

## 计划评分

96/100：目标、责任及阈值明确，可直接开发。扣分集中在 accepted 与首帧顺序的真实核对、审批过滤回归和队列失败释放验证；这些是开发验证项，不新增产品设计决策。
