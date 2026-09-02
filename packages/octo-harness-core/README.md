# @mininglamp-oss/octo-harness-core

Octo Harness 的领域模型与执行引擎。它管理 Agent、Chat/Task Session、Trigger、Occurrence、Attempt、Run、事件流和 provider session binding，但不负责启动 daemon 或解析任何 provider CLI 输出。

## 作用

- 注册 Agent，并验证对应 adapter 已由 host 加载。
- 创建 Chat session，或把 Trigger 幂等物化为 Task session。
- 把 Chat turn 和 Task attempt 统一排队为 Run。
- 生成可移植 harness context/control instructions，调用 `HarnessHost` 并持久化 canonical events。
- 提供内存 store 和单机 JSON 文件 store 参考实现。

## 设计原则

1. **Chat 与 Task 在 Run 层统一**：两者共享执行、事件、取消和 provider session；Task 额外拥有 Trigger 与 Attempt。
2. **Core 不认识 provider**：新增 adapter 不应在 Core 中增加 `if adapterType === ...`。
3. **Trigger 幂等**：`triggerId + externalEventId` 只物化一个 occurrence/task。
4. **Provider session 旁路持久化**：恢复标识不写进用户文本，也不由 Core 解释。
5. **状态先于执行**：queued/running/terminal 状态和事件均通过 Store 明确提交。

## 适用场景

- 在自定义 daemon、桌面应用或测试进程中复用 Octo Harness 的 Chat/Task 建模。
- 替换控制面 transport 或持久层，而不重写 Agent 执行语义。
- 用 `MemoryStore` 编写快速契约测试，或用 `JsonFileStore` 运行单机 reference deployment。

本包不提供网络服务、长期调度、进程隔离或多节点 lease。生产部署应通过单独 app 组装，并替换 reference JSON store。

## 使用示例

```ts
import { HarnessEngine, MemoryStore } from "@mininglamp-oss/octo-harness-core";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { codexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";

const host = new AdapterHost();
host.register(codexAdapter);

const store = new MemoryStore();
const engine = new HarnessEngine({ store, host });
const agent = await engine.registerAgent({
  name: "demo",
  adapterType: "codex",
  config: { workdir: process.cwd(), sandbox: "read-only" }
});

const chat = await engine.createChatSession({ agentId: agent.id });
await engine.sendChat(chat.id, "Explain the current project");
```

完整领域关系见 [Architecture](../../docs/01-architecture.md)。
