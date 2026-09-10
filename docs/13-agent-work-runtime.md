# Agent Worker Runtime 模式

`apps/daemon` 作为 Agent Worker 的本地执行节点。Worker 是 AgentSession/AgentRun 唯一权威，daemon 只消费执行命令、调用 provider 并可靠回传事件。

## 链路

```text
Business service --submit AgentRun--> Agent Worker
Agent Worker --WSS run.start/cancel--> apps/daemon
apps/daemon --stdio JSON-RPC--> adapter-host --> provider
apps/daemon --WSS run.event--> Agent Worker
Agent Worker --event.ack(received/durable)--> apps/daemon
```

`run.start` 的 execution envelope 映射为 `InvokeRequest`：

- `agent_session_id` -> `agentSessionId`
- `run_id` -> `runId`
- `session_generation` -> `sessionGeneration`
- `provider_epoch` -> `providerEpoch`
- `continuity_mode` -> `continuityMode`
- `provider_session` -> `providerSession`
- `agent_run_request.input` -> prompt/model input
- `agent_revision.execution_profile` -> adapter、workdir、agent config
- `agent_revision.definition.instructions` -> provider control instructions

Runtime 不接收 TaskAttempt、ChatTurn 或 ExecutionRequest，也不根据来源选择执行模式。

## 可靠性

- command ACK 表示本地已接受，不表示 provider 完成。
- Run 事件严格按 `(run_id, seq)` 发送。
- received ACK 控制重发窗口；durable ACK 决定 outbox 是否可删除。
- reconnect 的 `runtime.hello` 上报 active run IDs，供 Worker 对账。
- 同一 AgentSession 的生产顺序由 Worker lease/fencing 保证。
- provider 子进程丢失后，Harness 不伪造继续执行；Worker 根据 lease 状态终结或重新调度。

Canonical terminal 映射：

| canonical event | AgentRun |
|---|---|
| `run.finished` | `completed` |
| `run.error` | `failed` |
| `run.stopped` | `cancelled` |

## Provider Session

Provider resume 数据来自 Worker 的 AgentSession。以 Codex 为例，`providerSession.sessionId` 是 thread ID，adapter 把它交给 provider 的 resume 参数。Provider 首次创建或 resume 后产生的 `session.update` 经事件流回写 Worker。

Worker reset 增加 generation/epochs 并清空 provider session。reset 后的第一条 run.start 不包含 resume 数据，因此 provider 创建新 thread。Harness 不生成业务 session key，也不在本地决定 reset。

Continue 与 Fresh Start 都创建新的 AgentRun。Continue 可以携带上一轮
`provider_session`，adapter 再通过 `session.update.providerSession.resumeOutcome`
报告真实的 `resumed`、`fresh_fallback` 或 `compacted` 结果；Fresh Start 的
execution envelope 禁止携带 `provider_session`，daemon 会对违反该不变量的命令
fail closed，避免旧 provider thread 污染新 generation。

## Channel Context

Channel Gateway 持有原始 IM 事件与 delivery；Worker 可以在 run.start 中携带冻结的 channel context。daemon 的可选 `channel-context.db` 只是可回源缓存：

- 按 scope、consumer key、session generation 隔离；
- 相同 Run 重试复用冻结 bytes/hash；
- provider 失败或取消不推进消费 cursor；
- 与可靠 `agent-work.db` outbox 分离。

缓存不拥有 IM 会话或 AgentSession。

## 配置

```bash
export OCTO_HARNESS_AGENT_WORK_URL=http://127.0.0.1:8092
export OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN=dev-runtime-token
export OCTO_HARNESS_AGENT_WORK_TENANT_ID=tenant-1
export OCTO_HARNESS_AGENT_WORK_SUBJECT_ID=device-local-1
export OCTO_HARNESS_AGENT_WORK_RUNTIME_NAME=octo-harness-local
pnpm daemon
```

Runtime token 只通过环境变量注入，不写入 argv、manifest、Agent revision、workdir 或 event payload。

可选 channel context：

```bash
export OCTO_HARNESS_CHANNEL_CONTEXT_STORE=sqlite
export OCTO_HARNESS_CHANNEL_CONTEXT_PROJECTION=delta
export OCTO_HARNESS_CHANNEL_CONTEXT_PROVIDER_PERSISTENCE=append_only
export OCTO_HARNESS_CHANNEL_CONTEXT_DB=/absolute/path/channel-context.db
```

本地 `status` 只展示 Runtime 连接、active invocation、ACK 与缓存指标，不替代 Worker 的 Run 状态 API。
