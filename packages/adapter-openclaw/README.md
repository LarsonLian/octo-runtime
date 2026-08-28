# OpenClaw Local Adapter

Adapter type：`openclaw`

## 它运行在哪里

这是一个 **明确的 local-only OpenClaw CLI adapter**。每次 invocation 都在 adapter-host 所在节点动态启动：

```text
openclaw agent --local --json ...
```

它不连接 OpenClaw Gateway，不执行 Gateway install/restart，不做 device auth，也不管理 Gateway plugin sync。这里的 `--local` 表示 OpenClaw embedded agent 在当前节点运行；模型 provider 仍可能是云 API，本机必须具备相应 provider 凭证。

| 项目 | 当前实现 |
|---|---|
| Process model | 每次 invocation 一个 `openclaw agent --local` 子进程 |
| Native transport | stdout NDJSON 或尾部 pretty JSON blob |
| OpenClaw Gateway | 不使用、不要求常驻 |
| Workdir/cwd | OpenClaw state/config root 语义，不使用 Orbtex task workdir 重定位 |
| Session resume | `--session-id <id>` |
| Prompt carrier | mode `0600` 临时 message file |
| 本机验证版本 | OpenClaw `2026.7.1-2`，2026-08-28 |

## 环境准备

1. 安装 Node.js 20+ 并在 monorepo 根目录执行 `pnpm install`。
2. 安装 OpenClaw CLI，确保 daemon 用户的 `PATH` 能找到 `openclaw`。
3. 配置 OpenClaw agent、workspace、model provider 和 provider API key。

```bash
openclaw --version
openclaw agent --help
```

本地模式要求 provider API key 对启动 daemon/adapter-host 的 shell 可见。Secret 不应写入 Orbtex Agent config、prompt、state JSON 或 workdir。

## 创建 Agent

```bash
cd /absolute/path/to/orbtex
pnpm daemon
```

另一个终端：

```bash
cd /absolute/path/to/orbtex
pnpm cli -- adapter probe openclaw

pnpm cli -- agent create \
  --name openclaw-local \
  --adapter openclaw \
  --provider-agent main \
  --thinking medium \
  --timeout-seconds 300
```

`--provider-agent main` 中的值是 OpenClaw 自己的 agent slug，不是 Orbtex Agent UUID。创建完成后仍使用公共 Chat/Task 命令：

```bash
pnpm cli -- chat create --agent <agent-id> --title "OpenClaw chat"
pnpm cli -- chat send <session-id> --prompt "Inspect the configured workspace"
pnpm cli -- run wait <run-id>
pnpm cli -- run events <run-id>
```

## 可配置项

| `agent create` 参数 | `agentConfig` 字段 | OpenClaw 参数 |
|---|---|---|
| `--provider-agent SLUG` | `providerAgentId` | `--agent SLUG` |
| `--model MODEL` | `model` | `--model MODEL` |
| `--thinking LEVEL` | `thinking` | `--thinking LEVEL` |
| `--timeout-seconds N` | `timeoutSeconds` | `--timeout N` |

程序化创建 Agent 时还可设置 `openclawConfigPath` 和 `openclawStateDir`，分别注入 `OPENCLAW_CONFIG_PATH` 与 `OPENCLAW_STATE_DIR`；公共 CLI 当前没有暴露这两个路径参数。

## 实际命令与 cwd

```text
openclaw agent --local --json \
  --session-id <provider-session-id> \
  [--agent <slug>] \
  [--model <model>] \
  [--thinking <level>] \
  [--timeout <seconds>] \
  --message-file <temporary-file>
```

首次 turn 生成 `orbtex-<uuid>`，后续从 `providerSession.sessionId` 恢复。OpenClaw 自己在 state dir 中持久化 transcript；Orbtex 不把 transcript 复制进 workdir。

cwd 优先级：

```text
OPENCLAW_STATE_DIR
-> dirname(OPENCLAW_CONFIG_PATH)
-> HOME
-> adapter-host process cwd
```

这与 Codex/Claude 的 workdir 模式不同。OpenClaw 的 workspace 和相对 plugin 路径由其 agent 配置拥有；要修改某个代码目录，应在 OpenClaw agent 配置中设置 workspace，而不是期待 Orbtex `--workdir` 覆盖 state root。

## Prompt 与事件

OpenClaw local CLI 没有独立 system prompt 参数。adapter 把 control instructions 和 user request 分段写入临时 message file：

```text
[Harness Instructions]
<control/context>

[User Request]
<user prompt>
```

这只是兼容投影，不等价于 provider 原生 system role。临时目录/文件尽量设置为 `0700/0600`，prompt 不进入 argv，结束后清理。

parser 支持两类 OpenClaw 2026.x 输出：逐行 `text/tool_use/tool_result/step_finish` NDJSON，以及尾部 `payloads + meta.agentMeta` 多行 result blob。它们映射为统一 session、message、tool、usage 和 run events；相同 usage 不重复上报。

当前 wire shape 没有独立 reasoning event。`--thinking` 只控制 provider thinking level，adapter 不伪造或泄露隐藏思维链。

## 取消与限制

`run cancel` 终止当次 local CLI，并收敛为 `run.stopped`；它不会调用 Gateway `sessions.abort`。

当前限制：

- 不支持 Gateway/WS、delivery channel、plugin sync 或 Aily skill materialization。
- 不支持 session file fork，只声明 `session.serialize`。
- 当前取消依赖直接子进程 AbortSignal；生产节点应补进程组 `SIGTERM/SIGKILL` 回收。
- 合同测试使用 fake OpenClaw；本机 executable probe 已通过，但没有执行真实 OpenClaw 模型调用。

实现：[src/index.js](src/index.js) 与 [src/parser.js](src/parser.js)。更完整的设计说明见 [OpenClaw Local Adapter Design](../../docs/openclaw-local-adapter.md)，公共使用流程见 [Adapter Guide](../README.md)。
