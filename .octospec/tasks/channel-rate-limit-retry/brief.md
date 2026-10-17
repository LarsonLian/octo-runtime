---
type: Task
title: Channel 限流与重试对齐专项
description: 复用已有重试并衔接独立 Codex 重试任务，不新增用户/会话令牌桶需求。
tags: [channel, adapter, retry, testing]
timestamp: 2026-10-15T00:00:00Z
---

# Channel 限流与重试对齐专项

## 已确认结论与协作范围

2026-10-15 用户意见：限流时采用重试；另一处 Codex 任务正在修改相关逻辑。本专项只记录边界、核对现状和交接验收，不实现第二套重试器，不将旧项目的用户/会话限流作为新增需求，不派发或干预另一聊天。

当前实现是否已满足“限流会自动重试”必须按请求层次分别判断，不能笼统回答已支持。业务执行重试沿用[IM 长任务与 Codex 故障重试](../im-long-running-retry/brief.md)，首期已实施，下表按当前源码更新，不表示已部署。

## 当前事实

| 层次 | 当前行为 | 含义 |
| --- | --- | --- |
| Octo REST 公共 postJson/getJson | 默认允许 429 重试，MAX_429_RETRIES=2，最多首次加两次；另有等待预算与 Retry-After 上限 | 本次历史与出站成员校验均复用该客户端；不是所有 REST/WS 请求都受它覆盖 |
| IM 投递 dispatcher | 非 transient 最多三次投递尝试，按 HTTP 状态及等待限制决定继续 | 只重试投递，不重新运行模型 |
| Codex Provider 原生重试 | willRetry=true 映射为 retry_scheduled notice | Provider 内部继续；不代表 Channel 已再次 invoke |
| Channel 执行循环 | 工具/交互前的明确 Codex 暂态限流及不可用失败按预算再次 invoke；原生重试纳入同一预算，断流提示未知 | 只覆盖该边界，工具后的安全恢复仍待实施 |

依据：[REST client](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/client.ts)、[投递 dispatcher](../../../packages/octo-runtime-extra-channel-gateway/src/delivery/dispatcher.ts)、[Codex app-server](../../../packages/octo-runtime-adapter-codex/src/app-server.ts)、[IM 执行循环](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)。本表是源码核对，不是部署证据。

## 对齐要求与待确认

限流恢复沿原层次处理，遵守 Retry-After、任务剩余期限及取消信号。Provider 自身正在重试时，不得同时新建业务执行；投递失败不触发 Agent 重跑。401/403、输入错误和执行结果未知不能仅因希望恢复就当成 429。

是否由 Channel 在明确失败终态后重新 invoke、具体恢复预算与工具执行后的恢复条件，由已有重试专项决定。这里不新增默认次数、短任务期限、账号轮换承诺或持久化隔离账本。

另一任务完成后，核对实际修改范围、配置与错误样本，分别验证 REST 限流、模型限流、原生重试、取消退避和结果未知。业务重试需要 https://im-test.deepminer.com.cn/ 真实链路验证，不能仅凭进度卡“正在重试”判定恢复成功。

## 本轮核对结果

2026-10-16 保留既有实现，没有再造限流器或业务重试器。全仓回归覆盖 REST 429、Provider notice、业务重试预算、退避取消及工具后禁止重放。真实 Codex 注入一次 503 后，第二次尝试成功，最终标记匹配；该脚本独立检查 im-test 认证合同，没有发送 IM 消息。另一个隔离群脚本验证正常 IM 链路和真实 Codex 图片执行，但没有在真实 IM 执行期间注入限流；不把两组证据拼成这一场景已验收。详见[交付记录](../../journal/shared/2026-10-16-channel-features-delivery.md)。
