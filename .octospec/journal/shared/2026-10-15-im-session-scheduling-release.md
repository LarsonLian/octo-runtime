---
type: Journal
title: IM 调度条目回收与每日一万会话验证
description: 记录 Alpha review F2 的修复、双渠道累计负载和隔离线上测试环境验证范围。
tags: [channel, session, testing, review]
timestamp: 2026-10-15T00:00:00Z
---

# 修复结果

对应 [任务](../../tasks/im-session-scheduling-release/brief.md) 与 [Alpha review F2](2026-10-15-alpha-code-review.md)。Octo、WeCom 删除累计 128 个会话的门槛；`#sessions` 只持有排队及在途编排。最终投递完成后队列计数归零且无活动 invocation 时删除，控制命令、准备失败、Provider 失败及拒绝入队同样回收闲置对象。

卡片 controls 在独立作用域创建，不再引用旧调度对象或整个 projector。cancel 核对当前 invocation，retry 通过当前业务 key 重新取得队列；旧失败卡片不能另起独立旧队列、绕过新执行或取消新的 invocation。Session binding 和最近 Run/Event 元数据由 Channel 既有业务 store 管理，使回收后 `/session` 和普通续聊仍能恢复业务标识；未把业务存储迁到 AdapterHost。

## 自动化验证

- 两种渠道各自模拟一天内 10,000 个不同聊天，每条间隔推进模拟时间 8.64 秒，共覆盖 24 小时；每轮执行一次且最终 `status.sessions` 为零，无累计容量错误。模拟不实际等待一天，不代表一万个并发真实模型执行。
- 预热 1,000 次后和第 10,000 次后强制 GC，后者 `heapUsed` 相对预热值：Octo `-1,073,136` 字节，WeCom `+8,128` 字节；均通过 8 MiB 增长门槛。这是当前测试输入下的堆证据，不是全部 Adapter 的 RSS 保证。
- 覆盖 idle 后续聊和 `/session`、控制命令即时回收、reset 代次、旧卡片在新活动执行期间重试、旧卡片不能取消新执行、200 次准备失败与 200 次 Provider 断开、64 条队列已满时拒绝的新聊天不占槽、关闭时活动和排队条目释放。两平台共 12 个新增测试通过。
- 真实二进制 WS fixture 的 Octo 交互/取消/卡片测试和 WeCom stream 回归通过。测试只调整状态查询预期为在途列表，没有删除续聊、reset 或授权断言。

内存测试曾因 `t.mock.method(Date, "now")` 记录全部 mock 调用历史而出现约 170 MiB 增长；改用只推进时钟的 mock timers，并清空 fixture 自身请求/卡片历史后重新通过。没有放宽 8 MiB 门槛来掩盖该问题。

## im-test 验证

使用本机受保护的已有测试 Bot 配置，运行忽略入库的 `.run/im-session-scheduling-live.mjs`：

- 实际连接 `https://im-test.deepminer.com.cn/`，通过真实 Bot 身份校验、注册及 WS 建联。
- 启动新的真实 AdapterHost 子进程并加载 fake test Adapter；通过已连接的 Channel 回调输入 150 个不同的归一化测试会话，全部收到本地 final，最终调度条目为零，诊断为空。
- 150 个输入为进程内注入，不是实际 IM 用户发来的 WS 消息。回复回调仅作本地计数，未对外发送消息；未调用真实模型，不将此结果冒充真实聊天端到端验收。
- 测试 Host 与临时 Home 均已关闭和清理，没有重建已有 Runtime 身份、Home 或配置。WeCom 未进行真实平台联调。

## 检查与边界

workspace build、`pnpm lint`、`pnpm lint:names`、构建后的 `pnpm exec tsc -p tsconfig.json --noEmit` 均通过。首次针对性回归 24 项通过；补充关闭与 GC 验收后，新测试 12 项通过。最终 `pnpm test`（含全量构建）766 项，759 通过、7 跳过、0 失败。`git diff --check` 与 OKF 格式/链接检查通过；OKF 检查覆盖 53 个知识单元、19 条规则和 479 个本地链接。

提交前将 F2 的暂存内容独立导出到临时目录，离线安装依赖后重新完整构建，并运行 `node --expose-gc --test test/im-session-scheduling.test.js test/im-runtime.test.js test/im-wecom.test.js`，26 项全部通过。此检查不包含其他在途的渠道工具环境和 Extra 边界改动，确认 F2 提交可独立构建及通过针对性回归。

默认业务 store 的 1024 binding / 4 MiB / 24 小时与消息去重窗口保持现有合同；一万个不同聊天可逐个接待，不承诺把全部一万个 binding 永久保留。需要长期稳定 binding 的业务方仍通过注入 store 管理，本次不新增持久化或另一份缓存。HostRunService 的源流窗口及其容量、全体 Adapter 的失联清理属于独立目标，未因 F2 修复而完成。
