# 06 OpenClaw Local Adapter

`openclaw` adapter 是 local-only 实现。它参考 Aily `adapter-oc-local` 的 local transport，但没有复制 Gateway 管理、插件同步和 Aily skill materialization：每次 Octo Harness invocation 都启动一个 `openclaw agent --local` 子进程，结束后回收进程和临时 prompt 文件。

## Invocation Lifecycle

```text
InvokeRequest
  -> mint/reuse providerSession.sessionId
  -> compose control instructions + user request
  -> write mode 0600 temporary message file
  -> spawn openclaw agent --local --json --session-id ... --message-file ...
  -> tail newly appended session transcript records while parsing stdout
  -> emit canonical session/model-step/reasoning/message/tool/usage/run events
  -> reconcile the optional pretty-printed final JSON blob
  -> remove temporary directory
```

adapter 不连接 `ws://127.0.0.1:<gateway-port>`，不执行 `openclaw gateway install/restart`，也不要求常驻 Gateway。`adapter probe openclaw` 只检查 `openclaw` 可执行文件。

## Session Continuity

首次 invocation 生成 `octo-harness-<uuid>`，并立即上报：

```json
{
  "type": "session.update",
  "payload": {
    "providerSession": {
      "sessionId": "octo-harness-...",
      "resumable": true,
      "agentId": "main"
    }
  }
}
```

Core 把这个 opaque provider session 保存到 Harness Session。Chat 下一轮或 Task continuation 再把它放入 `InvokeRequest.providerSession`，adapter 仍传相同的 `--session-id`。OpenClaw 自己负责读取 state dir 中的 session JSONL；Octo Harness 不把 transcript 复制到 workdir。

## Prompt And Workdir

OpenClaw local CLI 没有独立的 system-prompt 参数。adapter 因而把两类内容明确分段后放入同一个临时文件：

```text
[Harness Instructions]
<daemon-owned context and per-turn control>

[User Request]
<user prompt>
```

这是一种兼容投影，不等价于模型 API 的 system role。临时目录尽量设为 `0700`，文件设为 `0600`，prompt 不进入 argv，invocation 完成或失败后都会清理。

cwd 与 Aily local 路径保持相同方向：优先 `OPENCLAW_STATE_DIR`，其次 `OPENCLAW_CONFIG_PATH` 所在目录，再到 `HOME`。原因是 OpenClaw 的 agent workspace、plugin 和相对路径由 OpenClaw 配置管理；Octo Harness Agent 的 `workdir` 不应偷偷改写 OpenClaw 的 state root。要让 OpenClaw 操作某个代码目录，应在相应 OpenClaw agent 配置中设置 workspace。

## Native Event Mapping

| OpenClaw output | Canonical event |
|---|---|
| transcript assistant record | `model_step.started/finished` |
| transcript `thinking` block | `message.delta(channel=analysis, exposure=public_reasoning)` |
| transcript `toolCall` block | `tool_call.create` with the assistant `stepId` |
| transcript `toolResult` message | `tool_call.update` with the originating `stepId` and provider duration |
| `text` | `message.delta(channel=final)` |
| `tool_use` | `tool_call.create` |
| `tool_result` | `tool_call.update(completed/error)` |
| `step_finish.usage` | `usage.update` |
| final blob `meta.agentMeta.sessionId` | `session.update` when changed |
| final blob `payloads[].text` | reconcile missing delta, then `message.update` |
| clean exit | `run.finished` |
| provider error/non-zero exit | `run.error` |
| host abort/lifecycle cancelled | `run.stopped` |

OpenClaw 2026.x 的 `--json` stdout 可能是逐行 NDJSON，也可能只在尾部给一个多行 JSON result blob。后者不会携带工具过程，因此 adapter 在启动前记录当前 session JSONL 的文件偏移，运行期间只读取新增记录；resume 不会重放前几轮历史。parser 用最终 blob 校正缺失的文本和总 usage。旧版若先输出原生 NDJSON，则以 stdout 为过程事件源并忽略 transcript，避免重复。

`--thinking` 控制 OpenClaw 的 thinking level。OpenClaw 明文落入 transcript 的 `thinking` block 映射为带 provider provenance 的 `public_reasoning`，并与同一 assistant record 的工具调用共享 `stepId`；adapter 不读取 `thinkingSignature`，provider 未写出明文 thinking 时也不伪造内容。

## CLI Example

先确认本机命令可用：

```bash
pnpm cli adapter probe openclaw
```

创建绑定 OpenClaw provider agent `main` 的 Octo Harness Agent：

```bash
pnpm cli agent create \
  --name openclaw-local \
  --adapter openclaw \
  --provider-agent main \
  --thinking medium \
  --timeout-seconds 300
```

`--model provider/model` 可选。OpenClaw 的认证、provider 和 agent workspace 仍由 OpenClaw 自己的配置负责。随后使用普通 `chat create/chat send` 或 Trigger -> Task 流程，上层不需要 OpenClaw 专用分支。

## Deliberate Limits

- 不实现 Gateway/WS transport、device auth、Gateway reconnect 或 plugin sync。
- 不从 Octo Harness workdir 注入 skills；skills 是 OpenClaw agent 配置能力，不是 Run 汇报协议。
- 不实现 session fork 文件复制；当前只声明 `session.serialize`，不声明 `session.fork`。
- 当前进程取消依赖 Node `AbortSignal` 终止 CLI；生产环境应升级为进程组终止和分级 `SIGTERM/SIGKILL` 回收。
- 契约测试使用 fake OpenClaw，不调用真实模型。2026-09-08 本机 `OpenClaw 2026.7.1-2` 完成真实 Harness Run 验证，覆盖两轮 model step、公开 reasoning、`exec` tool lifecycle、final text 和 usage。
