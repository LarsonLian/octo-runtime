---
type: Journal
title: OpenClaw 广播过滤与队列容量交付
description: 前置身份过滤、有限缓冲和暂停消费者清理的实现及验证证据。
tags: [openclaw, adapter, storage, testing]
timestamp: 2026-10-16T00:00:00Z
---

# OpenClaw 广播过滤与队列容量交付

OpenClaw 入队前按本次 requestId/acceptedRunId、真实 sessionKey 及审批 ID 过滤。已准入审批 ID 在生产端登记，解决 requested/resolved 连续到达而消费者尚未处理 requested 的时序问题；数量仍受 1024 上限约束。不消费的广播直接忽略。

复用 DriverQueue 的 4096 条、4 MiB、单项 256 KiB 边界，增加可选失败回调与失败清空选项，仅 OpenClaw 启用；其他 Driver 保持既有队列语义。溢出时不等消费恢复就解绑、取消 agent 请求、发出有期限的 sessions.abort 并关闭所属客户端。容量故障直接失败，不走断线成功对账；提前 return 同样取消未完成的 Provider 调用。正常完成保序。

自动化：现有 Adapter、native Host、审批及消息分段与新容量测试共 84 项通过；额外使用 `node --expose-gc --test test/openclaw-queue-bounds.test.js` 验证 GC。10 万条无关广播入队次数为零；4096/4097、4 MiB、单项 256 KiB 边界、暂停时溢出立即清理和提前 return 均覆盖。GC 用例连续三轮各一万条独立约 4 KiB 无关载荷，每轮回收后相对基线堆增量小于 8 MiB；此值是回归容差，不是进程 RSS 合同。

真实 Provider：`scripts/verify-openclaw-bounds-live.mjs` 读取既有本机 OpenClaw 配置，临时设备密钥仅在内存，不重写现有身份/Home/Provider 配置。Gateway protocol=4，实际 accepted 回调先于本次 agent 事件，8 条原生事件后 run.completed，回答包含测试标记。审批和取消的故障边界使用本地受控测试，没有强制真实工具审批或宣称已完成 IM→OpenClaw 整链路验收。im-test 的实际 Channel 建联/卸载由同批四专项的容量验证脚本执行；两条证据分别报告。
