# @mininglamp-oss/octo-harness-adapter-sdk

Octo Harness 的 adapter authoring SDK。它提供 adapter 契约、CLI probe、NDJSON 子进程执行、JSON 行解析、错误封装和常见 canonical event 流程，减少各 provider adapter 的重复代码。

## 作用

- 用 `defineAdapter` 检查并冻结 adapter 定义。
- 用 `probeCommand` 在当前 `PATH` 中检查 provider executable。
- 用 `spawnJsonLines` 运行一次 invocation 对应的 CLI 子进程并流式读取 stdout。
- 用 `createJsonCliAdapter` 组合命令构造、原生事件归一化、取消和 cleanup。
- 统一抛出带退出状态的 `ProviderProcessError`。

## 设计原则

1. **Adapter 只处理 provider 差异**：命令、权限、session codec 和 native event mapping 留在 adapter 内。
2. **一行一个原生事件**：通用 runtime 只负责读取，具体 adapter 决定如何解析和忽略噪声。
3. **Prompt carrier 显式**：用户 prompt、control instructions、环境变量和临时配置由 adapter 分别映射。
4. **取消走 AbortSignal**：上层 Transport 不需要知道 provider 的进程模型。
5. **清理必达**：临时目录和 shadow config 在成功、失败、取消后都进入 `finally`。

## 适用场景

- provider CLI 支持 JSON/JSONL/NDJSON 流式输出。
- 新建 Octo Harness provider adapter 并接入统一 host。
- 为 command builder 和 native event normalizer 编写无模型契约测试。

如果 provider 使用双向 JSON-RPC、WebSocket 或常驻 daemon，可继续实现 `Adapter` 接口，但不必使用 `createJsonCliAdapter`。

## 最小 Adapter

```ts
import {
  createJsonCliAdapter,
  probeCommand,
  type CanonicalEvent
} from "@mininglamp-oss/octo-harness-adapter-sdk";

interface NativeEvent {
  type?: string;
  text?: string;
}

export const exampleAdapter = createJsonCliAdapter<NativeEvent>({
  metadata: { type: "example", capabilities: [] },
  probe: () => probeCommand("example-cli"),
  buildCommand: request => ({
    command: "example-cli",
    args: ["--json"],
    cwd: request.workdir,
    input: request.prompt
  }),
  normalize: (native): CanonicalEvent[] =>
    native.type === "text"
      ? [{ type: "message.delta", payload: { text: native.text ?? "" } }]
      : [],
  onSuccess: () => [
    { type: "message.update", payload: { status: "completed" } },
    { type: "run.finished", payload: {} }
  ]
});
```

注册、测试和文档要求见 [Adapter 开发指南](../../docs/08-adapter-authoring.md)。
