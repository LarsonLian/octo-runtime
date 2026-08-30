# @orbtex-ai/example-basic

Orbtex 最小的进程内端到端示例。它不启动 daemon、Unix socket 或独立 adapter-host，而是在
一个 Node.js 进程中直接组合 `HarnessEngine`、`MemoryStore`、`AdapterHost` 和 Codex adapter，
用于展示 Orbtex 核心 API 如何协作。

## 作用

这个示例按顺序完成以下流程：

1. 创建进程内 `AdapterHost` 并注册 Codex adapter；
2. 创建不落盘的 `MemoryStore`；
3. 用 Store 和 Host 创建 `HarnessEngine`；
4. 注册一个工作目录为当前目录、sandbox 为 `read-only` 的 Codex Agent；
5. 创建一个 manual Trigger；
6. 触发 `Inspect repository` Task；
7. 等待真实 Codex invocation 完成，并把完整结果输出为 JSON。

对应运行链路：

```text
example-basic 单进程
  -> HarnessEngine
  -> MemoryStore
  -> 进程内 AdapterHost
  -> Codex adapter
  -> Codex CLI 子进程
```

## 它验证什么

- Core 可以脱离 daemon 和 socket 独立运行；
- `HarnessEngine` 只依赖 Store 与 Host 端口；
- Trigger 可以物化 Task、Attempt 和 Run；
- provider native events 可以通过 adapter/host 转换为 canonical events；
- 同一套领域与执行 API 既能用于嵌入式场景，也能由 daemon 装配。

## 它不是什么

本示例不是正式部署拓扑，也不提供：

- JSON 持久化或 daemon 重启恢复；
- 后台队列、interval scheduler 或快速 ACK；
- Unix socket 控制面和 CLI；
- 独立 adapter-host 进程隔离；
- 多用户、多节点或生产级任务调度。

正式本地运行应使用 `apps/daemon`、`apps/adapter-host` 和 `apps/cli`。独立
adapter-host 是正式 daemon 拓扑中的必要架构边界；本示例以内联方式运行只是为了用最少代码
展示 Core API，不构成将正式 daemon 与 adapter 合并的依据。

## 运行前提

- Node.js 20+；
- pnpm 11+；
- 已安装并登录 Codex CLI；
- 当前工作目录允许 Codex 以 `read-only` sandbox 检查。

这个示例会调用真实 provider，可能产生网络请求、模型用量和费用。仓库测试使用 fixture，
不会调用真实模型，两者不要混淆。

## 运行

在 Orbtex 仓库根目录执行：

```bash
pnpm demo
```

也可以在已经完成构建后只运行该 workspace：

```bash
pnpm --filter @orbtex-ai/example-basic start
```

示例将当前 `process.cwd()` 作为 Agent workdir，因此应从希望 Codex 检查的目录启动。根命令
`pnpm demo` 默认检查 Orbtex 仓库本身。

## 输出

程序向 stdout 输出格式化 JSON，其中包含 Trigger occurrence、Task、Attempt、Run 和已持久化到
`MemoryStore` 的 canonical events。进程退出后内存状态全部丢失。

## 修改示例

常见实验入口位于 [`src/index.ts`](src/index.ts)：

- 修改 `task.description` 可以改变实际提示词；
- 修改 Agent `sandbox` 可以验证权限配置；
- 注册其他 adapter 可以验证相同 Core API 下的 provider 替换；
- 将 `MemoryStore` 替换为其他 Store 可以实验持久化实现。

完整领域关系见 [Architecture](../../docs/01-architecture.md)，正式进程拓扑见
[Current Modules And Transport Flow](../../docs/02-module-and-transport-flow.md)。
