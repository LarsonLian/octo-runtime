---
type: Journal
title: Extra 停止信号与资源清理修复验证
description: 当前分支修复 IM 清理失败被吞、建联取消断链和 SDK 加载阻塞卸载，并记录自动化及实机边界。
tags: [extra, lifecycle, sdk, testing]
timestamp: 2026-10-15T09:00:00Z
---

# 范围与原因

按[任务方案](../../tasks/extra-responsibility-boundary/brief.md)在当前 main 分支直接修改，未新建分支、提交或推送。沿用 signal、onDispose 和 close；不增加配置更新钩子、逐 Bot SDK 方法或通用业务 RPC。本轮修改 Runtime SDK、两个 IM 插件及文档，App 使用已有统一 Extra 接入并重新构建、重启验证；SSE 保持既有清理实现并回归。Run=7、Context=v3、Worker 与已有身份/Home 保持。

修复前已复现两类错误：替换单 Bot close 为抛错后 manager 仍使卸载返回 disposed；让建联等待停止信号后，Extra 卸载未取消该建联。SDK 的全局生命周期队列还会让卸载等待正在进行的 load RPC。

# 实施结果

- Extra signal 经 manager 传入每个 IM runtime，用于建联、上下文准备、执行和投递。manager 自身 close 先取消、禁止新操作，再等待更新队列；新 runtime 在旧连接关闭后才创建，避免失败替换泄漏 session store。
- runtime、manager、transport 和 WebSocket 重复 close 等待同一次清理。实际 WebSocket 关闭才结束等待；Octo 等待卡片轮询及 typing 在途发送，WeCom 等待回复队列。一个资源失败仍继续其他资源，最终汇总，不再丢弃 allSettled 的失败结果。
- SDK 对当前加载可提前发出停止请求，先观察 daemon 已接纳该加载，避免两个 IPC 连接的卸载请求抢先到达。最终声明与账号变化继续串行完成；被取消的加载不写入最新启用声明，返回 EXTRA_LOAD_CANCELLED。旧账号排队卸载返回 EXTRA_ACCOUNT_CHANGED，不操作新账号进程。
- SDK stop 收到插件清理失败仍回收 runner、释放锁并标记停止，随后向宿主返回 EXTRA_DISPOSE_FAILED。清理失败和进程已退出分别报告。业务配置错误仍由插件跳过受影响项并通过 status 报告。

# 自动检查

新增 [IM disposal 回归](../../../test/im-extra-disposal.test.js)和 [SDK disposal 回归](../../../test/extra-sdk-disposal.test.js)，共 16 项，覆盖加载取消、活跃 invocation、重复清理、失败传播、真实本地 WebSocket 握手、账号切换、恢复和 typing 发送退出。模拟传输和故障注入仅证明这些控制行为，不作为线上连接成功证据。

- Runtime：pnpm typecheck（含构建）、pnpm lint 通过；全量 Node 测试 775 项通过、7 项跳过。最后两处错误 cause/类型修正后再次编译 SDK、运行根类型检查与 lint 通过。
- App：pnpm typecheck、pnpm build 通过；195 个测试文件通过、1 个跳过，1620 项通过、1 项跳过。
- 本次修改范围的 git diff --check 通过；OKF 格式与本地链接检查通过。收尾时全仓检查发现并行协议修改中的 browser.ts/index.ts 末尾空行，不属于此次 dispose 修改，未覆盖。

中间类型检查发现当前 TS lib 不提供 Promise.withResolvers，已改为普通 Promise；lint 发现未显式等待的异步 close、错误 cause 与 unknown 类型问题，已修正。SDK 回归曾误读不存在的 health.daemonPid，改为 health.local.pid 后通过。以上中间失败不计为通过证据。

# 重启与 im-test 实机

停止旧 Electron 与 electron-vite 后重新启动开发 App，CDP 9222 可用。本次真实 renderer 连接 https://im-test.deepminer.com.cn，重启后 daemon PID 为 8177。

- 执行 App 的 verify-extra-plugins-live.mjs：用临时无效 Bot 凭据触发真实服务鉴权失败，确认界面可见；未注册引擎不拦截插件加载；编辑、停用、删除和跨插件状态隔离通过；共享 Host 不重启，renderer 异常数为 0。测试临时通道已删除，原通道 ID 列表保持。
- 执行 Runtime 的 verify-extra-sse-live.mjs：复用真实桌面 daemon，经 SSE 调用真实 Codex，Run 400fa351-c023-4b8b-89b3-06853c7dc3a8 返回 run.completed。Bearer 拒绝检查、卸载后端口 3002 关闭、共享 Host 继续 ready 均通过。
- 本轮未使用有效 Bot 完成真实 IM 消息往返或审批；WeCom 在线鉴权与第三方网络异常下的清理也未实机验证。相关取消与错误清理证据来自本地自动化，不能表述为真实 IM 全链路验收完成。

构建、测试及实机日志保存在本机 /tmp/octo-dispose-* 与 /tmp/octo-extra-dispose-*，不包含凭据。开发 App 保持运行。
