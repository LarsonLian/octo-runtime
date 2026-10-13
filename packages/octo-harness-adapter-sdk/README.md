# @mininglamp-oss/octo-harness-adapter-sdk

Octo Harness 的适配器开发 SDK。多数 provider CLI 的形态一致——接收一段输入、按行输出 JSON——本包将这类适配器的通用流程（启动子进程、按行读取、解析、取消、清理）沉淀为若干工具函数，使适配器作者只需实现 provider 特有的部分。

## 定位与职责

若每个 provider 适配器都从零实现，将反复出现相同的样板代码：启动子进程、按行读取 stdout、将 `AbortSignal` 接入进程终止、确保临时文件在成功/失败/取消后均被清理、在退出码非零时报错等。

本 SDK 将这些通用逻辑封装为工具函数。接入一个“JSON 流式 CLI”型 provider 时，适配器作者真正需要实现的仅有三处 provider 特有逻辑：如何构造命令、如何将原生事件翻译为 `CanonicalEvent`、以及结束时补充何种终态。

## 工作原理

`createJsonCliAdapter` 固定通用流程，并将 provider 差异保留为若干回调：

```mermaid
flowchart TD
    Req[InvokeRequest] --> Build[buildCommand<br/>作者实现：命令 + 参数 + 输入]
    Build --> Spawn[spawnJsonLines<br/>SDK：启动子进程并按行读取 stdout]
    Spawn --> Line{每一行}
    Line --> Norm[normalize<br/>作者实现：原生事件 → CanonicalEvent]
    Norm --> Out[(canonical 事件流)]
    Spawn -->|正常结束| Success[onSuccess<br/>作者实现：补充 message.update / run.finished]
    Success --> Out
    Spawn -->|非零退出| Err[ProviderProcessError<br/>SDK：带退出状态抛出]
    Note[取消：AbortSignal 终止子进程<br/>清理：临时目录/影子配置在 finally 中必达]
```

若干约定：

1. **适配器只处理 provider 差异**：命令、权限、会话编解码与原生事件映射均留在适配器内，通用运行时不予涉及。
2. **一行一个原生事件**：运行时仅负责按行读取，如何解析、忽略哪些噪声由 `normalize` 决定。
3. **prompt 载体显式**：用户 prompt、控制指令、环境变量与临时配置由适配器分别映射（以 `providerInputText(request)` 取应发送给模型的文本）。
4. **取消经由 AbortSignal，清理经由 `finally`**：成功、失败、取消三种路径均会执行清理。

## 使用

一个最小适配器：

```ts
import {
  createJsonCliAdapter,
  probeCommand,
  providerInputText,
  type CanonicalEvent
} from "@mininglamp-oss/octo-harness-adapter-sdk";

interface NativeEvent { type?: string; text?: string; }

export const exampleAdapter = createJsonCliAdapter<NativeEvent>({
  metadata: { type: "example", capabilities: [] },
  probe: () => probeCommand("example-cli"),
  buildCommand: request => ({
    command: "example-cli",
    args: ["--json"],
    cwd: request.workdir,
    input: providerInputText(request)
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

## 约束与注意事项

- 仅适用于“一次调用对应一个 CLI 子进程、且以 JSON/JSONL 流式输出”的 provider。
- 若 provider 使用双向 JSON-RPC、WebSocket 或常驻 daemon（如 Codex app-server、CodeBuddy 的 ACP），则不应使用 `createJsonCliAdapter`，而应直接实现 `Adapter` 接口，可参考 codex / codebuddy 适配器。

## 相关文档

- 注册、测试与文档要求：[Adapter 开发指南](../../docs/08-adapter-authoring.md)

## 模块责任边界

- 负责：提供适配器共用的进程、流解析和事件辅助工具。
- 不负责：Daemon 生命周期、IM/Worker 接入。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
