---
type: Task
title: 面向宿主的完整 SDK 接入与动态 Context
description: 以 Buddy 和 CLI 宿主的接入流程为目标，通过统一 SDK 加载 Extra、传入业务函数并完成状态和退出管理。
tags: [sdk, extra, context, lifecycle, architecture]
timestamp: 2026-10-17T00:00:00Z
---

# 面向宿主的完整 SDK 接入与动态 Context

状态：本地 SDK 接口与 daemon 自动化已实施。起始基线 f88b6b0，当前实现见工作区；[交付记录](../../journal/shared/2026-10-17-sdk-host-extra-contexts.md)列出证据。用户本轮限定先开发 SDK 和单测，第三方 App、register-demo 及线上 IM 联调暂不接入。

## 主要目标

**宿主通过统一 SDK 完成启动、加载插件、动态读取 Context、查询状态、重载及退出。接入动态 Context 时，只需在加载 Extra 时多提供一个 loadContexts 函数。**

宿主不创建 ExtraPlugins，不组装模型执行端口，不调用 Gateway 内部 manager，不管理 Bot 连接、队列或会话。SDK 内部接线由 Runtime 团队完成；Codex 和独立 AdapterHost 的执行逻辑沿用现状。

本专项承接[此前两阶段 Extra 交付](../../journal/shared/2026-10-17-extra-initializer-delivery.md)中延期的 SDK 接线。三参数 loadExtra 已提供，原有 JSON descriptor 入口继续有效。公开接口注释说明动态 Context 用途、配置/函数边界及清理责任，并引用本计划。

## 不同宿主如何接入

| 宿主 | 配置和函数来源 | 对外接入方式 |
| --- | --- | --- |
| Buddy / Desktop HostApp | 主进程从自己的存储取得 JSON，提供读取当前业务数据的函数 | 通过 SDK 启动 Runtime，再 loadExtra(module, config, dependencies) |
| 自研 Node CLI 宿主 | 自己读取文件或其他业务来源，可提供函数 | 使用同一 SDK 和同一生命周期，无需另造 CLI 专用 API |
| Runtime 自带 CLI，即 octo-runtime 可执行程序 | 按现有 CLI 约定读取 JSON | 保持现有 JSON 加载及静态 Context；不要求用户把函数写入 JSON |

这里的 CLI 不指业务 API 工具 octo-cli。自带 CLI 的静态方式与 SDK 的函数方式使用同一个 Extra 合同；本次不为自带 CLI 新增函数脚本配置，也不改变 CLI 对配置文件的管理。

## 宿主完整操作流程

| 步骤 | 宿主需要做什么 | SDK 对宿主保证什么 | 当前状态 |
| --- | --- | --- | --- |
| H01 准备与启动 | 沿现有指南准备 Node、已安装认证的 Provider 和独立 Host 入口；createDaemonRuntime 后 startAccount | 复用宿主 Home 和原有执行链，返回真实就绪结果 | 已有；不为动态函数重新设计 |
| H02 准备配置与函数 | 构造纯 JSON config；可选实现 loadContexts(botConfig, { signal }) | 不规定宿主用文件、内存还是数据库；不要求创建插件内部对象 | 函数合同与插件消费已有 |
| H03 加载 Extra | 调 runtime.loadExtra(module, config, { loadContexts })；无需动态读取时传空依赖 | SDK 在主进程装配函数，注入原执行能力，保证同名插件唯一 | 已实施，SDK 自动化通过 |
| H04 更新业务数据 | 保存函数读取的新值 | 下一任务读取最新值，不重载 Gateway，不重建连接；本轮快照不被追写 | SDK 两轮取值与独立 Host 复用已验；真实 IM 待验 |
| H05 看状态与改配置 | 用 extraStatus/health；JSON 或函数引用改变时 await unload，再 load 完整新值 | 同一公开入口覆盖静态和函数装配；重载只影响该 Extra，清理失败如实返回 | 已实施，状态轮询、互斥、重载自动化通过 |
| H06 退出或切账号 | await runtime.stop(reason)；新账号启动后重新提交其配置和函数 | SDK 清理 Extra 内部资源及所属调用，再按原合同停止所拥有的进程 | 已实施，初始化取消、退出、切账号/租户及 runner 故障自动化通过 |

H01 详细安装、workspace、构建和独立 Host 入口沿用 [SDK 接入指南第 1–6 节](../../../SDK_CHANNEL_GATEWAY_GUIDE.md)，不复制新的安装体系。H03/H05/H06 是本次 SDK 实施范围；本地测试不代替第三方产品或真实 IM 验收。

## SDK 用法

以下代码使用已提供的入口；runtime 的创建和 startAccount 沿用现有示例：

```ts
await runtime.startAccount(account);

await runtime.loadExtra(gatewayModule, jsonConfig, {
  loadContexts: persona.loadContexts
});

// 修改宿主自己的数据；同一个回调下一轮读取新值。
persona.replace("新的业务提示词");

const status = await runtime.extraStatus("channel-gateway");

// 只有 JSON 配置或函数引用变化，才卸载后重新加载整个 Extra。
await runtime.unloadExtra("channel-gateway");
await runtime.loadExtra(gatewayModule, nextJsonConfig, {
  loadContexts: persona.loadContexts
});

await runtime.stop("quit");
```

persona 是 demo 自己的业务存储，SDK 不规定宿主必须实现该对象。仅实现单参数 loadContexts(config) 的函数也可忽略第二参数；有 IO 时使用 signal。返回 ContextItem 数组或 Promise，不返回 envelope，也不把函数写入 JSON。

## 动态更新的边界

函数引用在加载时提供一次，每个已接纳任务真正开始准备时重新调用。队列等待时不提前读，控制命令和 Provider 内部重试不额外读；本轮执行使用冻结快照。更新函数所读取的数据不要求 unload/load，替换函数引用或连接 JSON 才整体重载。

普通业务 Context 按本轮提供的内容传递。系统指令是否在既有 Provider 会话内生效，继续遵循原会话合同；需要时由业务显式 reset 后进入新会话。本需求不修改 Codex、不隐式 reset，也不改变 Run=7 / Context=v3。静态动态覆盖及异常处理沿用[现行专题](../../guides/channel-dynamic-contexts.md)。

## 范围和交付顺序

1. 接通通用 runtime.loadExtra(module, config, dependencies)，SDK 内复用已有 loader 和执行传输。
2. 将该路径接入现有状态、卸载、退出和账号切换；取消、交互和唯一实例校验由 SDK 内部完成。
3. 当前以仓内 SDK fixture 验证 H01–H06、动态取值、独立 Host 和控制往返，使用 fake Provider，不调用真实模型。
4. 后续接入外部 [register-demo](../../../../octo-runtime-channel-gateway-register-demo/src/main/octo-runtime-daemon.ts)，再在 im-test 验证真实 IM；按本轮用户要求，这两项暂不执行。

本次不要求新增 npm 包、公开 SDK 子路径或新的分发平台；既有 submodule/workspace 接入方式有效。也不新增插件管理平台、逐 Bot 热更或宿主执行桥。内部需要检查的身份、状态与清理问题放在[SDK 实现附录](flows.md)，不转化为宿主操作步骤。

## 完成标准与评分

必要性 100/100，可执行性 100/100。**本轮限定的本地 SDK 接口及 daemon 单测已完成；第三方宿主与真实 IM 验收不标为已通过。** 上版内部加权 40/100 不作为整体完成度，逐步骤状态见[评估表](assessment.md)。完整产品接入目标 100% 仍须通过后续[必要验收](acceptance.md)，不要求接入方补写任何内部装配。
