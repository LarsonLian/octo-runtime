# @mininglamp-oss/octo-harness-adapter-host

Octo Harness 的 adapter registry、调用生命周期和 NDJSON JSON-RPC host。它把 Core 的统一请求路由到具体 adapter，并保证消息生命周期、取消与 terminal event 规则一致。

## 作用

- 注册、枚举和 probe adapter。
- 校验 `InvokeRequest` 与 adapter 输出的 canonical event。
- 为缺失的 `message.create/update` 补齐生命周期和稳定 message ID。
- 用 `AbortController` 把 `cancel(invocationId)` 传播到 provider adapter。
- 提供进程内 `AdapterHost`、stdio RPC client/server，以及独立 host 子进程启动器。

## 设计原则

1. **统一生命周期**：adapter 即使只发送 delta，上层也能看到完整 message 与唯一 run terminal。
2. **Adapter 故障止于边界**：非法事件、异常退出和 cleanup error 被转换成明确的 `run.error/stopped`。
3. **调用与传输解耦**：Core 依赖 `invoke/list/cancel` 契约，不依赖 NDJSON 实现。
4. **长任务使用事件推送**：RPC 先 ACK invocation，再通过 notification 流式发送事件。
5. **动态加载必须校验**：app 读取 manifest 后验证 module export 和 adapter 形状。

## 适用场景

- 在同一进程中组合多个 adapter 做测试或嵌入式运行。
- 将 provider adapters 放入独立 Node.js host 进程，避免 Core 直接依赖各 CLI。
- 为未来 WebSocket/P2P transport 复用相同 host 语义。

独立进程不是安全 sandbox。当前一个 adapter-host 内的 adapters 仍共享 Node.js 进程和宿主账号，强隔离需要容器、独立用户或每 adapter 独立进程。

## 进程内示例

```ts
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { codexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";
import type { InvokeRequest } from "@mininglamp-oss/octo-harness-protocol";

const host = new AdapterHost();
host.register(codexAdapter);

const request: InvokeRequest = {
  invocationId: "invoke-1",
  sessionId: "session-1",
  runId: "run-1",
  prompt: "Inspect this repository",
  workdir: process.cwd(),
  appendInstructions: "",
  context: {},
  agentConfig: {}
};

for await (const event of host.invoke("codex", request)) {
  console.log(event.type, event.payload);
}
```

跨进程启动使用 `spawnAdapterHost({ entrypoint, manifest })`。RPC 顺序见 [Transport And Multi-node](../../docs/09-transport-and-multinode.md)。
