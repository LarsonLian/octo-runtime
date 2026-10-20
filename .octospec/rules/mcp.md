---
type: Rule
title: 本轮 MCP 执行配置
description: 动态 MCP 连接、模板展开、冻结与 Adapter 映射。
tags: ["mcp","context"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-mcp
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-protocol/**","packages/octo-runtime-adapter-*/**", "packages/octo-runtime-executor-core/**","test/context-mcp*"]
  touches: ["mcp","context"]
source: self
supersedes: []
---

# 本轮 MCP 执行配置

本协议允许在 Context 中指定本轮 MCP 连接。HostApp 负责 Skills、知识库组件、CLI、插件和 MCP 程序的安装与更新；原生运行时负责连接 HTTP 服务或启动已安装的 stdio 程序。Runtime 不通过此配置下载或安装组件。

连接通过 `octo.execution/mcp` 提供。Runtime 不使用 FileBundle、资源下载、旧 `InvokeRequest.mcpServers` 或旧执行计划 `mcp_servers`。Run 保持 7，Context 保持 v3。

## Context 字段

```json
{
  "schema": "octo.context-envelope/v3",
  "items": [
    {
      "namespace": "octo.execution",
      "name": "mcp",
      "payload": {
        "mcpServers": {
          "business.eu-v2": {
            "type": "streamable_http",
            "url": "https://api.example.com/mcp",
            "headers": {
              "Authorization": "Bearer ${BUSINESS_TOKEN}",
              "X-Space-ID": "${SPACE_ID}",
              "X-Client": "octo-runtime"
            }
          }
        }
      }
    },
    {
      "namespace": "octo.execution",
      "name": "envs",
      "payload": {
        "env_variables": [{ "key": "SPACE_ID", "value": "example-space" }]
      }
    }
  ]
}
```

`BUSINESS_TOKEN` 可以来自运行 Runtime 的进程环境，也可以由调用方通过本轮 `envs` 设置。配置中的 URL 必须是原始字符串，不是 Markdown 链接。

`mcpServers` 是动态 key 的 map，不枚举 business、task 或其他业务名称。名称采用跨 adapter 的可移植字符集：`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，最多 32 个 server；空对象合法。每个 value 按 `type` 严格校验，未知字段、未知 transport、混合 transport 字段均拒绝。

Schema 结构参考 [Agent Plugins 官方 MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json)：

```json
{
  "type": "object",
  "additionalProperties": { "$ref": "#/definitions/McpServer" }
}
```

`McpServer` 用 `oneOf` 引用 stdio 和 Streamable HTTP 定义。`headers`、`env` 也采用动态 map，value 必须是字符串。Schema 的 `x-octo-unique-header-names` 语义约束要求 header 名称按大小写不敏感规则唯一。

本协议是 Octo 的执行配置合同。其 `streamable_http` 拼写和环境变量展开规则不声称与 Agent Plugins 的完整规范一致，也不是 MCP 线上报文协议。

## 配置位置与冻结

- 临时配置：本次 Run 的 `context.items`。
- 默认／强制配置：业务方持有的 `ContextConfiguration.defaults.items` 和 `mandatory.items`，在发起请求前按共享合同解析。
- Worker 接收有效 Context 和执行计划；不再持有 Agent 配置表或提供 Agent 配置管理。
- 本地 Core 的 `resolveLocalContext(defaults, submitted, agentSource)` 解析调用方提供的 defaults 与本轮请求；Runtime 不再注册本地业务 Agent 或提供 `replaceDefaultContext()`。

defaults 和请求按 server 名称合并；同名 server 整项替换，不深合并 headers、env 或 transport 字段。mandatory 也按 server 名称约束：mandatory 同名 server 完整覆盖请求值，不因值不同报错。空 map 不删除 defaults 或原生本地 MCP。

执行计划使用 `mcp: { mcpServers: ... }` 冻结未展开的模板，并与有效 Context 核对。环境值仅在执行主机准备 invocation 时读取，不回写 Context、执行计划或原生配置文件。框架不从上一轮补 MCP 配置；调用方根据本轮执行配置决定会话复用。MCP 配置和 envs 不渲染到模型上下文。

此扩展使用现有 Context 和执行计划字段，不要求 Runtime 新增数据库或业务配置存储。

## 环境与变量

本轮环境按“父进程继承值 → Run envs → adapter 内部覆盖值”组合，后者优先；每次 invocation 独立，不修改全局 `process.env`。stdio server 显式配置的 `env` 再覆盖传给该 MCP 子进程的同名变量。

准备环境后，Runtime 在 `command`、`args` 元素、`cwd`、`env` 值、`url` 和 `headers` 值中展开 `${NAME}`。server 名称、字段名称、header 名称和 env key 不展开。变量名采用 `[A-Za-z_][A-Za-z0-9_]*`。

- `$${NAME}` 解析为字面量 `${NAME}`。Claude Code 会在连接时再次展开占位符，无法可靠保留这类最终值；该 adapter 对最终值含 `${` 的配置报 `MCP_LITERAL_UNSUPPORTED`，避免改变字面量或凭据。Codex、Kimi、MCode 已实测保留字面量。
- 仅替换一遍，不递归展开替换结果，不解释 shell 表达式。
- 未设置变量报 `MCP_ENV_MISSING`，只显示配置位置和变量名，不显示变量值。
- 空值保留；空 command、非法 URL 或带换行的 header 在最终校验时拒绝。
- `envs` 的值继续保持字面量，不引入 envs 之间的依赖或递归插值。
- URL 模板在 Context 阶段校验结构，展开后必须为 HTTP(S) URL，且不能包含用户信息、fragment 或控制字符。

常驻 daemon 不会自动获得另一个终端后来执行的 export。模型启动后在 shell 子进程执行 export，也不会修改已启动的 Provider 和 MCP 连接。

配置属于执行权限输入，只接收调用方提供并通过现有权限边界的执行配置，不从普通材料、工具结果或模型文本提取。业务授权的签发、服务主体和资源范围校验继续独立执行。

## Adapter 映射

| Adapter | 原生入口 | 处理 |
| --- | --- | --- |
| Codex | app-server 的 thread/start、thread/resume `config.mcp_servers` | 仅传本轮新增 server 和本地 stdio 必要的 env_vars 覆盖；HTTP headers 通过本轮私有环境变量引用；不改用户文件 |
| Claude Code | `--mcp-config` 私有临时 JSON | 映射 `type: http`，保留本地 MCP 配置入口；结束时删除临时文件 |
| Kimi / MCode 等 ACP adapter | session/new、session/load `mcpServers` | 转成数组，HTTP 类型为 `http`，headers/env 转为 name/value 数组；先检查原生 HTTP 能力声明 |
| OpenCode | `OPENCODE_CONFIG_CONTENT.mcp` | stdio 转 local，HTTP 转 remote，保留本地原生配置加载 |
| 未实现 MCP 的 adapter | 无 | 非空本轮 MCP 配置明确报 `MCP_UNSUPPORTED`，不静默忽略 |

Runtime 对本轮 server 的转换不改变审批策略。连接成功不授予业务权限，也不自动批准工具调用。

Codex 自行加载原生既有 MCP 配置，Runtime 不把 `config/read` 的完整 read model 回传为执行覆盖。本轮 server 与任一原生配置同名时，在 thread/start、thread/resume 和输入之前返回 `MCP_SERVER_NAME_CONFLICT`；同类型、跨传输及 disabled 条目均不能覆盖。HostApp 必须选择唯一名称，Runtime 不静默改名或深合并。`config/read` 仅用于检查原生名称冲突、合并必要的 stdio env_vars 及 shell 环境策略；HTTP、disabled 和 remote stdio 条目不增加环境白名单。CC / OpenCode 的配置优先级仍受原生加载器控制，需要确定隔离的配置应使用不与本地配置冲突的 server 名称。

共同可移植字段为 stdio 的 `type/command/args/env` 和 HTTP 的 `type/url/headers`。Codex 额外支持 `cwd/required/startupTimeoutMs/toolTimeoutMs`；OpenCode 支持 `toolTimeoutMs`。CC 和 ACP 对无法表达的这些可选项报 `MCP_OPTION_UNSUPPORTED`，不假装已经应用。

会话创建和恢复均使用本轮配置；ACP 的 fresh fallback 再次传同一配置。具体运行时是否立即连接、是否延迟至首次 prompt，以及会话恢复时的凭据刷新，必须以对应版本的验证结果为准。

## 验证入口

- `test/context-mcp.test.js`：冻结、变量解析、并发、缺失变量、adapter 映射、ACP 恢复与不支持行为。
- `test/context-protocol.test.js` 与 Worker 的 shared fixtures：JSON Schema、TypeScript、Go 校验一致性。
- `OCTO_RUN_MCP_LIVE=1 node --test test/context-mcp-live.test.js`：已安装原生运行时连接本地 Streamable HTTP 测试服务，验证工具发现和合成鉴权 header。MCode 延迟连接需要发起 prompt；模型调用可能受账户状态影响。

连接与工具发现证据不等于模型已经实际调用工具。验证记录应分别说明连接、发现、调用和恢复换凭据的实测状态。
