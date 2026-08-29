# @orbtex-ai/orbtex-protocol

Orbtex 的 provider-neutral 协议包。它定义 Core、Adapter Host 和所有 provider adapter 共同使用的 `InvokeRequest`、`CanonicalEvent`、`EventEnvelope`、provider session 与 capability 类型。

## 作用

- 把 Codex、Claude Code、CodeBuddy、OpenCode、OpenClaw 的原生输出收敛为稳定事件。
- 为一次调用提供统一输入，包括 harness session、run、prompt、workdir、控制指令和取消信号。
- 用 `EventEnvelope` 为事件补充 `runId`、`sessionId`、序号和时间戳。
- 提供运行时边界校验，避免动态 adapter 用错误对象污染 Core。

## 设计原则

1. **Provider-neutral**：协议中不出现某个 CLI 的原生事件名或命令参数。
2. **Transport-neutral**：同一消息模型可承载在进程内调用、NDJSON stdio 或未来 WebSocket 上。
3. **终态唯一**：一次 run 最终只能收敛为 `run.finished`、`run.error` 或 `run.stopped`。
4. **Session opaque**：Core 只持久化 provider session，不解释 provider 私有字段。
5. **编译期与运行时双校验**：TypeScript 类型服务内部调用，assert 函数保护动态插件边界。

## 适用场景

- 编写新的 Orbtex adapter 或 host transport。
- 消费统一的 message、tool call、usage、surface 和 run 事件。
- 将本地 adapter-host 接到远端控制面，同时保持上层领域逻辑不变。

不适合直接表达 provider 的完整私有协议；无法统一的字段应保留在 adapter 内，必要时放入允许扩展的 payload 或 provider session。

## 使用示例

```ts
import {
  assertCanonicalEvent,
  envelope,
  isTerminal,
  type CanonicalEvent,
  type InvokeRequest
} from "@orbtex-ai/orbtex-protocol";

const event: CanonicalEvent = {
  type: "message.delta",
  payload: { channel: "final", text: "done" }
};

assertCanonicalEvent(event);
const stored = envelope({ id: "run-1", sessionId: "session-1" }, 1, event);
console.log(stored.seq, isTerminal(event));
```

事件生命周期和 JSON-RPC 映射见 [Architecture](../../docs/architecture.md) 与 [Transport And Multi-node](../../docs/transport-and-multinode.md)。
