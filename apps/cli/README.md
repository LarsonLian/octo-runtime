# Octo Harness CLI

CLI 是 daemon 的本地运维客户端。每个命令通过 Unix socket 发送一行 `{id, method, params}`。

```bash
octo-harness daemon
octo-harness status
octo-harness adapter list
octo-harness adapter probe codex
octo-harness logs path
octo-harness logs query <agent-run-id>
octo-harness agent-session list
octo-harness agent-session get <agent-session-id>
octo-harness agent-run list
octo-harness agent-run get <agent-run-id>
octo-harness agent-run events <agent-run-id>
octo-harness agent-run wait <agent-run-id>
octo-harness agent-run stream <agent-run-id>
octo-harness agent-run cancel <agent-run-id>
```

AgentSession/AgentRun 命令只检查单机 reference projection。生产创建、reset、状态与取消应调用 Agent Worker API 或 `octo-cli harness`。CLI 不再创建 Agent、Chat、Task 或 Trigger。
