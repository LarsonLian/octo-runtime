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

### Tool call 原始输入

工具输入属于 canonical protocol 的正式合同，不是 UI 推导字段：

- 非分片 provider 在 `tool_call.create.payload.args` 中发送完整结构化输入；命令工具的原始指令位于 `args.command`。
- 分片 provider 可以先用空 `args` 创建工具，再按同一 `id` 发送多个 `tool_call.delta.payload.argsDelta`。consumer 必须按事件顺序拼接全部 JSON 字符串，完整后只解析一次。
- `tool_call.update` 只关闭 lifecycle 并携带最终 `status/output/error`，不能用 output 反推或覆盖输入。

canonical event ledger 保存原始输入用于执行追踪；向产品 surface 投影前必须在服务端完成授权过滤与敏感字段脱敏。

事件生命周期和 JSON-RPC 映射见 [Architecture](../../docs/01-architecture.md) 与 [Transport And Multi-node](../../docs/09-transport-and-multinode.md)。

## 协议真值：JSON Schema + Codegen

数据形状类型不再手写，而是以 `schema/protocol.schema.json`（JSON Schema draft-07，中文 `description`）为唯一来源，生成 `src/generated/protocol-types.ts`：

```text
schema/protocol.schema.json → scripts/gen-types.mjs → src/generated/protocol-types.ts → src/index.ts 组合
```

- **schema 覆盖**：`ProviderSession`、`AgentConfig`、`CanonicalEventPayload`、`ToolCallCreatePayload`、`ToolCallDeltaPayload`、`ToolCallUpdatePayload`、`RunIdentity`、`InvokeRequestWire`、`MessageChannel` 等可 JSON 序列化的结构体。
- **仍手写**（不是纯数据，codegen 无法表达）：`CANONICAL_EVENT_TYPES` 等运行时枚举常量、泛型 `CanonicalEvent<TType>`、以及带 `AbortSignal` 的 `InvokeRequest`（= 生成的 `InvokeRequestWire` 交叉 `signal`）。
- **公共导出面不变**：所有类型名与运行时函数保持原样，消费方无需改动。

为什么选 JSON Schema 而非 Protobuf/Thrift、与手写 TS 的对比、以及为后续 Go/Rust daemon 抽取的意义，见 [Protocol Schema And Codegen](../../docs/10-protocol-schema-codegen.md)。

改协议的流程：

```bash
# 1. 编辑 schema
$EDITOR schema/protocol.schema.json
# 2. 重新生成（build 前自动执行）
pnpm gen
# 3. 构建
pnpm build
```

`src/generated/protocol-types.ts` 由脚本生成、带「勿手改」横幅，任何改动都应通过 schema 完成。
