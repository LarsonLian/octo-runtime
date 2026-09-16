# 06 OpenClaw Gateway Adapter

`openclaw` adapter 通过 OpenClaw Gateway 的公开 WebSocket protocol v4 执行 AgentRun。它不再启动 `openclaw agent --local`，也不读取 OpenClaw session transcript。Gateway 的 `agent` server-push events 是过程流，Octo canonical events 是上层唯一合同。

## 前置配置

OpenClaw 配置绑定在已登录的 Harness profile 上，因此必须先完成 `octo-harness login`，并在 `setup` 时显式传入 `--profile`。省略 profile 或指定尚未登录的 profile 都会 fail closed。Gateway token 从 stdin 读取，不进入命令参数、profile config 或日志。

```bash
printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | \
  octo-harness --profile <profile> adapter setup openclaw \
    --gateway-url ws://127.0.0.1:18789 \
    --token-stdin
```

远程 Gateway 必须使用 `wss://`，并显式传入 Gateway 主机上的空壳 workspace：

```bash
printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | \
  octo-harness --profile <profile> adapter setup openclaw \
    --gateway-url wss://gateway.example.com \
    --workspace /var/lib/octo/openclaw/octo-openclaw-runner.workspace \
    --token-stdin
```

首次 `setup` 在同一条命令中完成两个内部阶段：先把 URL、agent id、workspace 和通用 adapter execution manifest 保存到 profile config，并把 token、device identity 和后续获得的 device token 单独保存到 profile credential 文件；随后连接 Gateway、检查协议能力并创建默认名为 `octo-openclaw-runner` 的专用 agent。daemon 只解析通用 manifest，不包含 OpenClaw option key 分支；重新 login 会保留 adapter 配置。已有配置时可以不带参数幂等重跑：

```bash
octo-harness --profile <profile> adapter setup openclaw
```

Runner 设置包括：

- Gateway 级 `agents.defaults.skipBootstrap: true`
- `contextInjection: "never"`
- `skills: []`
- `tools.deny: ["group:memory"]`
- `memory.search.rememberAcrossConversations: false`

OpenClaw 2026.9.4 没有 per-agent 或 per-session 的 `skipBootstrap`，因此第一项会影响同一 Gateway 上的所有 agents。严格隔离部署应为 Octo 使用专用 Gateway；共享 Gateway 必须显式接受这个影响。本地 Gateway 的空壳 workspace 会清除 OpenClaw 生成的 bootstrap 文件，再设为 `0555`；符号链接会被拒绝。远程目录的只读权限无法由本机 CLI 强制，必须由 Gateway 主机的 owner/service manager 落实。

本地自定义 `--workspace` 只能位于当前 profile 的 `adapters/openclaw/` 受管目录内；daemon 启动时再次校验 realpath、空目录和只读 mode。每次 Run 在创建 session 前还会通过 `config.get` 校验 Gateway 的 `skipBootstrap` 以及 runner 的 context、skills、memory 和 workspace 配置，配置漂移时 fail closed。

## Invocation Lifecycle

```text
InvokeRequest
  -> open one authenticated WebSocket
  -> verify protocol=4 and advertised methods/events
  -> config.get and verify the runner isolation contract
  -> sessions.create(key, agentId, cwd=InvokeRequest.workdir)
  -> sessions.messages.subscribe(key, agentId)
  -> agent(sessionKey, message, extraSystemPrompt, model, thinking)
  -> route event:"agent" by runId and deduplicate by seq
  -> require agent.wait to confirm the lifecycle terminal
  -> emit one canonical run terminal
  -> close WebSocket
```

工作目录必须通过 `sessions.create.cwd` 设置。OpenClaw 2026.9.4 会拒绝普通 operator 在 `agent` RPC 中传 `cwd`，该字段只保留给 plugin-owned subagent run。Adapter 因此先创建一次性 session，显式调用 `sessions.messages.subscribe` 打开该 session 的完整消息流，再调用不带 `cwd` 的 `agent` RPC。只连接 WS 或只调用 `sessions.subscribe` 不会得到完整的 assistant/thinking/tool/lifecycle 增量。`agents.defaults.skipBootstrap=true` 阻止 OpenClaw 在这个真实 cwd 自动创建 `.git` 和默认 workspace 文件。

每个 Octo AgentRun 使用唯一 OpenClaw session key。这样同一 WebSocket 内不会混淆其他 Run 的事件，也不会把 OpenClaw transcript 当成 Octo 的 conversation 或 memory 权威。OpenClaw 当前只允许 Control UI 创建 incognito session，所以 operator RPC 创建的内部 session 仍可能被 Gateway 持久化；隔离保证来自唯一 session、禁用 runner memory 和 Octo 自己注入的冻结上下文，不等于 OpenClaw state dir 零落盘。

## Event Mapping

| OpenClaw Gateway event | Canonical event |
|---|---|
| `lifecycle.start` | `model_step.started` |
| cumulative `assistant.text` | deduplicated `message.delta` / replacement `message.update` |
| cumulative `thinking.text` | analysis `message.delta` / `message.update` |
| `tool.start/update/result` | `tool_call.create/update` |
| `item.preamble` | analysis `message.delta` |
| `usage` | `usage.update` |
| `lifecycle.end` | `model_step.finished` then `run.finished` |
| `lifecycle.error` or RPC failure | `run.error` |
| Harness abort | `sessions.abort` then `run.stopped` |

未知 event 和未知 stream 被忽略；已知 stream 的附加字段不会导致失败。事件只按已接受的 `runId` 消费，并按单调 `seq` 去重，其他 Run 的帧不会进入当前 canonical 流。seq 跳号会写入 provider observation。lifecycle 终态只有在 `agent.wait` 返回匹配的确定终态后才映射为 canonical terminal；连接中断后 adapter 会新建认证连接并在 invocation deadline 内持续处理 `pending`/非终态 `timeout`，用同一 runId 对账且不伪造缺失 delta。OpenClaw 2026.9.4 的取消确认为 `status=timeout`、`endedAt` 已设置且 `stopReason=aborted`；agent 尚未 accepted 时取消不会发送无效 abort。

## Compatibility Boundary

Adapter 不导入 OpenClaw 内部 package，不安装 OpenClaw plugin，也不依赖 transcript 文件布局。它只依赖 Gateway protocol v4 公共能力：`config.get`、`sessions.create`、`sessions.messages.subscribe`、`agent`、`agent.wait`、`sessions.abort` 和 `agent` event。连接后会检查 `hello-ok.features`；协议版本或必需能力不匹配时 fail closed。

这比内置 plugin ABI 的升级耦合更小，但不是“任意 OpenClaw 版本都兼容”。升级 Gateway 后必须运行 contract tests，并在真实测试 Gateway 做一次只读 smoke test。当前实测基线为 OpenClaw `2026.9.4`。

## Online Verification

本仓库依赖 octo-auth，端到端验证必须从线上测试环境 `https://im-test.deepminer.com.cn/` 触发真实 AgentRun。当前 profile Runtime 已完成 octo-auth enrollment 并在线连接 Agent Work；尚未从 IM 页面触发 OpenClaw AgentRun。单元测试和本地 Gateway smoke test只覆盖协议、cwd、事件隔离和失败收敛，不能替代 IM、审计和卡片终态的全链路验收。
