# Agent 来源与执行能力

Agent 定义由业务方管理。Runtime 注册只报告执行实现及实际可用状态，不创建业务 Agent，不读取 Worker Agent defaults／mandatory。

## 来源

| 值 | 语义 |
| --- | --- |
| `preset` | 调用 Provider 中已有的 Agent；调用方提供有效目标 |
| `provisioned` | 由基础执行方承载调用方提供的定义及本轮执行配置；不要求持久创建 Provider Agent |

来源与传输、部署位置、权限和工作区相互独立。Adapter 通过 `metadata.agentSources` 声明支持范围；执行计划冻结 `agent_source` 和需要的 `provider_agent_id`，映射到 `InvokeRequest.agentSource` 与 `agentConfig.providerAgentId`。不能根据 Provider 名称猜测来源。

OpenClaw 声明两种来源，但两者都要求显式目标；当前实现验证并调用已有 Agent，不创建受控 runner、不修改 Agent 配置。它声明 `metadata.workspace: false`，使用原生工作区。详见 [OpenClaw 合同](15-openclaw-external-agent-binding-design.md)。

## 能力与可用状态

[AdapterMetadata](../packages/octo-runtime-adapter-sdk/src/index.ts) 区分以下字段：

- `capabilities`：公开行为能力；当前内置 Adapter 使用 `react`。
- `agentSources`：支持的 Agent 来源。
- `executionFeatures`：会话、审批、图片等执行特性。
- `protocolSupport`：native／canonical 输出模式及原生协议标识。
- `mcp`、`workspace`：本地 MCP 配置支持和工作目录行为。

`react` 只描述使用已配置、获授权工具并继续处理结果的行为，不保证每次调用工具，也不证明某项工具存在。Provider 的 `available`、认证、目标 Agent、当前输入可执行性与执行完成分别判断。

Host 按实际执行合同校验来源、模式、审批及输入。非空 MCP 配置在未支持的 Adapter 上明确报错，不以 `react` 替代支持声明。SDK 的 `mcp` 是本地实现支持标识，不新增远程 Runtime 能力准入门槛。

模型上下文统一使用本轮 Context v3，由 Host 固定渲染；没有 Compiler/Pipeline 或来源专属的自动背景链路。Run 版本保持 7，Adapter transport 版本保持 2。

## 实现与验证入口

- [Adapter SDK](../packages/octo-runtime-adapter-sdk/src/index.ts)、[Adapter Host](../packages/octo-runtime-adapter-host/src/index.ts)。
- [Protocol Schema](../packages/octo-runtime-protocol/schema/protocol.schema.json)及[本地执行配置解析](../packages/octo-runtime-core/src/context.ts)。
- [context-mcp.test.js](../test/context-mcp.test.js)、[native-host.test.js](../test/native-host.test.js)。

真实 Provider 与线上测试环境的验收范围以对应验证记录为准，支持声明和 fixture 测试不等于真实调用成功。
