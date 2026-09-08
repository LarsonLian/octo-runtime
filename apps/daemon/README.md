# Octo Harness Daemon

daemon 组合 adapter-host、本地诊断 store、Unix socket 与可选 Agent Worker Runtime。

生产模式下：

1. 通过认证 WSS 接收 Worker 的 `run.start/cancel`。
2. durable 接受命令后 ACK。
3. 将 execution envelope 映射为 `InvokeRequest`。
4. 调用 adapter-host 并把 canonical events 写入可靠 outbox。
5. 收到 Worker durable ACK 后清理 outbox。

daemon 不拥有业务 Task/Chat/Trigger，也不生成 session key。Worker 是 AgentSession/AgentRun 权威，本地数据库只记录执行恢复与诊断数据。
