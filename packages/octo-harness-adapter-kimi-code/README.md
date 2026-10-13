# @mininglamp-oss/octo-harness-adapter-kimi-code

Kimi Code ACP adapter，adapter type 为 `kimi-code`。每次调用启动 `kimi acp`，通过通用 ACP adapter 完成 session 创建/恢复、模型选择、prompt 流和 canonical event 转换。

## 模型配置与环境变量

Agent Revision 使用 `execution_profile.agent_config.model`。Kimi 在 `session/new`/`session/load` 的 `configOptions` 中发布 `category: "model"` 的选项；adapter 校验请求值后，通过标准 ACP `session/set_config_option` 设置该 session。必须填写 option 的 `value`（模型 alias），不能填写展示名称。例如本机响应中 value 是 `kimi-k3`，展示名称是 `tencent/kimi-k3`，Revision 应填写 `kimi-k3`。

未配置时使用 `~/.kimi-code/config.toml` 的 `default_model`（数据根目录可由 `KIMI_CODE_HOME` 改写）。`KIMI_MODEL_NAME`、`KIMI_MODEL_API_KEY`、`KIMI_MODEL_BASE_URL` 等 `KIMI_MODEL_*` 可临时合成一个 provider/model；adapter 不设置这些变量，而是从 Kimi 实际发布的 session 选项中选择。显式 `api_key_env` 可以让 provider 从指定环境变量读取密钥。参考 [Kimi environment variables](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html)。

若当前 Kimi 版本没有发布 model config option，或请求 alias 不在 options 中，adapter 会在发送 prompt 前失败，不会静默退回默认模型。

## 使用

```bash
pnpm cli adapter probe kimi-code
```

`probe` 只检查可执行文件；登录态、模型凭据和实际推理网络仍需在 Runtime 上配置。

## 模块责任边界

- 负责：将 kimi-code 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
