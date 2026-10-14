# @mininglamp-oss/octo-harness-adapter-openclaw

OpenClaw Provider 的统一 Runtime Adapter。通过认证 WebSocket Gateway protocol v4 执行已有 Agent，回传统一 Host 事件。

## 连接与目标

Runtime 的连接描述保存到 `<harness-home>/<profile>/adapters/openclaw/connection.json`，token 与设备私钥保存在该 profile 的 `credentials` 目录。支持自动发现、指定 OpenClaw Home、显式 URL 与 token。每次探测和调用重新读取连接来源与凭据。

```sh
octo-harness --profile work adapter connect openclaw --openclaw-home /path/to/openclaw
octo-harness --profile work adapter connect openclaw --gateway-url ws://127.0.0.1:18789 --token-stdin
```

无参数时复用已保存连接或初始化默认来源。首次初始化可使用 `OPENCLAW_HOME`，或成对提供 `OPENCLAW_GATEWAY_URL` 和 `OPENCLAW_GATEWAY_TOKEN`。连接失败仅使该 Provider 不可用。

目标 Agent 由本轮 Context 的 `octo.execution/adapter.payload.provider_agent_id` 指定。探测不要求 `main` 存在，执行时验证实际目标；不自动创建 Agent或回退到其他目标。

完整定义与示例见 [统一合同](../../docs/15-openclaw-external-agent-binding-design.md)。

## 执行边界

OpenClaw 管理 Agent 的 persona、Skill、Plugin、MCP、memory、tools、workspace 和原生审批。Harness 不调用 `config.patch`、不清空 workspace，也不设置 `skipBootstrap`。

Adapter 声明 `metadata.workspace: false`，忽略 `octo.execution/workspace` 和 `workdir`，对 `preset` 与 `provisioned` 一致。Runtime 不检查或创建请求中的目录，不分配随机工作区，也不为 OpenClaw 创建 Provider 状态目录；准备回执使用 `workspace_mode: "none"`，被忽略的工作区配置记录为 `CONTEXT_WORKSPACE_IGNORED`。Gateway 的 `sessions.create` 和 `agent` 请求不携带 cwd/workspace，实际工作区始终由目标 OpenClaw Agent 管理。Context 格式、冻结计划一致性和执行身份校验继续生效。

Adapter 检查协议版本和公开执行能力，将原生事件映射为 canonical events，通过统一 interaction 合同处理审批、取消与恢复对账。Provider 原生配置不因调用而被永久改写。
