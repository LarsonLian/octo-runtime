# @orbtex-ai/adapter-host-app

Orbtex 的独立 adapter 执行进程。它从 manifest 动态加载多个 provider adapter，并通过
stdin/stdout NDJSON JSON-RPC 向 daemon 提供统一的 `list`、`probe`、`invoke` 和 `cancel`
能力。

## 架构约束

**adapter-host 是 Orbtex 的必要架构边界，不得为了减少一个进程而把 provider adapters
直接加载进 daemon。**

必须保持以下依赖和运行方向：

```text
CLI
  -> Unix socket
daemon（状态、调度、恢复）
  -> stdio NDJSON JSON-RPC
adapter-host（插件加载、调用生命周期）
  -> n 个 adapter 模块
  -> adapter 自行连接 provider（当前多数每 invocation 启动 CLI 子进程）
```

这里的 `n 个 adapter` 是加载到同一个 adapter-host 进程中的 Node.js 模块，不是 n 个
常驻 adapter 进程。Codex、Claude Code 等 provider CLI 通常在 invocation 开始时启动，
结束后退出。

当前单机拓扑是一个 daemon 启动一个长驻 adapter-host，该 host 加载 manifest 中的全部
adapter。它不是每 workspace、每 adapter 或每 invocation 一个 host。

daemon 不得直接依赖或 import `@orbtex-ai/orbtex-adapter-*`。新增 provider 时，应增加
adapter package、更新 [adapter manifest](../../config/adapters.json)，并让本 app 负责动态加载。

## 为什么必须保留 Host

### 1. 保护有状态控制面

daemon 持有 Task、Run、Trigger、恢复逻辑和持久化 Store。adapter 则包含动态模块、第三方
依赖、provider CLI 子进程和 native event parser，故障概率与资源行为更不可控。

独立进程避免 adapter 加载失败、未捕获异常或执行层崩溃直接成为 daemon 进程内的异常。
daemon 可以检测 RPC 断开，并将受影响的 Run 收敛为明确的 error。

### 2. 固定插件协议

daemon 只面向 provider-neutral 的 `list/probe/invoke/cancel` 契约，不包含
`if (adapterType === "codex")` 一类 provider 分支。host 根据 `adapterType` 路由到具体
adapter，并把 canonical event stream 返回给 daemon。

这个边界允许 adapter 独立增加、替换和升级，而不改变 Task/Chat/Run 领域模型。

### 3. 统一调用生命周期

通用 [adapter-host library](../../packages/orbtex-adapter-host/README.md) 在执行边界负责：

- 校验 `InvokeRequest` 和 canonical event；
- 补齐 message create/update 与稳定 message ID；
- 保证每个 invocation 只有一个 terminal event；
- 把 `cancel(invocationId)` 转换为 adapter 的 `AbortSignal`；
- 把异常退出、cleanup error 和无 terminal stream 收敛为明确事件。

这些规则不能分散复制到 daemon 或每个 provider adapter。

terminal lifecycle 有两层责任：连接正常时，host 保证 adapter event stream 只产生一个
terminal event；host 在 terminal 前失联时，RPC client 会让 pending invocation 失败，
daemon 再为尚未终态的 Run 持久化 `run.error`。已经终态的 Run 不会被重复终态化。

### 4. 解耦 daemon 与 Adapter 运行时

provider adapters 当前运行在 Node.js 中，而 daemon 将来可以迁移到 Go、Rust 或其他运行时。
只要保留 daemon 与 adapter-host 之间的 RPC 契约，adapter 生态不需要随 daemon 重写或与
daemon 使用相同的发布周期。

## 隔离边界

adapter-host 保护的是 daemon，不是完整安全 sandbox。当前所有 adapter 模块仍共享：

- 同一个 adapter-host Node.js 进程；
- 同一个宿主用户和文件系统权限；
- 同一个 host 崩溃域。

这里的故障模型是可信但可能有 bug 的 adapter。一个 adapter 导致 host 进程崩溃时，可能
影响该 host 中其他活动 invocation，但普通 host 进程崩溃不会直接终止 daemon 进程。这个
边界不防御恶意 adapter、同用户文件破坏、信号攻击、凭据读取或整机资源耗尽。

当前也没有进程组级 child reaping 保证。adapter-host 异常崩溃或被强制终止时，活动 provider
CLI 子进程可能继续存活，而 daemon 已将对应 Run 标记为 error。需要严格保证 workspace 不再
被后台进程修改时，必须补充 provider process-group 监督、退出确认和孤儿进程清理。

需要更强隔离时，应演进为每 adapter 或每 invocation 独立进程、容器或受限系统用户，而
不是把 adapter 内联回 daemon。

## 当前监督与恢复

- daemon 启动 host 后先执行 `list` 握手；host 无法加载 manifest 或响应时，daemon 启动失败。
- host stdout 关闭或 RPC 解析失败时，所有 pending request 和 invocation 都会 reject。
- `HarnessDaemon` 捕获执行错误，并把仍未终态的 Run 持久化为 `run.error`。
- 当前 daemon 不会自动重启 adapter-host，也不会重放中断的 invocation；恢复需要重启 daemon。
- daemon 的关闭流程先停止调度并等待 Unix server 关闭，然后向 host 发送 SIGTERM；host
  超时未退出时会被 SIGKILL。现有 socket（例如未完成的 `run.wait`）可能拖住 server 关闭，
  使流程尚未进入 host 终止阶段；当前也不保证活动 provider CLI 随 host 一起退出。

## 模块职责

| 模块 | 负责 | 不负责 |
|---|---|---|
| `apps/adapter-host` | manifest 读取、动态 import、adapter 形状校验、启动 RPC server | Task/Run 状态和调度 |
| `packages/orbtex-adapter-host` | registry、invoke/cancel 生命周期、RPC client/server、host 子进程管理 | 选择部署 manifest |
| `packages/orbtex-adapter-*` | provider 命令、session 恢复、native event 到 canonical event 映射 | 全局 Run 状态 |
| `apps/daemon` | Store/Core/Daemon/Host client 装配、Unix socket 控制面 | 直接加载 provider adapter |

## 允许重新评估的条件

只有在正式架构决策同时满足以下条件时，才可重新评估独立 host：

1. 明确放弃或替代 daemon 与 provider 执行层的进程隔离；
2. 为动态插件加载、取消、流式事件和 terminal lifecycle 提供等价边界；
3. 为可信 adapter 的加载失败、执行异常和进程崩溃提供等价的 daemon 故障隔离与 Run 收敛；
4. 更新模块依赖、运行拓扑、运维文档和跨进程契约测试。

单纯为了减少一次 IPC、一个进程或少量启动时间，不构成移除 adapter-host 的理由。

## 启动与验证

通常由 daemon 自动启动本 app。也可以在仓库根目录独立运行：

```bash
pnpm host
```

直接运行 workspace app：

```bash
pnpm --filter @orbtex-ai/adapter-host-app start
```

daemon 运行时可验证 host 握手和已加载 adapters：

```bash
pnpm cli status
pnpm cli adapter list
```

跨进程 RPC、崩溃和 lifecycle 契约由仓库测试覆盖：

```bash
pnpm test
```

相关架构与传输说明见 [Current Modules And Transport Flow](../../docs/02-module-and-transport-flow.md)
和 [Pnpm Monorepo](../../docs/03-monorepo.md)。
