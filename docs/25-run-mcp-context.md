# Run MCP 执行配置（2026-10-14）

本协议允许在 Context 中指定本轮 MCP 连接。HostApp 负责 Skills、知识库组件、CLI、插件和 MCP 程序的安装与更新；原生运行时负责连接 HTTP 服务或启动已安装的 stdio 程序。Harness 不通过此配置下载或安装组件。

本协议取代 24 号方案中“Run / Context 不得携带 MCP 连接配置”的限制。FileBundle、资源下载、旧 `InvokeRequest.mcpServers` 和旧执行计划 `mcp_servers` 不恢复。Run 保持 7，Context 保持 v3；直接更新当前合同，不提供旧格式兼容。

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
              "X-Client": "octo-harness"
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

`BUSINESS_TOKEN` 可以来自运行 Harness 的进程环境，也可以由调用方通过本轮 `envs` 设置。配置中的 URL 必须是原始字符串，不是 Markdown 链接。

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
- Agent 默认配置：配置接口的 `configuration.defaults.items`。
- Agent 强制配置：配置接口的 `configuration.mandatory.items`。
- Worker 存储：`agent_context_configurations.configuration_json`，通过 `octo_space_id + agent_id` 关联 Agent；不在 Agent 主表或 revision 字段中。
- 本地 Harness Agent：注册时的 `defaultContext`，后续通过 `replaceDefaultContext()` 修改。

defaults 和请求按 server 名称合并；同名 server 整项替换，不深合并 headers、env 或 transport 字段。mandatory 也按 server 名称约束：请求显式传入的同名 server 必须完整一致，否则报 `CONTEXT_MANDATORY_CONFLICT`。空 map 不删除 defaults 或原生本地 MCP。

执行计划使用 `mcp: { mcpServers: ... }` 冻结未展开的模板，并与有效 Context 核对。环境值仅在执行主机准备 invocation 时读取，不回写 Context、执行计划或原生配置文件。框架不从上一轮补 MCP 配置；Worker 的会话兼容性标识包含 MCP 模板。MCP 配置和 envs 不渲染到模型上下文。

现有 Context JSON 字段可存储此扩展，不需要数据库结构迁移或删库。

## 环境与变量

本轮环境按“父进程继承值 → Run envs → adapter 内部覆盖值”组合，后者优先；每次 invocation 独立，不修改全局 `process.env`。stdio server 显式配置的 `env` 再覆盖传给该 MCP 子进程的同名变量。

准备环境后，Harness 在 `command`、`args` 元素、`cwd`、`env` 值、`url` 和 `headers` 值中展开 `${NAME}`。server 名称、字段名称、header 名称和 env key 不展开。变量名采用 `[A-Za-z_][A-Za-z0-9_]*`。

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
| Codex | app-server 的 thread/start、thread/resume `config.mcp_servers` | 读取有效本地配置，合并本轮 server；HTTP headers 通过本轮私有环境变量引用；不改用户文件 |
| Claude Code | `--mcp-config` 私有临时 JSON | 映射 `type: http`，保留本地 MCP 配置入口；结束时删除临时文件 |
| Kimi / MCode 等 ACP adapter | session/new、session/load `mcpServers` | 转成数组，HTTP 类型为 `http`，headers/env 转为 name/value 数组；先检查原生 HTTP 能力声明 |
| OpenCode | `OPENCODE_CONFIG_CONTENT.mcp` | stdio 转 local，HTTP 转 remote，保留本地原生配置加载 |
| 未实现 MCP 的 adapter | 无 | 非空本轮 MCP 配置明确报 `MCP_UNSUPPORTED`，不静默忽略 |

Harness 对本轮 server 的转换不改变审批策略。连接成功不授予业务权限，也不自动批准工具调用。

不同原生运行时对本地同名配置的合并行为需以实机验证为准。Codex 在本轮传入完整同名 server 配置；CC / OpenCode 的配置优先级仍受原生加载器控制。需要确定隔离的配置应使用不与本地配置冲突的 server 名称。

共同可移植字段为 stdio 的 `type/command/args/env` 和 HTTP 的 `type/url/headers`。Codex 额外支持 `cwd/required/startupTimeoutMs/toolTimeoutMs`；OpenCode 支持 `toolTimeoutMs`。CC 和 ACP 对无法表达的这些可选项报 `MCP_OPTION_UNSUPPORTED`，不假装已经应用。

会话创建和恢复均使用本轮配置；ACP 的 fresh fallback 再次传同一配置。具体运行时是否立即连接、是否延迟至首次 prompt，以及会话恢复时的凭据刷新，必须以对应版本的验证结果为准。

## 验证入口

- `test/context-mcp.test.js`：冻结、变量解析、并发、缺失变量、adapter 映射、ACP 恢复与不支持行为。
- `test/context-protocol.test.js` 与 Worker 的 shared fixtures：JSON Schema、TypeScript、Go 校验一致性。
- `OCTO_RUN_MCP_LIVE=1 node --test test/context-mcp-live.test.js`：已安装原生运行时连接本地 Streamable HTTP 测试服务，验证工具发现和合成鉴权 header。MCode 延迟连接需要发起 prompt；模型调用可能受账户状态影响。

连接与工具发现证据不等于模型已经实际调用工具。验证记录应分别说明连接、发现、调用和恢复换凭据的实测状态。
