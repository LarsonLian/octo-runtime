---
type: Task
title: 单一发行包的第三方插件开发合同
description: 无 Runtime 源码时开发完整 Extra，并规划第三方 Adapter 的公开入口与 CLI 装配。
tags: [extra, adapter, typescript, installation]
timestamp: 2026-10-15T00:00:00Z
---

# 单一发行包的第三方插件开发合同

## 目标与边界

客户只有发布的 `@mininglamp-oss/octo-runtime`，没有源码、workspace 或私有包安装权限，也应能在独立 TypeScript 工程开发完整 Extra：接收业务请求、构造 Agent Run、调用注入的执行端口、消费 native/canonical 流、回应交互、取消执行、管理状态及卸载清理。官方 Extra 仅为内置实现，不是第三方准入名单。

继续只发布一个 npm 包。内部 `packages/*` 保持 private；公开子入口负责运行时工具和类型转发，不能要求客户导入内部包名、绝对私有文件或源码路径。类型声明的所有传递依赖必须随发行物携带并可解析，不能靠开发机 workspace 偶然通过。TypeScript 和 Node 类型属于客户工程开发依赖。

## Extra 实施范围

- `/extra` 导出 Extra 生命周期、配置声明、执行端口和全部协议类型，同时转发常用运行时校验、常量和事件工具。
- `/protocol` 导出全部已有协议类型，包括 InvokeInput、InvokeEnvironment、InputInvoke、ModelInputPart、ContextEnvelope/Item 及各 payload、AgentConfig、ProviderSession、RuntimeLimits、MCP、CanonicalEvent 及 payload、HostFrame/Receipt/Control、InteractionResponse、ApprovalRequest、FailureEnvelope 等。类型保留原有泛型、判别联合和模式重载。
- `ExtraAdapterHost` 是独立接口，不引用内部 HostRunService 类。`invoke`、`cancel`、`respondInteraction` 的实例由 `ctx.adapterHost` 注入；import 类型不会创建执行内核。公开入口不提供另建共享内核的工厂。
- 类型只负责静态检查；外来 JSON 使用 InvokeInput.check 等运行时校验。插件业务 payload 与结果由插件定义并校验，统一执行合同不按业务扩展。
- 保持 Run=7、Context=v3；本次只开放已有合同，不修改 wire 字段和执行语义。

## Adapter 后续目标

第三方开发的[飞书接入指南](https://my.feishu.cn/docx/IW30d2KL6o137ExHKHRc2yrJngh)已补充当前可运行的 Extra 与结构式 Adapter 示例。现有通用 loader 可以通过显式 manifest 加载第三方对象，这不等于 `/adapter` 公开开发入口或自动追加清单已经实现。普通 --help 不展示该高级参数，仅说明内置集合默认无需配置；解析与执行支持保留。

2026-10-15 用户进一步要求：客户仅有可执行 Runtime，也能创建独立 Adapter 项目对接 Dify 等 Provider，编译为 JS 后交给 CLI 加载。Adapter 负责 Provider 输入、输出、会话、错误及取消的协议转换；Extra 负责业务触发与投递，两者不可混淆。

Adapter 的公开入口计划为 `@mininglamp-oss/octo-runtime/adapter`，至少覆盖 Adapter、AdapterMetadata、AdapterOutput、AdapterInvocationContext、AdapterProbeOptions、ProbeResult、DriverFrame、CommandSpec、JsonCliAdapterOptions、defineAdapter，以及适用的环境变量、MCP、输入与流转换工具，并能通过 `/protocol` 获取完整执行协议类型。无需发布独立私有 SDK 包。该入口和加载改造尚未实施，不能作为当前 import 用法。

CLI 的专属 `apps/cli/src/default_adapters.json` 默认集合将与 Runtime Home 下 `extra_adapters.json` 合并。格式、同名规则、路径、失败行为与验收见 [Adapter 装配任务](../adapter-composition-ownership/brief.md)。SDK 嵌入产品在自己的 Host 入口直接 import 并注册，不读取 CLI 默认或用户文件。默认来源拆分已另行实施，追加加载不在本任务内实现。

## 验收

1. 从发行 tgz 在仓库外、空 npm 缓存、offline 条件下安装。客户工程只依赖公开发行包和 TS/Node 开发工具，不安装任何私有包。
2. `skipLibCheck=false` 编译第三方插件；验证两种 invoke 模式推导、交互、取消、配置、状态、MCP、会话和错误等类型可引用，非法交互与错用事件类型产生预期 TS 错误。
3. 发行包公开运行时入口可 import，第三方编译 JS 可由 extraset 声明并被 daemon 真正加载；根入口、任意内部深层路径及私有包名继续拒绝外部解析。
4. 完整跨包测试、lint、类型检查通过。真实执行与自动化结果分别记录，不以 HTTP 可达或 loaded 代替执行完成。
5. Adapter 后续用独立 Dify 工程验证开发、编译、外部追加、probe、实际调用、事件转换、取消和错误；没有 Dify 实测不能标为已支持。

实施及实际验证结果见 [验证记录](../../journal/shared/2026-10-15-public-plugin-contracts.md)。
