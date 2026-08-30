# @orbtex-ai/orbtex-daemon

Orbtex 的后台编排 runtime。`HarnessDaemon` 位于 CLI/socket app 与 `HarnessEngine` 之间，负责快速接受工作、异步执行、Trigger 调度、恢复、等待和取消。

## 作用

- 接收 Chat、Trigger 和 Task continuation 请求并快速返回 `runId`。
- 在事件循环后台调用 Core 执行 queued run。
- 匹配 event trigger、运行 interval trigger，并复用 Core 的 occurrence 幂等语义。
- daemon 重启后恢复 queued 工作，并明确终止无法重新附着的 running run。
- 为调用方提供 `waitForRun` 与 `cancelRun`。

## 设计原则

1. **ACK 与执行分离**：控制请求不等待长时间 provider 调用。
2. **恢复必须诚实**：当前没有 `run.reattach` 时，不把已丢失的 provider 进程伪装成仍在运行。
3. **调度不复制领域规则**：Task/Run 状态迁移仍由 Core 负责。
4. **同一 run 只调度一次**：pending map 防止单进程内重复启动。
5. **终态可等待**：同步等待者只在 run 收敛后被唤醒。

## 适用场景

- 本地 Unix socket daemon。
- 桌面端或单节点服务中的轻量后台 worker。
- 验证 Trigger -> Task -> Run 模型与恢复行为。

它不是多节点任务队列：没有数据库 lease、fencing、outbox 或跨节点选主。相关生产化方向见 [Operations](../../docs/07-operations.md)。

## 备注：后续演进方向

当前 `HarnessDaemon` 以 TS 实现，兼顾编排逻辑与 provider/adapter 集成。后续计划把**长驻进程、并发、网络、持久化**这几个方向从 TS 中抽取为独立的 **Go / Rust 二进制**，作为稳定的性能内核；易变的 provider/adapter 集成层继续留在 TS。

两层之间参考 aily-cli 的分层形态，通过跨语言协议（如 stdio JSON-RPC）完成 **daemon -> host -> n\*adapter** 的统一交互：

- **daemon（Go/Rust）**：拥有 socket 入口、并发调度、网络/网关、持久化与恢复，是受信的性能内核。
- **host（TS 子进程）**：加载并驱动多个 adapter，把 daemon 的 invoke 请求分发给具体 provider，事件流式回传。
- **adapter（TS）**：包装各类本地 agent，贴合其 JS-native 集成契约。

这样稳定内核与快速迭代的集成层解耦，代价是引入一条跨语言序列化缝。

## 使用示例

在 app 装配层已经创建 `HarnessEngine` 和同一个 `Store` 后：

```ts
import { HarnessDaemon } from "@orbtex-ai/orbtex-daemon";

const daemon = new HarnessDaemon({ engine, store });
await daemon.recover();

const accepted = await daemon.submitChat(sessionId, "Review this repository");
const terminal = await daemon.waitForRun(accepted.runId);
console.log(terminal);

daemon.stop();
```
