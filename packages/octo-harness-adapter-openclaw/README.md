# @mininglamp-oss/octo-harness-adapter-openclaw

Octo Harness 的 OpenClaw Gateway adapter。每次 invocation 创建一条已认证 WebSocket，通过公开 protocol v4 的 `sessions.create` + `sessions.messages.subscribe` + `agent` RPC 启动执行，并把 `agent` events 转换为 canonical session / model-step / reasoning / message / tool / usage / run 事件。

## Runtime Contract

- 一次 AgentRun 一条 WebSocket、一个唯一 OpenClaw session key。
- 每次 Run 先用 `config.get` 验证 Gateway/runner 隔离配置，发现漂移时不创建 session。
- `sessions.create.cwd` 使用 `InvokeRequest.workdir`；`agent` RPC 不传 `cwd`。
- 调用 `sessions.messages.subscribe` 后再发起 `agent`，否则 Gateway 可能只返回最终 RPC JSON 而不推送完整增量流。
- user input 进入 `message`，Harness 控制上下文进入 `extraSystemPrompt`。
- 事件按 `runId` 隔离、按 `seq` 去重；未知 stream 向前兼容地忽略。
- lifecycle terminal 后必须由 `agent.wait` 确认；取消时调用 `sessions.abort` 并识别 OpenClaw 的 `timeout + endedAt + stopReason=aborted` 确定终态，断线时用新连接按 runId 对账到 invocation deadline。
- Gateway token 和 device private key 只从 profile credential 注入，不进入 provider observation。
- 若事件流缺失但 `agent` RPC 返回完整最终结果，adapter 会从该结果补齐 final text、usage 和终态。

## Setup

必须先完成 Harness profile 登录：

```bash
printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | \
  octo-harness --profile <profile> adapter openclaw configure \
    --gateway-url ws://127.0.0.1:18789 \
    --token-stdin

octo-harness --profile <profile> adapter openclaw init
```

`init` 创建默认 `octo-openclaw-runner`，清空并冻结本地空壳 workspace，关闭 OpenClaw workspace context、skills 和 memory access。它还设置 Gateway 级 `agents.defaults.skipBootstrap=true`，防止 OpenClaw 在 `InvokeRequest.workdir` 创建 `.git` 和默认 workspace 文件。OpenClaw 2026.9.4 没有对应的 per-agent 开关，因此共享 Gateway 上的其他 agents 也会受影响；严格部署应使用 Octo 专用 Gateway。本地 workspace 必须位于 profile 受管目录内，并在 daemon readiness 时复检为空且只读。远程 Gateway 需要 `wss://` 和显式 `--workspace`，目录只读权限由远程 owner 管理。

Agent revision 仍提供 `providerAgent`、`model`、`thinking` 和 `timeoutSeconds`。Gateway URL/token/device identity 通过 profile 的通用 adapter execution/credential manifest 注入，不从 AgentRevision 或进程环境获取；daemon 不包含 OpenClaw 专用 option 映射。

## Compatibility

生产实现不使用 OpenClaw plugin 或内部模块，只绑定 Gateway protocol v4 advertised capabilities。当前实测基线是 OpenClaw `2026.9.4`。Gateway 升级后应运行 contract tests 和真实 Gateway smoke test；协议版本或必需 method/event 缺失时 adapter fail closed。

详细设计和限制见 [OpenClaw Gateway Adapter](../../docs/06-openclaw-local-adapter.md)。
