# Agent Work Runtime 模式

`apps/daemon` 可以作为 `orbtex-agent-work` 的本地 Runtime 节点运行。该模式是可选的；
未设置 `ORBTEX_AGENT_WORK_URL` 时，原有 Unix socket、JSON store、CLI Chat/Task 行为不变。

## 职责

```text
orbtex-agent-work --WSS run.start/cancel--> apps/daemon
apps/daemon       --stdio JSON-RPC-------> adapter-host
adapter-host      --canonical events----> apps/daemon
apps/daemon       --WSS run.event--------> orbtex-agent-work
```

Runtime 注册时上报本机 adapter 列表。`run.start` 的 `ExecutionEnvelope` 被显式映射为
`InvokeRequest`：

- `harness_session_id` -> `sessionId`；
- `provider_session` -> `providerSession`，用于 Codex thread/CodeBuddy session resume；
- `agent_revision.execution_profile.workdir` -> 固定 provider cwd；
- `default_adapter=codex-local|codebuddy-local` -> manifest 中的 `codex|codebuddy`；
- `definition.instructions` -> adapter 的私有 control-instruction carrier；
- `immutable_execution_input` -> 带 `[Recent group messages]`、quoted message 和
  `[Current message]` 边界的 user prompt。

Runtime 将 Orbtex 终态映射为 Agent Work 终态，并逐条保留 canonical message/tool/usage
事件。当前兼容路径仍在 terminal payload 中携带由 final delta 拼出的文本，供旧 Delivery
worker 回写 IM；该文本不是长期权威输出模型：

| Orbtex canonical | Agent Work |
|---|---|
| `run.finished` | `run.completed` |
| `run.error` | `run.failed` |
| `run.stopped` | `run.cancelled` |

目标链路由 agent-work 的 CanonicalOutputAccumulator 按稳定 `messageId/itemId` 重建完整
item，并以 `message.update.text` 校正 delta 累积。Buddy 消费经过 Presentation policy 与脱敏
的 ExperienceEvent；IM gateway 只执行包含完整内容的 DeliveryIntent，不接收或拼接 delta。
只有一条历史 trace 完全不存在 final item 时，terminal `payload.text` 才能作为 legacy fallback，
且不能与 item-aware Delivery 同时出站。协议见
[`../../orbtex-agent-work/docs/08-multi-surface-presentation-protocol.md`](../../orbtex-agent-work/docs/08-multi-surface-presentation-protocol.md)。

## 配置

```bash
export ORBTEX_AGENT_WORK_URL=http://127.0.0.1:8092
export ORBTEX_AGENT_WORK_RUNTIME_TOKEN=dev-runtime-token
export ORBTEX_AGENT_WORK_TENANT_ID=tenant-1
export ORBTEX_AGENT_WORK_SUBJECT_ID=device-local-1
export ORBTEX_AGENT_WORK_RUNTIME_NAME=orbtex-local
# 已知 ID 时可固定；省略则按 fingerprint 注册或复用 Runtime。
# export ORBTEX_AGENT_WORK_RUNTIME_ID=runtime_...

pnpm daemon
pnpm cli status
```

`status.agentWork` 返回 `enabled/connected/runtimeId/activeRuns/lastAckedCommandSeq`。
每次 WSS 重连时，daemon 还会在 `runtime.hello` 上报 `active_run_ids`。Agent Work
据此终结已经 ACK、但不再由重启后 daemon 持有的悬挂 Run；省略该字段的旧 runtime
不会触发所有权对账。
token 只允许通过环境变量注入，不写入 manifest、Agent revision、workdir 或 event payload。

## 当前实验边界

- WSS event 逐条等待 Agent Work `event.ack`，保证单 Run seq 不越过未提交事件。
- command ACK 表示本地已接受 invocation，不表示 provider 已完成。
- daemon 进程重启不能 reattach 已丢失的 provider 子进程；生产化需要 durable command
  inbox、accepted-but-unfinished recovery 和 run lease timeout。
- `workdir` 是 cwd，不是 chroot；实际权限仍由 Codex sandbox、容器和宿主账号建立。
