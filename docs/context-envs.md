# Run 环境变量 Context

`octo.execution/envs` 是标准 Context 项，用于向本次 AgentRun 的本地 Provider 进程传入环境变量。Context 保持 `octo.context-envelope/v3`，Run 保持 `schema_version=7`，Adapter transport 保持 `protocolVersion=2`。Catalog v3、Compiler v4 不变；不新增 Runtime 能力准入字段。

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

`payload.env_variables` 必须是 `{ key, value }` 条目列表。环境变量名放在条目的 `key` 值中，不作为协议 JSON 属性名。字典形状不再接受。Agent 的 `context_configuration.defaults`、`mandatory` 以及单次 Run 的请求 context 均使用同一格式。

- key 必须匹配 `[A-Za-z_][A-Za-z0-9_]*`；value 必须是字符串且不含 NUL。
- 同一列表内的 `key` 不得重复，即使值相同也拒绝。条目不得缺少 `key` 或 `value`，不得增加未知字段。
- 最多 128 个条目，并计入整个 Context 的 65,536 字节预算。
- `""` 表示将变量设置为空字符串；`null`、数字和布尔值均非法。
- 不展开 `${NAME}`，不执行 shell，不加载 `.env` 文件。
- `env_variables: []` 表示该层没有覆盖项，不删除低优先级变量。本次不定义删除变量的操作。

## 合并与冻结

Worker 和本地 Harness 按 key 合并 defaults 与 request。请求中的同名 key 覆盖默认值，未提交的 key 保留。mandatory 逐 key 约束：请求显式提交不同值时返回 `CONTEXT_MANDATORY_CONFLICT`；未提交时补入强制值，不限制请求增加其他 key。

有效值以同一列表结构进入 `effective_context` 与 `resolved_execution_plan.envs`，参与 context hash、compiled hash 和会话配置指纹。Harness 在准备阶段检查两份数据是否一致，防止冻结后篡改。变量变更会改变会话配置指纹，沿用现有会话连续性处理。

## 运行时范围与优先级

协议和执行快照保留列表结构；适配器在启动进程时才将列表转换成系统 API 所需的环境字典。每次调用都创建独立的环境对象：继承宿主环境，覆盖本次 Run 的 envs，最后应用适配器为其传输设置的固定变量。不得修改宿主的全局 `process.env`。并发 Run 的覆盖值不共享。

| 执行路径 | 行为 |
| --- | --- |
| Codex | 注入 app-server 进程；读取原生有效配置，在 thread/start 和 thread/resume 中设置本次 shell 环境与本地 stdio MCP 变量白名单。配置读取失败则停止调用，不伪装为已应用。 |
| Claude Code、CodeBuddy、通用 ACP、ZCode、Antigravity、通用 CLI | 注入每次调用新建的 Provider 子进程。Provider 启动的 CLI/stdio MCP 依其原生继承规则获得变量。 |
| OpenClaw Gateway | 非空 envs 返回 `CONTEXT_ENVS_UNSUPPORTED`，因为当前 Gateway 没有本次调用的环境变量载体。空 envs 不影响调用。 |
| 远程 HTTP MCP、远程 executor MCP | 不把本机环境直接传给远端进程。HTTP MCP 可以通过 Provider 已配置的环境变量引用取得客户端认证信息；不会自动新增 header。 |

Codex 的 shell 覆盖保留已有环境策略，仅补入指定值和必要的 include 白名单。本地 MCP 保留原有配置，追加变量名白名单；MCP 自己显式配置的同名 `env` 仍按 Provider 原生优先级生效。因此 mandatory 约束的是 Run 注入值，并不改写用户的 MCP 专用配置。不会重新安装、同步或修改 MCP/插件文件。

环境变量中的值不会被编译成模型材料或控制指令。观测日志会剔除 envs payload、执行计划 envs 和 Codex 原生 shell 注入值，不依赖变量名是否包含 token/secret。请求和执行快照仍保存这些值；此能力不是凭据保险库，也不承诺阻止工具主动输出环境变量。

## 验证入口

- `node --test test/context-protocol.test.js test/context-configuration-protocol.test.js test/context-envs.test.js`：Schema/TypeScript 校验、跨语言共享样例、合并约束、计划一致性、并发 CLI 子进程、模型输入隔离和日志脱敏。
- Worker `go test ./internal/domain ./internal/service`：使用相同 fixtures 验证 Go 合同和已有执行服务。
- `OCTO_RUN_CODEX_ENVS_LIVE=1 node --test test/codex-envs-live.test.js`：启动本机真实 Codex app-server 与临时 stdio MCP，验证值传递；不发起模型 turn，不使用真实凭据，不修改用户配置。

Codex 原生环境配置字段依据：[Configuration Reference](https://developers.openai.com/codex/config-reference/)。具体的服务联调结果与尚未验证的范围应记录在当次验证记录中。
