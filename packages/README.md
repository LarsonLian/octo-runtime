# Packages And Adapter Guide

Octo Harness packages 围绕一条统一链路组织：

```text
Agent Worker run.start
  -> AgentWorkRuntime
  -> AdapterHost
  -> provider adapter
  -> provider process
  -> CanonicalEvent
  -> reliable run.event
```

## 包职责

| 包 | 职责 |
|---|---|
| `octo-harness-protocol` | InvokeRequest、ProviderSession、CanonicalEvent |
| `octo-harness-adapter-host` | adapter registry、invoke/cancel、terminal normalization |
| `octo-harness-adapter-sdk` | subprocess/JSONL helpers |
| `octo-harness-acp-client` | ACP transport |
| `octo-harness-adapter-codex` | Codex command/resume/event mapping |
| `octo-harness-adapter-claude-code` | Claude Code mapping |
| `octo-harness-adapter-codebuddy` | CodeBuddy ACP mapping |
| `octo-harness-adapter-opencode` | OpenCode mapping |
| `octo-harness-adapter-openclaw` | OpenClaw local mapping |
| `octo-harness-core` | AgentSession/AgentRun reference profile |
| `octo-harness-daemon` | reference FIFO executor |

## Provider Agent 配置

Agent revision 的 execution profile 决定 adapter、workdir、model 与 provider-specific options。创建/发布 Agent 由 Agent Worker 完成，不由 Harness CLI 完成。

常见配置字段：

| 字段 | 使用者 | 说明 |
|---|---|---|
| `workdir` | Codex/Claude/CodeBuddy/OpenCode | provider cwd |
| `model` | provider adapter | provider model |
| `permissionMode` | Claude/CodeBuddy | provider 权限模式 |
| `sandbox` | Codex | Codex sandbox |
| `providerAgent` | OpenClaw | OpenClaw agent slug |
| `thinking` / `effort` | 支持的 provider | 推理选项 |

Provider 首次调用发出 `session.update`。Worker 把 opaque provider session 保存到 AgentSession，后续 run.start 再下发。Adapter 只读取 `providerSession.sessionId` 并翻译为原生 resume 参数。

## 安全

Workdir 不是安全边界。危险 bypass/auto-approve 选项必须结合容器、VM 或等价隔离。Runtime token 只从环境变量读取。Adapter manifest 不得包含业务凭证、IM bot token 或 Worker token。
