# 模块与传输流程

## 模块边界

| 模块 | 输入 | 输出 | 禁止承担 |
|---|---|---|---|
| Agent Worker | AgentRun submit、业务 occurrence | run.start/cancel、状态/API | Loop/IM 业务调度 |
| `AgentWorkRuntime` | WSS command | ACK、run.event | 创建业务 Run |
| `AdapterHost` | InvokeRequest | canonical event stream | Session/Run 持久化 |
| provider adapter | provider-neutral request | native-to-canonical mapping | 业务判断 |
| reference Core | 本地 submit | 本地 AgentSession/Run | 生产权威 |

## 生产执行时序

```mermaid
sequenceDiagram
  participant B as Business service
  participant W as Agent Worker
  participant D as Harness daemon
  participant H as Adapter Host
  participant P as Provider

  B->>W: submit AgentRun
  W->>W: resolve AgentSession; queue/lease
  W-->>D: run.start execution envelope
  D->>D: durable command acceptance
  D-->>W: command.ack
  D->>H: adapter.invoke
  H->>P: start or resume
  P-->>H: native stream
  H-->>D: canonical events
  D-->>W: run.event(run_id, seq)
  W-->>D: event.ack(received, durable)
  P-->>H: terminal
  H-->>D: exactly one terminal event
  D-->>W: terminal run.event
  W-->>B: status/event projection
```

`command.ack` 只表示 Runtime 接受命令，不表示执行完成。事件按 `(run_id, seq)` 排序和去重。outbox 只在 Worker durable ACK 后删除。

## 本地传输

- CLI 到 daemon：Unix socket，一行 `{id, method, params}` 请求和一行响应；stream 命令可输出多行 event。
- daemon 到 adapter-host：stdio NDJSON JSON-RPC 2.0。
- daemon 到 Worker：认证 WSS，可靠 command/event/ACK 协议。
- adapter-host 到 provider：每次 invocation 的子进程或 provider SDK transport。

本地 CLI 只暴露 status、adapter、logs 与 reference profile 的 AgentSession/AgentRun 查询/取消，不再提供 `chat`、`task` 或 `trigger` 创建命令。

## Provider Resume

Worker 下发的 execution envelope 包含：

```json
{
  "agent_session_id": "asess_...",
  "run_id": "arun_...",
  "provider_session": {
    "sessionId": "provider-native-opaque-id"
  }
}
```

Runtime 映射为 `InvokeRequest.agentSessionId`、`runId` 和 `providerSession`。adapter 将 `sessionId` 映射为各 provider 的 resume 参数。新 session 没有该字段；adapter 从 provider 事件产生 `session.update`。

## 单会话顺序

Worker 是生产队列权威。reference daemon 也对同一个 AgentSession 执行 FIFO，以便本地测试与生产不产生相反语义。业务并发由业务服务选择不同 session key 或等待前一 Run 终态；Harness 不拆父子任务，也不自动重试业务工作。
