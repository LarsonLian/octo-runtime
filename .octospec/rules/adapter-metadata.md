---
type: Rule
title: Adapter 执行元数据与可用状态
description: 宿主管理 Adapter 支持范围，Adapter 按执行合同适配转发，不维护自建能力声明。
tags: ["adapter","agent-source"]
timestamp: 2026-10-16T00:00:00Z
implementation_baseline: df63c8f
id: runtime-adapter-metadata
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-adapter-*/**","packages/octo-runtime-executor-core/**","config/**"]
  touches: ["adapter","agent-source"]
source: self
supersedes: []
---

# Adapter 执行元数据与可用状态

Agent 定义由业务方管理。Adapter 元数据与 probe 分别描述执行实现及实际可用状态；本地 SDK 不创建业务 Agent，也不读取 Worker Agent defaults／mandatory。当前仓库没有 Worker 接入注册工厂。

## 宿主掌握支持范围，Adapter 适配转发

2026-10-16 用户明确：CLI、desktop 及其他 SDK 宿主选择并交付具体 Adapter 和版本，功能支持范围由宿主管理。Adapter 将宿主的显式请求转换为 Provider 原生操作并返回真实结果；Runtime 不再额外维护一套功能标签供宿主发现、匹配或准入。

- `executionFeatures` 自建字符串标签机制已删除，包括字段、常量、发现投影和标签驱动的判断；不得恢复标签，也不得换成另一份布尔字段表、能力 struct 或注册中心延续同一机制。
- “透传”表示不改变业务意图和参数语义。必要的协议编码、参数映射、事件转换、交互响应和取消仍由 Adapter 实现；宿主不需要为此理解 Provider 私有传输细节。
- 宿主决定使用哪些功能和如何展示选项。不支持的请求由对应 Adapter 按具体执行合同明确拒绝或返回已约定的未应用结果；不得静默丢参、扩大权限、改选 Adapter 或伪造成功。
- Provider 是否已安装、登录或可连接属于实际运行状态。仅在必要的准备或调用边界检查并如实报告，不为维护功能标签额外启动 Provider、扫描 Home 或探测工具；安装决策仍归 HostApp。
- Provider 原生握手中确实用于通信的字段在 Adapter 内按原协议处理，不复制为 Runtime 统一能力目录。原生字段名包含 capabilities，不构成保留自建声明机制的理由。

SDK、全部内置 Adapter、Host 加载与发现已删除标签字段，不再导出标签常量或审批标签转换函数。Codex 的 computer-use 标签专用探测也已删除，见[F4 实现记录](../journal/shared/2026-10-16-remove-computer-use-probe.md)。决定依据见[记录](../journal/shared/2026-10-16-adapter-forwarding-ownership.md)，本地构建和真实 Provider 验收分别记录，不代表远端 Worker 已发布。

## 来源

| 值 | 语义 |
| --- | --- |
| `preset` | 调用 Provider 中已有的 Agent；调用方提供有效目标 |
| `provisioned` | 由基础执行方承载调用方提供的定义及本轮执行配置；不要求持久创建 Provider Agent |

来源与传输、部署位置、权限和工作区相互独立。Adapter 通过 `metadata.agentSources` 声明支持范围；执行计划冻结 `agent_source` 和需要的 `provider_agent_id`，映射到 `InvokeRequest.agentSource` 与 `agentConfig.providerAgentId`。不能根据 Provider 名称猜测来源。

OpenClaw 声明两种来源，Adapter 边界都要求有效目标；公共 `InvokeInput` 的准备层在省略目标时补 `main`，不能将此默认值理解为创建 Agent。当前实现验证并调用已有 Agent，不创建受控 runner、不修改 Agent 配置。它声明 `metadata.workspace: false`，使用原生工作区。详见 [OpenClaw 合同](openclaw.md)。

## 执行支持与可用状态

当前源码的 [AdapterMetadata](../../packages/octo-runtime-adapter-sdk/src/index.ts) 包含以下字段：

- `agentSources`：支持的 Agent 来源。
- `protocolSupport`：native／canonical 输出模式及原生协议标识。
- `mcp`、`workspace`：本地 MCP 配置支持和工作目录行为。

自有 `metadata.capabilities` 已删除。`react` 没有可检查的本地执行定义，不作为默认值、发现结果、注册要求或准入条件。业务标签及其匹配由业务方管理，不在 SDK、Host、daemon 或 Adapter 内建立能力目录、AbilityProvider、Binding 或业务执行目标注册中心。

Provider 的 `available`、认证、目标 Agent、当前输入可执行性与执行完成分别判断。可用性以实际 probe 为准，不证明当前输入可执行或执行成功。

产品选择的加载集合也独立于以上状态。CLI 与 SDK 嵌入代码分别决定集合；Host 不因框架支持更多类型或机器上探测到更多 Provider 就自行加载。默认来源拆分已实施，SDK 不读取 CLI 清单，见 [方案及影响](../tasks/adapter-composition-ownership/brief.md)。

2026-10-15 最新决定：CLI 默认集合固定为 `apps/cli/src/default_adapters.json`，SDK 在自己的独立 Host 入口直接 import 并注册，不读取或复制 CLI 清单。后续将追加 `<home>/extra_adapters.json`（默认 `~/.octo-runtime/extra_adapters.json`）中的第三方 Adapter，采用既有 version/adapters 描述格式。按 type 保留先出现项，内置优先；同名外部项忽略且不执行其模块。SDK 不自动读取此文件。客户只持有发行包，也应能通过公开 `/adapter` 与 `/protocol` 合同开发独立 Dify 等 Adapter；内部包继续 private。公开 Adapter 入口与外部追加加载均待实施，详细路径、错误与验收规则见上述任务及[公开插件合同](../tasks/public-plugin-contracts/brief.md)。

Host 按执行合同校验来源、输出模式和实际交互 responder；审批参数映射、图片编码及不支持的输入由具体 Adapter 处理。watchdog 在本次调用实际收到合法原生进度后采用原生进度，此前使用有效 canonical 工作事件；不依赖静态标签。非空 MCP 配置在未支持的 Adapter 上明确报错。SDK 的 `mcp` 是当前本地实现字段，不新增远程 Runtime 能力准入门槛；其他元数据字段是否简化不在本次决定中实施。

## 协议删除边界

- 执行计划不再定义 `required_capabilities`、`required_execution_features` 或 `provider_compatibility`；schema、生成类型和运行时字段白名单同步删除。提交这些字段按未知执行计划字段拒绝，不进行改名转换。
- 删除整个 `ExecutionTarget` 类型及校验器，不保留 `standard_harness_agent` / `ability_provider` 分支、`executor_id`、`provider_binding_ref`。通过既有 adapter 选择执行实现，Provider Agent 目标仍使用 `providerAgentId`。
- SDK、AdapterHost 加载、发现和桌面映射不再输出或要求自有 capabilities 或 executionFeatures 字段；旧额外标签不参与执行判断，也不作为新合同的一部分。
- ACP 的 `agentCapabilities` / `clientCapabilities`、MCP 握手和 Codex app-server 初始化中的 capabilities 属于 Provider 原生协议，按原协议处理。
- Run=7、Context=v3、Adapter transport=2 不变。此次删除不触发 Home、Runtime 身份、profile、认证配置或 Provider 状态重建。

模型上下文统一使用本轮 Context v3，由 Host 固定渲染；没有 Compiler/Pipeline 或来源专属的自动背景链路。Run 版本保持 7，Adapter transport 版本保持 2。

## 实现与验证入口

### Manifest 模块路径

manifest.module 的本机绝对路径（Windows 包含盘符与 UNC）和以点开头的相对路径，由 Host loader 转换为 file URL；相对路径以 manifest 所在目录为基准，不能以宿主 cwd 为基准。包 specifier 与已有 file URL 保留原解析语义。平台差异封装在内部，不要求 SDK 调用方预转换 URL、选择 OS 或改变现有启动接口。

### CLI 帮助与开发者高级入口

普通 CLI `--help` 说明默认使用内置 Adapter、无需 Adapter 配置，不展示高级 `--manifest` 参数。隐藏只影响帮助渲染，不能删除参数解析、优先级或显式清单执行支持。现有显式 manifest 是完整加载集合，不是自动追加；第三方结构式模块可由其加载，但 `/adapter` 公开 SDK 和 extra_adapters.json 自动追加仍须分别实施验收。

开发者用法、公开 import、完整 Extra/Adapter 示例及 SDK/CLI 兼容边界见[飞书开发指南](https://my.feishu.cn/docx/IW30d2KL6o137ExHKHRc2yrJngh)。公开合同属于增量导出，不能据此声称使用旧物理清单路径的宿主无需迁移。

- [Adapter SDK](../../packages/octo-runtime-adapter-sdk/src/index.ts)、[Adapter Host](../../packages/octo-runtime-adapter-host/src/index.ts)。
- [Protocol Schema](../../packages/octo-runtime-protocol/schema/protocol.schema.json)及[本地执行配置解析](../../packages/octo-runtime-executor-core/src/context.ts)。
- [context-mcp.test.js](../../test/context-mcp.test.js)、[native-host.test.js](../../test/native-host.test.js)。

真实 Provider 与线上测试环境的验收范围以对应验证记录为准，支持声明和 fixture 测试不等于真实调用成功。
