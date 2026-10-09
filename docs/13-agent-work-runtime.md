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

### Agent 执行超时

在 AgentRevision 的 `execution_profile.runtime_limits` 中配置超时，单位为毫秒。
daemon 将这些字段映射为 `InvokeRequest.runtimeLimits`，由 adapter-host 执行。
未配置 `model_idle_timeout_ms` 时，默认值为 **300000（300 秒）**，所有 adapter 共用；
建议 Agent 显式配置 **600000（600 秒）**，尤其是 Codex 编码、生成大文件等可能长时间无输出的任务。

```json
{
  "execution_profile": {
    "runtime_limits": {
      "model_idle_timeout_ms": 600000
    }
  }
}
```

以上为局部配置示例，应合并到完整 execution profile，保留 adapter、workdir 等字段。
该参数限制模型阶段连续未收到下一条 canonical event 的时长，不是整个任务的运行时长。
未显式覆盖的其他默认值为：启动等待 60 秒、工具阶段静默 600 秒、单轮运行总时长 10800 秒（3 小时）、
取消清理等待 1 秒、`enforcement: "enforce"`。收到事件不会延长整个任务的时限。
`run_timeout_ms` 可通过 Agent Context 的 `octo.execution/limits` 覆盖，允许 100–86400000 毫秒（最多 24 小时）。未配置时由 Adapter Host 使用 10800000 毫秒默认值；显式配置不会被此默认值覆盖。
不要用旧 `enforcement: "observe"` 代替延长预算：它为兼容历史配置仍跳过整套 watchdog。
新 `model_idle_policy: "observe"` 仅关闭模型静默取消，总时限和工具时限始终执行。
默认策略为 `enforce`；`model_idle_warning_ms` 默认 120000，在持续无进展时只告警一次，
真实进展恢复后可再次告警。`tool_wall_timeout_ms` 可选，用于限制每次工具执行的总耗时，输出不能续期。
新策略需 Runtime 的 adapter 能力包含 `runtime.watchdog.v2`。旧全局 observe 不能与新字段混用。
Codex 原生进展在归一化之前报告；仅 RPC 有响应、重试通知或重复 usage 不延长模型预算。
其他 adapter 暂按 canonical 进展回退。诊断活动不会生成伪造的用户消息。

显式配置优先于 Host 默认值，因此已有的 `model_idle_timeout_ms: 120000` 不会自动变成 300 秒。
通过新 AgentRevision 发布配置，并确认目标 session 后续 run 使用该 revision；
已有 invocation 保留启动时的配置。修改 Host 默认值需重新构建并重启 adapter-host 后生效。

### Runtime 连接

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
