# Octo Harness Apps

`apps/` 包含 Octo Harness 的可执行入口。可复用领域逻辑、协议、daemon 调度和 provider adapters
位于 `packages/`，这里负责把它们装配成可直接运行的进程。

| App | 作用 | 入口说明 |
|---|---|---|
| [`cli`](cli/README.md) | 通过 Unix socket 调用 daemon | `apps/cli/dist/index.js` |
| [`daemon`](daemon/README.md) | 本地状态、调度、恢复和 socket 控制面 | `apps/daemon/dist/launcher.js` |
| [`adapter-host`](adapter-host/README.md) | 动态加载 adapters，提供 stdio NDJSON JSON-RPC | `apps/adapter-host/dist/index.js` |
| [`example-basic`](example-basic/README.md) | 不经过 daemon 的进程内 Codex 示例 | `apps/example-basic/dist/index.js` |

## 示例：指定 Codex 并实时查看每个 JSON-RPC 帧

这个例子完成以下流程：

```text
CLI 创建本地 Agent 配置
  -> 创建绑定该 Agent 的 Chat Session
  -> 发送“你是谁？”
  -> daemon 选择 codex adapter
  -> adapter-host 实时返回 JSON-RPC ACK、事件和 done
```

### 重要限制

当前 `agent create/list` 是为了跑通单机 reference implementation 的假 CLI。它只把本地执行
配置写入 `~/.octo-harness/state.json`，不会创建云端 Agent，也不是未来产品合同。目标设计见
[`TODO-0001`](../../docs/todo/TODO-0001-replace-fake-local-agent-cli-with-cloud-control-plane.md)。

这个例子只用于验证当前本地执行链和协议帧。

### 前提

- 在 Octo Harness 仓库根目录执行命令；
- 已执行 `pnpm install` 和 `pnpm build`；
- 已安装并登录 Codex CLI；
- 本机有 `jq`，用于从 CLI JSON 输出中提取 ID。

### 终端 A：启动逐帧 trace

如果 daemon 已经在运行，先按 `Ctrl+C` 停止，再带 trace 环境变量重新启动：

```bash
OCTO_HARNESS_TRACE_RPC=1 pnpm daemon
```

`OCTO_HARNESS_TRACE_RPC=1` 会把 daemon 与 adapter-host 之间实际发送和收到的每一条 NDJSON
JSON-RPC 2.0 frame 写到 daemon 的 stderr。修改这个环境变量后必须重启 daemon。

### 终端 B：创建 Codex Agent 和 Chat

构建完成后直接运行 CLI 入口，避免每条 `pnpm cli` 命令都重复 build：

```bash
node apps/cli/dist/index.js adapter probe codex

AGENT_ID=$(node apps/cli/dist/index.js agent create \
  --name codex-frame-demo \
  --adapter codex \
  --workdir "$PWD" \
  --sandbox read-only | jq -r '.id')

SESSION_ID=$(node apps/cli/dist/index.js chat create \
  --agent "$AGENT_ID" \
  --title "Codex frame demo" | jq -r '.id')

node apps/cli/dist/index.js chat send "$SESSION_ID" \
  --prompt "你是谁？请只用一句中文回答。" \
  --follow
```

这里真正决定使用 Codex 的参数是：

```text
--adapter codex
```

当前实现先把 `adapterType=codex` 保存到本地 Agent 配置，再由 Chat Session 绑定
`AGENT_ID`。daemon 创建 Run 时解析这条绑定，并发出包含以下字段的 `invoke` request：

```json
{
  "jsonrpc": "2.0",
  "method": "invoke",
  "params": {
    "adapterType": "codex",
    "request": {
      "prompt": "你是谁？请只用一句中文回答。"
    }
  }
}
```

它不会自动选择 Claude Code。只有创建另一条配置并显式传入
`--adapter claude-code`，对应 Session 才会使用 Claude Code adapter。

### 终端 B：观察 CLI 结果

带 `--follow` 时，CLI stdout 使用一行一个 JSON 的 NDJSON，先显示带 Agent/provider 信息的
ACK，再显示每个 canonical event，最后显示 `done`：

```jsonl
{"kind":"ack","result":{"accepted":true,"sessionId":"session_...","runId":"run_...","agent":{"id":"agent_...","name":"codex-frame-demo","adapterType":"codex"}}}
{"kind":"event","event":{"seq":1,"type":"run.queued","payload":{"sourceType":"chat"},"runId":"run_..."}}
{"kind":"event","event":{"seq":2,"type":"run.running","payload":{},"runId":"run_..."}}
{"kind":"event","event":{"seq":5,"type":"message.delta","payload":{"text":"我是 Codex..."},"runId":"run_..."}}
{"kind":"event","event":{"seq":8,"type":"run.finished","payload":{},"runId":"run_..."}}
{"kind":"done","result":{"done":true,"run":{"id":"run_...","status":"completed"},"nextSeq":9}}
```

不需要再执行 `run wait`。如果已经有一个 `runId`，也可以单独流式回放并继续跟随：

```bash
node apps/cli/dist/index.js run stream <run-id>
```

### 终端 A：观察原始 JSON-RPC 帧

启用 `OCTO_HARNESS_TRACE_RPC=1` 的 daemon 会同时随着 provider 执行实时出现：

```text
[octo-harness rpc daemon -> adapter-host] {"jsonrpc":"2.0","id":"...","method":"invoke","params":{"adapterType":"codex",...}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","id":"...","result":{"invocationId":"..."}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","method":"invoke.event","params":{"event":{"type":"message.create",...}}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","method":"invoke.event","params":{"event":{"type":"session.update",...}}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","method":"invoke.event","params":{"event":{"type":"message.delta",...}}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","method":"invoke.event","params":{"event":{"type":"usage.update",...}}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","method":"invoke.event","params":{"event":{"type":"run.finished","payload":{}}}}
[octo-harness rpc adapter-host -> daemon] {"jsonrpc":"2.0","method":"invoke.done","params":{"invocationId":"..."}}
```

同一个 `SESSION_ID` 可以继续发送下一轮，Octo Harness 会把已保存的 opaque provider session 交回
Codex adapter 用于 resume：

```bash
node apps/cli/dist/index.js chat send "$SESSION_ID" \
  --prompt "你刚才是怎么回答的？" \
  --follow
```

仍然不需要 `run wait`。CLI 在终端 B 输出 canonical events，原始 RPC 帧继续出现在终端 A。

### 哪些内容不会显示为 JSON-RPC

- CLI 与 daemon 之间使用 Unix socket 上的一行 JSON request/response，不是 JSON-RPC 2.0。
- Codex CLI 自身输出 JSONL native events，也不是 JSON-RPC 2.0。
- 这里展示的是 daemon 与 adapter-host 之间的 Octo Harness JSON-RPC 边界。

trace 会完整打印 prompt、workdir、Agent config、tool event 和模型输出。不要在共享终端、公开
日志或包含 secret 的请求上开启。

## 进一步阅读

- [CLI](cli/README.md)
- [Daemon](daemon/README.md)
- [Adapter Host](adapter-host/README.md)
- [Operations](../docs/07-operations.md)
- [Current Modules And Transport Flow](../docs/02-module-and-transport-flow.md)
