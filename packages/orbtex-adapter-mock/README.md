# @orbtex-ai/orbtex-adapter-mock

Orbtex deterministic test adapter。

Adapter type：`mock`

## 作用

提供不依赖模型、网络、认证或外部 CLI 的确定性 adapter，用于验证 Orbtex 自身的控制面和事件契约。它返回固定 session、message 与 terminal event，便于教程、CI 和故障定位。

## 设计原则

- 输出完全确定，不把模型随机性带入 harness 测试。
- 使用与真实 adapter 相同的 async iterable 和 canonical event 契约。
- 不读取或修改 workdir，不产生外部副作用。
- 不伪装 provider 功能：不会生成虚假的 tool、usage 或权限行为。

## 它运行在哪里

这是一个 **adapter-host 进程内的 deterministic test adapter**。它不启动 CLI、不访问模型、不使用网络、不需要认证，也不读取或修改 workdir。

| 项目 | 当前实现 |
|---|---|
| Process model | adapter-host 进程内 async generator |
| Native transport | 无 |
| Model | 无 |
| Workdir | 接收但不使用 |
| Session | `mock:<harness-session-id>` |
| 输出 | `Handled: <prompt>` |
| 成本 | 不调用模型，无 token 成本 |

## 适用场景

- 验证 daemon、Unix socket、adapter-host manifest 是否能工作。
- 演示 Chat、Trigger、Task、Attempt、Run 和 EventEnvelope 流程。
- 测试幂等、持久化、恢复与 UI event replay。
- 在没有任何 provider CLI/凭证的机器上运行教程。

它不适合验证 provider parser、工具执行、权限、长时间取消、token usage 或模型质量。

## 创建与运行

Mock 不需要 `adapter probe`，host 会把缺少 probe 的 adapter 视为可用但 `unchecked`。

```bash
cd /absolute/path/to/orbtex
pnpm daemon
```

另一个终端：

```bash
cd /absolute/path/to/orbtex

pnpm cli agent create \
  --name demo \
  --adapter mock \
  --workdir /absolute/path/to/any/existing/directory
```

Chat：

```bash
pnpm cli chat create --agent <agent-id> --title "Mock chat"
pnpm cli chat send <session-id> --prompt "hello"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

事件中的最终文本为：

```text
Handled: hello
```

Trigger -> Task：

```bash
pnpm cli trigger create \
  --name mock-task \
  --kind manual \
  --agent <agent-id> \
  --title "Mock task" \
  --instruction "exercise the task pipeline"

pnpm cli trigger fire <trigger-id> --event-id mock-001
pnpm cli run wait <run-id>
```

## 配置与事件

Mock 忽略 `model`、sandbox、permission mode、thinking 和 provider-specific options。它固定输出：

```text
session.update
message.create
message.delta
message.update
run.finished
```

provider session ID 从 Harness Session ID 确定性生成，因此同一 Chat 或 Task continuation 会得到稳定绑定。

## 限制

- generator 没有等待点，执行通常瞬间完成；不能用它证明执行中的 provider cancel 行为。
- metadata 声明 canonical tool capability，但当前 fixture 不实际产生 tool events。
- 不模拟 stderr、provider failure、usage、analysis、审批或 session fork。
- 生产环境不应创建使用 mock adapter 的真实业务 Agent。

真实 subprocess/ACP 契约测试位于 [../../test](../../test)。实现：[src/index.ts](src/index.ts)。公共使用流程见 [Adapter Guide](../README.md)。
