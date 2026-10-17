---
type: Journal
title: 宿主函数装配的本地 SDK 交付
description: SDK 注入同步或异步业务函数，内部管理执行与生命周期；本轮仅验收本地自动化。
tags: [sdk, extra, context, lifecycle, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 范围与结果

按[宿主完整 SDK 接入计划](../../tasks/sdk-host-extra-contexts/brief.md)实施，起始基线 `f88b6b0`。用户要求先完成本地 SDK 接口与 daemon 单测，第三方 App 暂不动。因此本轮未修改或运行 Buddy、其他 App 或 channel-gateway-register-demo，未进行真实 IM/Provider 联调，也未更改既有 Runtime 身份、Home、profile 或配置。

公开 `runtime.loadExtra(module, jsonConfig, dependencies)` 已实现。宿主通过 dependencies 注入 loadContexts 等业务函数，无需创建内部 loader、连接执行端口或管理 Bot 对象。现有 `loadExtra(descriptor)` 与 CLI 的纯 JSON 路径保留。函数留在宿主 Node 进程，不序列化到 session JSON、descriptor 或 IPC；执行仍复用既有 daemon 和独立 AdapterHost。Run=7、Context=v3 与 Provider 执行合同不变，不增加 Runtime 安装决策。

# 设计目的与同步异步合同

两阶段 `extra(context, jsonConfig)(dependencies)` 将可持久化配置与宿主函数分开。返回的 initializer 每次 load 执行一次；loadContexts 由 Channel 在每个已接纳轮次开始准备时调用。宿主编辑 Agent 提示词或业务数据后，下一轮读取新值，无需为更新数据重建连接；更换 JSON 配置或函数引用时仍整体卸载并加载。

loadContexts 返回 `readonly ContextItem[] | Promise<readonly ContextItem[]>`。宿主可同步读内存或同步 SQLite，也可 await 异步 SQLite/HTTP；存储、连接、查询一致性及授权由宿主负责。async 包装不会使同步查询自动非阻塞。底层 IO 支持时由宿主传递 signal；超时只结束等待，实际操作结束前仍占在途额度，不把同进程函数描述成可强制终止的沙箱。设计理由已写入[整体架构](../../rules/architecture.md#宿主函数注入与逐轮业务数据读取)、[Extra 规则](../../rules/extras.md#sdk-与宿主生命周期)和[SDK 接入指南](../../../SDK_CHANNEL_GATEWAY_GUIDE.md#7-逐轮加载-agent-系统提示词与业务-context)，公开类型及核心代码注释附 Octospec 引用。

# SDK 内部责任

[本地装配容器](../../../packages/octo-runtime-daemon/src/runtime/local-extras.ts)管理 loader、日志与每实例执行端口。端口按 invocationId 记录真实 runId、账号代次和实例归属，保留 canonical/native 源帧与环境覆盖；取消和交互只作用于所属调用。回执在途取消通过一次身份校验查询取得原回执，不重放 invoke、不把 invocationId 当 runId。daemon 在接纳期间收到客户端断开时向准备操作传递取消。

SDK 合并两种装配位置的生命周期与自定义状态；名字及最多 64 个声明的容量共享。卸载、退出、切换账号、租户重配及 runner 意外退出都会中止旧本地实例；无须等待另一项阻塞初始化后才通知 abort。函数闭包不随进程恢复自动重放，宿主在新代次重新提交。清理失败如实报告，其他清理与 runner 停止继续尝试，并阻止绕过失败代次装配新实例。

# 验证

- [SDK 自动化](../../../test/sdk-host-extras.test.js)新增 13 项，覆盖函数同引用、同步/异步返回、配置快照、逐轮新值、Host PID 保持独立且不重建、环境覆盖、函数不落入 session JSON、状态合并、JSON/本地同名互斥及恢复、取消/交互归属、native 帧、卸载/退出/账号切换/租户重配、进程崩溃、初始化与清理失败、64 个共享声明边界。
- [执行流自动化](../../../test/embedded-invoke.test.js)新增 3 项：回执在途取消原身份、不误取消其他身份，以及真实 daemon 接纳期间 socket 断开向 submit 传递 abort。原 canonical/native 恢复测试仍通过。测试使用[独立假 Host](../../../test/fixtures/sdk-extra-host.js)和已有假 Provider，不调用真实模型。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过。Node 共 1078 项，1069 通过、9 项按既有环境条件跳过、0 失败；WebUI Vitest 35 项通过。
- Octospec 校验与 `git diff --check` 通过；不将此前共享 loader 的 GC 或 im-test 证据算成本轮 SDK 新验收。

# 后续范围

第三方 App/demo 的真实接入、线上 IM 收发、实际 Provider 会话矩阵、SDK 专项长期内存压力和宿主发布/重启尚未进行。这些项目按后续授权验收，不将本地接口完成度写成整个产品已验收。
