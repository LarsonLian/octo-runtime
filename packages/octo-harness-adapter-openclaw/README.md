# @mininglamp-oss/octo-harness-adapter-openclaw

Octo Harness 的 OpenClaw 本地适配器：每次调用在 adapter-host 所在节点临时执行一次 `openclaw agent --local` 子进程，增量消费 OpenClaw session transcript，并将尾部的最终结果 blob 归并为统一的 session / model-step / reasoning / message / tool / usage / run 事件流。

## 定位与职责

OpenClaw 的常规运行方式依赖一个常驻的 Gateway 负责任务收发，涉及安装、启动、设备认证与插件同步。对于“在本节点复用现有 OpenClaw agent 配置、由 Octo Harness 触发单次任务并取回结果”这一场景，接入 Gateway 的成本过高。

本适配器采用另一条路径：完全不接入 Gateway。每次调用在 adapter-host 所在的机器上临时执行

```text
openclaw agent --local --json ...
```

子进程执行结束后即退出。它需要处理的两个核心问题是：

- OpenClaw 2026.x 的 `--json` stdout 通常只在结束时输出最终 blob；thinking、toolCall、toolResult 则增量写入 state dir 下的 session JSONL。
- 最终回复同时出现在 session transcript 和最终 blob 中，直接转发会导致重复。

适配器在本层完成上述归并与去重，向上层交付统一的 session / message / tool / usage / run 事件。

## 工作原理

适配器先将 prompt 写入权限为 `0600` 的临时文件（不经命令行参数传递，避免长文本与控制上下文暴露在 argv 中），生成或复用一个 provider session id，并记录已有 transcript 的文件偏移。启动子进程后并行跟读新增 JSONL 和 stdout，最终统一收尾。

```mermaid
sequenceDiagram
    participant Host as AdapterHost
    participant AD as OpenClaw Adapter
    participant CLI as openclaw agent --local
    participant TR as session transcript JSONL

    Host->>AD: invoke(InvokeRequest, signal)
    AD->>AD: prompt 写入 0600 临时 message file<br/>生成/复用 --session-id
    AD->>CLI: spawn 子进程（绑定 signal）
    loop 增量跟读新增 transcript
        CLI-->>TR: assistant thinking / toolCall / toolResult
        TR-->>AD: 新增 JSONL record
        AD-->>Host: model_step.* / analysis message / tool_call.*
    end
    CLI-->>AD: 尾部 final blob（可能跨多行，累积至可解析）
    AD->>AD: 以 final blob 文本兜底，仅补 transcript 之外的后缀<br/>去重 usage，判定取消 / 失败 / 成功
    AD-->>Host: message.update + 唯一 run 终态
    AD->>AD: finally 删除临时目录
```

关键机制：

1. **local-only，不连接 Gateway**。`--local` 表示 OpenClaw 内嵌 agent 在本节点运行；模型 provider 仍可能是云端 API，因此本机必须能读取到相应的 provider 凭证。适配器不执行 install / restart / device auth / plugin sync。
2. **transcript 提供过程，final blob 校正结果**。每条 assistant record 映射为一个稳定 `model_step`，其中的 thinking、toolCall 共享 `stepId`；后续 toolResult 通过 call id 回挂原阶段。最终以 blob 中的完整文本和总 usage 为准，只补 transcript 尚未发出的文本后缀。
3. **终态唯一**。stdout 关闭后，适配器综合 abort signal、显式的 cancelled / failure 帧以及退出码进行判定：取消归一为 `run.stopped`，失败或非零退出归一为 `run.error`，正常结束归一为 `run.finished`。
4. **session 由 provider 拥有**。首轮生成 `octo-harness-<uuid>` 作为 `--session-id`，后续从 `providerSession.sessionId` 恢复；transcript 由 OpenClaw 自身在 state dir 持久化，Octo Harness 不将其复制进 workdir。

## 使用

启动 daemon 后，先 probe 再创建 Agent：

```bash
pnpm cli adapter probe openclaw

pnpm cli agent create \
  --name openclaw-local \
  --adapter openclaw \
  --provider-agent main \
  --thinking medium \
  --timeout-seconds 300
```

`--provider-agent main` 的取值是 OpenClaw 自身的 agent slug，而非 Octo Harness Agent UUID。此后使用公共 Chat / Task 命令即可：

```bash
pnpm cli chat create --agent <agent-id> --title "OpenClaw chat"
pnpm cli chat send <session-id> --prompt "Inspect the configured workspace"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

可配置项：`--provider-agent`（`--agent`）、`--model`、`--thinking`、`--timeout-seconds`（`--timeout`）。程序化创建时还可设置 `openclawConfigPath` / `openclawStateDir`，分别注入 `OPENCLAW_CONFIG_PATH` 与 `OPENCLAW_STATE_DIR`；这两项当前未由公共 CLI 暴露。

## 约束与注意事项

- **workspace 由 OpenClaw 配置拥有，而非 `--workdir`**：子进程 cwd 按 `OPENCLAW_STATE_DIR` → `dirname(OPENCLAW_CONFIG_PATH)` → `HOME` → adapter-host cwd 的顺序取第一个存在的目录。若需令其操作特定代码目录，应在 OpenClaw agent 配置中设置 workspace，Octo Harness 的 `--workdir` 不覆盖 state root。
- **无独立 system prompt 通道**：适配器将控制指令与用户请求分段写入同一 message file（`[Harness Instructions]` / `[User Request]`），这仅为兼容投影，不等价于 provider 原生 system role。
- **reasoning 来自 OpenClaw transcript**：只有 OpenClaw 明文写出的 `thinking` block 才映射为 `public_reasoning`；thinking level 关闭或 provider 不返回明文时不会伪造内容。adapter 不读取或输出 `thinkingSignature`。
- **兼容旧版 stdout NDJSON**：若 OpenClaw 先输出原生 `text/tool_use/tool_result/step_finish` 帧，则以 stdout 为过程事件源并停止消费 transcript，避免重复。
- **取消为直接子进程 abort**：收敛为 `run.stopped`，不调用 Gateway `sessions.abort`；生产节点应补充进程组 `SIGTERM/SIGKILL` 回收。
- **probe 仅验证 `openclaw` 可执行**：不代表已登录、模型可调用或有额度。契约测试使用 fake OpenClaw，不涉及真实模型调用。

## 相关文档

- 本地适配器设计详解：[OpenClaw Local Adapter](../../docs/06-openclaw-local-adapter.md)
- 事件契约与三层事件模型：[Protocol](../octo-harness-protocol/README.md)
- 各适配器对比与公共流程：[Adapter Guide](../README.md)
- provider 适配器总览：[Provider Adapters](../../docs/05-provider-adapters.md)
