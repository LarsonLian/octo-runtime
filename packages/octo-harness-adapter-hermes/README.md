# @mininglamp-oss/octo-harness-adapter-hermes

Hermes ACP adapter，adapter type 为 `hermes`。每次调用启动 `hermes acp`，通过通用 ACP adapter 完成 session 创建/恢复、模型选择、prompt 流和 canonical event 转换。

## 模型配置与环境变量

Agent Revision 使用 `execution_profile.agent_config.model`。Hermes 在 `session/new`/`session/load` 响应的 legacy `models.availableModels` 中发布可选模型；adapter 校验请求值后，通过 `session/set_model` 设置该 session。值必须使用返回的 `modelId`，不是展示名称。本机 Hermes 0.21.2 对腾讯 GLM 的实际 ID 为 `custom:tencent/glm-5.3`。

未配置时沿用 Hermes 当前 session/default config。Hermes CLI 的模型覆盖环境变量为 `HERMES_INFERENCE_MODEL`，等价入口为 `hermes --model`；但 ACP adapter 不写该环境变量，而是在 session 建立后使用协议级选模，这样同一个 Runtime 上的不同 Agent 可以独立配置模型。

若当前 Hermes 版本没有发布 model capability，或请求的 `modelId` 不在 `availableModels` 中，adapter 会在发送 prompt 前失败，不会静默退回默认模型。

## 使用

```bash
pnpm cli adapter probe hermes
```

`probe` 只检查可执行文件；登录态、模型凭据和实际推理网络仍需在 Runtime 上配置。

## 模块责任边界

- 负责：将 hermes 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
