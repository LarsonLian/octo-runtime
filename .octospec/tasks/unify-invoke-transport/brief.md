---
type: Task
title: 统一 Host 与 RPC 输入及执行准备
description: 沿用 InvokeInput 和 signal 环境参数，RPC 只传输，执行配置只在 Host 解析。
tags: [protocol, invocation, ipc, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 用户决策

Unix socket / Pipe / stdio RPC 是通道，不是第二套执行协议。AdapterHost.invoke、AdapterHostRpcClient.invoke 和 daemon SDK invoke 必须使用相同的 `invoke(input, environment)`，沿用既有 InvokeInput 和 native/canonical 输出合同，不重新设计输入包装。

`signal` 保留在 environment。本地直接传给执行流程；RPC 客户端监听 signal，发送定位同一 invocation 的 cancel，服务端用 AbortController.signal 传给 Host。不把 signal 序列化成 JSON，不用重新 invoke 模拟取消。

# 实施边界

- 仅 Host 调用 prepareInvokeInput 解析默认值、选择 Adapter 并构造内部 InvokeRequest。Core 提供内部解析工具，不作为每层 transport 的预处理器。
- 删除旧 HostInvoke/createHostInvoke 三参数公开定义，以及失去消费者的 HostInvokeWireOptions 和模式序列化函数。createInputInvoke 只选择源流视图，不再解析执行配置。
- 内部 invokeFrames 统一接收同一 InvokeInput/environment；只暴露含回执身份和序号的完整源帧，公开 invoke 是同一源流的 native/canonical 视图，不形成独立执行路径。
- RPC params 传 input；必要的可信 executionEnvOverrides 走独立环境字段。客户端可补齐相关 ID 以取消和续流，不生成执行计划或补模型 Context。
- 接纳回执、身份核对、序号、终态、取消、消费者关闭及断流续订继续保留。回执由 Host 接纳后的首个源帧取得，Provider 在继续消费源流后启动；不再公开一次 prepare 再执行的两阶段调用。
- Channel Gateway 是业务接入层，允许构造自身默认值及业务 Context，但注入执行端口仍走统一输入。
- Work App 按本次新授权同步清理已删除场景合同的测试依赖，并验证真实 renderer 发起执行。

# 验收

1. 类型检查与全量跨包测试；本地/RPC 同输入及 Host 默认值一致，RPC 不发送已准备 request/options/adapterType。
2. signal 提前取消不启动 Provider，执行中取消到达 Provider；ACK 在途、连接关闭和消费者退出不泄漏执行。
3. CLI Playboard 经临时 daemon、UDS 和 stdio RPC 执行真实 Codex/OpenClaw；CLI 查询和取消入口仍有效。
4. Work App 构建并重启，CDP 连接真实 renderer，确认 im-test 登录与内置运行时，发起真实本地对话并核对终态。
5. Run=7、Context=v3、Adapter transport=2 保持不变；保留既有身份、Home、profile、配置和 Provider 状态。结果及未验证范围写入 journal。

## 可重复入口

```sh
pnpm typecheck
node --test test/invoke-parity.test.js test/host.test.js test/embedded-invoke.test.js test/playboard.test.js
node scripts/verify-playboard-live.mjs
node apps/cli/dist/index.js playboard --help
```

Work App 在其仓库执行以下命令。构建 Runtime 时会清理 dist，因此必须等 Runtime 构建完成，再构建 Work App；lint 也须在构建完成后执行。

```sh
pnpm build
pnpm exec vitest run
pnpm dev
# 在另一个终端运行；要求真实 renderer 已登录 im-test。
node scripts/verify-invoke-live.mjs
```

Playboard stdin 是原 InvokeInput JSON，只有 inputs / contexts 必填，执行选择使用 Context，取消来自 CLI 进程信号。Work App 脚本经 CDP 调真实 preload bridge，检查 im-test 登录、内置 Host 就绪，再创建个人测试对话并等待模型终态；只输出就绪状态和本轮结果，不输出凭据。它会保存一条真实测试对话。自动测试中的 fake Provider 不充当真实模型验收。

CLI 验收命令可由 shell/CI 重复调用；Work App 仍必须运行 Electron，CLI 脚本通过 CDP 驱动其 renderer，不能用纯 Node 替代桌面验收。
