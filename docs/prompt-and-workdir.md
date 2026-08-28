# Prompt And Workdir

## Authoritative Context

Core 生成 `orbtex.context/v1`：Agent identity、Session、可选 Task/Attempt/Trigger occurrence。`renderPortableInstructions` 再附加 harness contract 和 per-turn instructions。这个对象来自持久控制面，不从 workdir 文件反推。

```json
{
  "schema": "orbtex.context/v1",
  "agent": { "id": "agent_...", "name": "reviewer" },
  "session": { "id": "session_...", "type": "task" },
  "task": { "id": "task_...", "title": "Review", "description": "..." },
  "attempt": { "id": "attempt_...", "number": 2 },
  "trigger": { "id": "occ_...", "kind": "event", "payload": {} }
}
```

## Provider-Native Injection

| Provider | Control instructions | User prompt | Cleanup |
|---|---|---|---|
| Codex | invocation-private shadow `CODEX_HOME/config.toml` `developer_instructions` | stdin | shadow home removed；auth/sessions/skills/rules are optional symlinks |
| Claude Code | mode `0600` temp file + `--append-system-prompt-file` | stdin | temp directory removed |
| CodeBuddy | ACP `session/prompt` content | ACP prompt content | ACP process/session lifecycle owns memory |
| OpenCode | mode `0600` temp instruction file referenced by `OPENCODE_CONFIG_CONTENT.instructions` | `opencode run` positional message | temp directory removed |
| OpenClaw local | 与 user prompt 分段组成兼容 prompt | mode `0600` temp file + `--message-file` | temp directory removed |

Codex/Claude/OpenClaw control instructions do not appear directly in argv。OpenClaw local 没有独立 system prompt carrier，因此分段文件仍是同一个 user message，不能把它误称为 provider 原生 system role。OpenCode CLI 当前没有 stdin message 参数，因此 user prompt 会成为 provider argv；需要更严格隐私时，下一步应改用 OpenCode headless server API，而不是 shell 包装。

## Workdir Rule

workdir 只承担：

- provider cwd 和预期代码目标；它本身不是操作系统访问边界；
- provider 自己的项目规则/配置发现；
- 用户明确希望 Agent 修改的内容。

workdir 不承担：

- Task/Run 状态数据库；
- trigger occurrence 去重；
- provider session binding；
- “必须调用 CLI 评论才算完成”的隐式协议；
- daemon token 或业务凭证落盘。

skills 可以提升 Agent 能力，但 run 正确收敛不能依赖模型是否读到某个 skill。最终响应和 tool stream 由 adapter 自动上报 canonical events。

真实文件访问范围必须由 provider sandbox、容器/虚拟机、宿主账号权限和 secret policy 建立。尤其 Claude `--print` 会跳过交互式 workspace trust，不能把 `workdir` 字符串当成可信度或隔离证明。

OpenClaw 是一个有意的例外：它的 cwd 优先 state/config/HOME，而不是 Orbtex Agent workdir，因为 agent workspace 与相对 plugin 路径由 OpenClaw 配置拥有。Orbtex 不把自己的 Task 状态或 skills 投影到那个 workspace；细节见 [OpenClaw Local Adapter](openclaw-local-adapter.md)。

## Secrets And Process Visibility

- JSON state 和 provider prompt temp files 使用 mode `0600`。
- adapter manifest、run/session IDs 不是 secret。
- token value 不进入 prompt、argv、event payload 或 workdir。
- 默认不启用 Codex dangerous bypass/OpenCode auto approve。
- 真实执行前用 `adapter probe`，并把 workdir 限制到明确目录。
