---
type: Journal
title: PR 49 对照与 IM 诊断后空成功问题核查
description: 记录当前工作树对重连通知和无有效回复的处理、自动化证据及后续改造边界。
tags: [channel, adapter, testing, delivery]
timestamp: 2026-10-16T00:00:00Z
---

# PR 49 对照与 IM 诊断后空成功问题核查

## 核查结论

用户先要求判断 [codex-channel-octo PR #49](https://github.com/Mininglamp-OSS/codex-channel-octo/pull/49) 解决的问题在当前 Runtime 是否存在，随后明确只比较处理行为和用户体验，不讨论 app-server 与 SDK 的路线选择。最后要求将不合适的收尾体验写入 OKF，包含参考实现、检查结果、体验目标和改造计划。

当前同次执行在重连通知后继续消费，恢复后正常返回答案；最终失败、提前进程退出和取消分别按实际结果处理。IM 已有恢复预算、单张卡片、最终文本及不重放未知结果的保护。核心“中间通知提前终止可恢复任务”未复现。

确认的缺口是：过程诊断后 Provider 返回 completed，但没有有效 final 回复时，canonical 不保留该过程原因，IM 仍使用“本轮执行完成，未返回文本。”收尾。该行为容易使用户误认任务完成或再次执行。

这不是“所有无文本成功都应改为失败”的结论。后续由 Adapter 传递诊断事实，Channel Gateway 区分 Provider 终态与业务交付判断，详见[专项计划](../../tasks/im-diagnostic-silent-completion/brief.md)。本次只新增规划文档。

## 参考实现固定点

- PR head：`5d664fe64e1ad2bf07a8e6fea94fe48110dabdb8`。2026-10-16 查询状态 OPEN；ESLint、Vitest Node 24.10.0、Vitest Node 22、TypeScript、Build/package 五项 check 均 success。
- 通过 GitHub API 核对该 head 的 `src/agent-bridge.ts`：保留首条 pendingFailure，持续消费同次执行；完成后用实际输出选择器判断是否有回复，空选择仍返回原故障；真实终态及进程/解析/取消故障保持优先。
- PR 记录的 87 文件/1883 测试属于参考仓库结果，本次没有在本机复跑该仓库，不作为 Runtime 验收数量。
- Runtime 核查对象是 2026-10-16 当时的当前工作树；文档整理时 HEAD 为 `8524f3f63384089f60db254fc609e2e2c570a3ba`，目录包含其他进行中的修改，不能将该 SHA 单独当作全部核查源码快照。

## 已执行检查

先单独构建 Codex Adapter，确保临时探针使用该工作树的编译产物：

```bash
pnpm --filter @mininglamp-oss/octo-runtime-adapter-codex build
node --test test/codex-app-server.test.js test/adapters.test.js test/adapter-failures.test.js test/experience.test.js
node --test test/im-task-retry.test.js test/im-task-channel.test.js
```

结果：第一组 88 项通过，第二组 15 项通过，共 103 项既有测试通过，无跳过。这些测试通过不表示下述体验缺口已修复。

另执行临时 Node/fake app-server 子进程探针，未写入仓库测试文件：

| 探针 | 实测结果 |
| --- | --- |
| retry 通知后成功，含先有部分文本或工具事件 | canonical 和 native 均等到答案及真实完成，只启动一个进程 |
| willRetry=false 或省略标记后仍有答案 | 继续同次执行并完成 |
| warning 后成功 | 不中断执行；该探针不证明所有真实降级告警形状均已验证 |
| 通知后最终 failed | 返回 failed，不误判成功 |
| 部分输出后进程退出、无终态；非零退出 | canonical 返回失败，native 抛出 CodexAppServerProcessError |
| 通知后取消 | canonical 为 run.cancelled；native 为合法 cancelled 控制结果 |
| 非重试诊断后无答案但 completed | canonical 仍返回 run.completed，确认空成功缺口 |
| unauthorized 诊断后无答案但 completed | Normalizer 接受 completed，确认此前诊断没有阻止空成功 |

临时脚本初版错误地要求 native 取消必须抛错，该断言失败；更正为核对 cancelled 控制结果后通过。该脚本没有构成“全部 22 个组合通过”的证据，也未计入上述 103 项数量。正式实施需将关键探针固化为可重跑回归。

## 线上证据与限制

本次只检查 `https://im-test.deepminer.com.cn/` 可达，首页状态为 200。未发送实际 IM 测试消息，未在 im-test 注入 Provider 断流或诊断后空回复，未进行真实客户端/CDP 验收，未部署运行时修复。线上发生频率与真实诊断形状仍未知。

参考 PR 的进程/SQLite 测试和本仓历史受控 503 验证均不能代替本专项线上验收。后续须按计划单独记录真实 Provider 自然故障、受控测试注入及客户端可见结果，不能将三者混写成已完成的真实线上故障恢复。
