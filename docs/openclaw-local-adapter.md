# OpenClaw Local Adapter

`openclaw` adapter 是 local-only 实现。它参考 Aily `adapter-oc-local` 的 local transport，但没有复制 Gateway 管理、插件同步和 Aily skill materialization：每次 Orbtex invocation 都启动一个 `openclaw agent --local` 子进程，结束后回收进程和临时 prompt 文件。

## Invocation Lifecycle

```text
InvokeRequest
  -> mint/reuse providerSession.sessionId
  -> compose control instructions + user request
  -> write mode 0600 temporary message file
  -> spawn openclaw agent --local --json --session-id ... --message-file ...
  -> parse NDJSON events and optional pretty-printed final JSON blob
  -> emit canonical session/message/tool/usage/run events
  -> remove temporary directory
```

adapter 不连接 `ws://127.0.0.1:<gateway-port>`，不执行 `openclaw gateway install/restart`，也不要求常驻 Gateway。`adapter probe openclaw` 只检查 `openclaw` 可执行文件。

## Session Continuity

首次 invocation 生成 `orbtex-<uuid>`，并立即上报：

```json
{
  "type": "session.update",
  "payload": {
    "providerSession": {
      "sessionId": "orbtex-...",
      "resumable": true,
      "agentId": "main"
    }
  }
}
```

Core 把这个 opaque provider session 保存到 Harness Session。Chat 下一轮或 Task continuation 再把它放入 `InvokeRequest.providerSession`，adapter 仍传相同的 `--session-id`。OpenClaw 自己负责读取 state dir 中的 session JSONL；Orbtex 不把 transcript 复制到 workdir。

## Prompt And Workdir

OpenClaw local CLI 没有独立的 system-prompt 参数。adapter 因而把两类内容明确分段后放入同一个临时文件：

```text
[Harness Instructions]
<daemon-owned context and per-turn control>

[User Request]
<user prompt>
```

这是一种兼容投影，不等价于模型 API 的 system role。临时目录尽量设为 `0700`，文件设为 `0600`，prompt 不进入 argv，invocation 完成或失败后都会清理。

cwd 与 Aily local 路径保持相同方向：优先 `OPENCLAW_STATE_DIR`，其次 `OPENCLAW_CONFIG_PATH` 所在目录，再到 `HOME`。原因是 OpenClaw 的 agent workspace、plugin 和相对路径由 OpenClaw 配置管理；Orbtex Agent 的 `workdir` 不应偷偷改写 OpenClaw 的 state root。要让 OpenClaw 操作某个代码目录，应在相应 OpenClaw agent 配置中设置 workspace。

## Native Event Mapping

| OpenClaw output | Canonical event |
|---|---|
| `text` | `message.delta(channel=final)` |
| `tool_use` | `tool_call.create` |
| `tool_result` | `tool_call.update(completed/error)` |
| `step_finish.usage` | `usage.update` |
| final blob `meta.agentMeta.sessionId` | `session.update` when changed |
| final blob `payloads[].text` | reconcile missing delta, then `message.update` |
| clean exit | `run.finished` |
| provider error/non-zero exit | `run.error` |
| host abort/lifecycle cancelled | `run.stopped` |

OpenClaw 2026.x 的 `--json` 输出可能是逐行 NDJSON，也可能在尾部给一个多行 JSON result blob。parser 同时处理两种形态，并用最终 blob 校正缺失的文本；usage 相同则不重复上报。

`--thinking` 控制 OpenClaw 的 thinking level，但当前已验证 local wire shape 没有独立 reasoning event。adapter 不伪造隐藏思维内容；未来若 OpenClaw 暴露稳定的 thought event，应映射为 `message.delta(channel=analysis)`，并受可见性和保留策略控制。

## CLI Example

先确认本机命令可用：

```bash
pnpm cli adapter probe openclaw
```

创建绑定 OpenClaw provider agent `main` 的 Orbtex Agent：

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
- 不从 Orbtex workdir 注入 skills；skills 是 OpenClaw agent 配置能力，不是 Run 汇报协议。
- 不实现 session fork 文件复制；当前只声明 `session.serialize`，不声明 `session.fork`。
- 当前进程取消依赖 Node `AbortSignal` 终止 CLI；生产环境应升级为进程组终止和分级 `SIGTERM/SIGKILL` 回收。
- 合同测试使用 fake OpenClaw，不调用真实模型。2026-08-28 本机 `OpenClaw 2026.7.1-2` 的 executable probe 通过，尚未把真实模型调用冒充为已验证结果。
