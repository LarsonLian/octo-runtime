---
type: Rule
title: 本轮环境变量
description: envs 列表、合并、并发隔离和进程边界。
tags: ["envs","context"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-environment
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-protocol/**","packages/octo-runtime-adapter-*/**", "packages/octo-runtime-executor-core/**","test/*envs*"]
  touches: ["envs","context"]
source: self
supersedes: []
---

# Run 环境变量 Context

`octo.execution/envs` 是标准 Context 项，用于向本次 AgentRun 的本地 Provider 进程传入环境变量。Context 保持 `octo.context-envelope/v3`，Run 保持 `schema_version=7`，Adapter transport 保持 `protocolVersion=2`；不新增 Runtime 能力准入字段。

## 请求格式

在现有请求的 `context.items` 中加入：

```json
{
  "namespace": "octo.execution",
  "name": "envs",
  "payload": {
    "env_variables": [
      { "key": "API_BASE_URL", "value": "https://api.example.com" },
      { "key": "API_TOKEN", "value": "example-only" },
      { "key": "PROJECT_ID", "value": "project-123" }
    ]
  }
}
```

`payload.env_variables` 必须是 `{ key, value }` 条目列表。环境变量名放在条目的 `key` 值中，不作为协议 JSON 属性名。字典形状不再接受。业务方使用的 `ContextConfiguration.defaults`、`mandatory` 以及单次 Run 的请求 context 均使用同一格式；Worker 不再保存 Agent 配置。

- key 必须匹配 `[A-Za-z_][A-Za-z0-9_]*`；value 必须是字符串且不含 NUL。
- 同一列表内的 `key` 不得重复，即使值相同也拒绝。条目不得缺少 `key` 或 `value`，不得增加未知字段。
- 最多 128 个条目，并计入整个 Context 的 65,536 字节预算。
- `""` 表示将变量设置为空字符串；`null`、数字和布尔值均非法。
- 不展开 `${NAME}`，不执行 shell，不加载 `.env` 文件。
- `env_variables: []` 表示该层没有覆盖项，不删除低优先级变量。本次不定义删除变量的操作。

## 合并与冻结

业务发起方使用共享配置合同按 key 合并 defaults 与 request。请求中的同名 key 覆盖默认值，未提交的 key 保留。mandatory 逐 key 约束：请求显式提交不同值时返回 `CONTEXT_MANDATORY_CONFLICT`；未提交时补入强制值，不限制请求增加其他 key。本地 `resolveLocalContext` 提供 defaults 与 request 的解析；不要据此要求执行层读取业务 Agent 配置。

有效值以同一列表结构进入 `effective_context` 与 `resolved_execution_plan.envs`，参与 context hash。Runtime 在准备阶段检查两份数据是否一致，防止冻结后篡改。会话复用策略由调用方按执行配置决定；不再使用 Compiler 或 compiled hash。

## 运行时范围与优先级

协议和执行快照保留列表结构；适配器在启动进程时才将列表转换成系统 API 所需的环境字典。每次调用都创建独立的环境对象：继承宿主环境，覆盖本次 Run 的 envs，最后应用适配器为其传输设置的固定变量。不得修改宿主的全局 `process.env`。并发 Run 的覆盖值不共享。

| 执行路径 | 行为 |
| --- | --- |
| Codex | 注入 app-server 进程；读取原生有效配置，在 thread/start 和 thread/resume 中设置本次 shell 环境与本地 stdio MCP 变量白名单。配置读取失败则停止调用，不伪装为已应用。 |
| Claude Code、CodeBuddy、通用 ACP、ZCode、Antigravity、通用 CLI | 注入每次调用新建的 Provider 子进程。Provider 启动的 CLI/stdio MCP 依其原生继承规则获得变量。 |
| OpenClaw Gateway | 非空 envs 返回 `CONTEXT_ENVS_UNSUPPORTED`，因为当前 Gateway 没有本次调用的环境变量载体。空 envs 不影响调用。 |
| 远程 HTTP MCP、远程 executor MCP | 不把本机环境直接传给远端进程。HTTP MCP 可以通过 Provider 已配置的环境变量引用取得客户端认证信息；不会自动新增 header。 |

Codex 的 shell 覆盖保留已有环境策略，仅补入指定值和必要的 include 白名单。本地 MCP 保留原有配置，追加变量名白名单；MCP 自己显式配置的同名 `env` 仍按 Provider 原生优先级生效。因此 mandatory 约束的是 Run 注入值，并不改写用户的 MCP 专用配置。不会重新安装、同步或修改 MCP/插件文件。

环境变量中的值不会被编译成模型材料或控制指令。Host 调试日志会剔除 envs payload、执行计划 envs 和 Codex 原生 shell 注入值，不依赖变量名是否包含 token/secret。请求和执行快照仍保存这些值；此能力不是凭据保险库，也不承诺阻止工具主动输出环境变量。

## Channel Gateway 的工具环境

渠道为 octo-cli 提供的两个 OCTO 变量使用独立 `InvokeEnvironment.executionEnvOverrides`，不写入 Context envs。Core 将其复制到内部 InvokeRequest 的同名字段，Host RPC 使用 `invoke.with-environment` 传递；旧 Host 不认识该方法时明确拒绝，不回退普通 invoke。条目格式沿用 env payload，独立限制 128 项和 65,536 字节，已识别值必须校验。

Adapter SDK 合并顺序为继承环境、Context envs、独立覆盖、Adapter 固定传输设置。Codex 原生 shell 与本地 MCP 白名单使用合并后的本轮值。内部字段不由 `invocationInput` 转为公共 JSON，不进入 Context hash、模型输入或渠道业务快照；带覆盖的 RPC 请求只记录脱敏摘要。该字段不是远程授权机制。

OpenClaw 使用 CLI dotenv 预配置，保持每轮非空 envs 不支持的现状；共享文件按配置顺序后写覆盖前写，不承诺多 Bot 按轮隔离，详见 [渠道合同](channel-integration.md)。桌面应用的身份选择及 Context envs 用法保留。

F24 合同：前述顺序覆盖只允许启用、合法的 `adapter_type=openclaw` 配置参与，同一实例取最后一项。用户可以调整 items 顺序选择实例工具身份；其他 Adapter 配置不得覆盖，无候选时不借用其他 Provider 身份。CLI 同步循环已实施筛选，混合排序与无候选回归通过；文件写入与运行实例重启加载仍分别判断，见[实施记录](../tasks/gateway-august-feature-assessment/implementation.md)。

2026-10-16 F23 用户确认：OpenClaw Gateway 作为独立 Agent 实例，使用实例固定环境满足当前需求。由 CLI daemon 启动编排配置其实际读取的 `.env`，默认 `~/.openclaw/.env`；不修改上游 OpenClaw 设计或源码，不新增特殊 `session.create` 环境注入。Codex/Claude Code 等通用执行路径按其原生能力逐轮传递。不将两者生命周期差异作为覆盖度缺口；文件落盘与运行实例加载仍分别判断，既有人工重启约定不变。

## 验证入口

- `node --test test/context-protocol.test.js test/context-configuration-protocol.test.js test/context-envs.test.js`：Schema/TypeScript 校验、跨语言共享样例、合并约束、计划一致性、并发 CLI 子进程、模型输入隔离和日志脱敏。
- Worker `go test ./internal/domain ./internal/service`：使用相同 fixtures 验证 Go 合同和已有执行服务。
- `OCTO_RUN_CODEX_ENVS_LIVE=1 node --test test/codex-envs-live.test.js`：启动本机真实 Codex app-server 与临时 stdio MCP，验证值传递；不发起模型 turn，不使用真实凭据，不修改用户配置。

Codex 原生环境配置字段依据：[Configuration Reference](https://developers.openai.com/codex/config-reference/)。具体的服务联调结果与尚未验证的范围应记录在当次验证记录中。
