# Octo Runtime

提供 `octo-runtime` 命令的本地 Agent Runtime。要求 Node.js 24 或以上。

```bash
npm install -g @mininglamp-oss/octo-runtime
octo-runtime --help
```

也可以在项目内安装，通过 `npx octo-runtime --help` 调用。

内部模块随 CLI 一起打包、升级，只发布一个 npm 包。第三方插件可使用以下类型与工具入口：

```ts
import type { ExtraPlugin, ExtraContext, CanonicalEvent } from "@mininglamp-oss/octo-runtime/extra";
import { InvokeInput, isTerminal } from "@mininglamp-oss/octo-runtime/protocol";
```

`/extra` 提供完整插件生命周期、声明、JSON 配置、注入执行端口和协议类型；`/protocol` 提供全部协议类型，以及输入检查、Context/事件/帧/交互校验和终态工具。invoke 使用 ctx.adapterHost 注入实例，支持 native/canonical 类型推导。客户 TS 工程局部安装本包及 TypeScript、@types/node，以 NodeNext/ESM 编译为 JS，再通过 extraset 配置入口绝对路径并重启 daemon 加载。

三个内置 Extra 的完整原始 JSON Schema 可从以下公开子路径读取：

- `@mininglamp-oss/octo-runtime/extras/channel-gateway/config-schema.json`
- `@mininglamp-oss/octo-runtime/extras/channel-wecom/config-schema.json`
- `@mininglamp-oss/octo-runtime/extras/webui/config-schema.json`

使用 `import.meta.resolve(上述路径)` 获取本机文件位置，按需读取或交给自己的校验工具。schema 覆盖整个 `{ module, enabled?, config }` 声明，包含字段用途、必填关系、条件约束、当前省略行为及占位示例。Channel 的可选 `context` 只声明固定的 v3 协议标识和 `items` 对象数组；配置后在执行 AgentRun 时固定附带，内部 item 结构遵循 octo-runtime Context v3 协议，此处不展开。schema 不自动填值、不强制校验或引入 Zod；配置来源、模型及校验方式仍由业务方决定，`load` 继续接收原始 JSON 对象。凭据有效性、文件权限、Provider 可用性及 Context 语义继续由运行时校验。

根入口和未声明的内部子路径继续拒绝包名导入；不提供独立宿主 SDK 工厂。此限制不提供源码加密或文件访问隔离。第三方 Adapter 公开入口及 extra_adapters.json 加载仍待实施，不是本版本已有功能。
Provider 程序由宿主或用户另行选择安装，安装此包不会自动下载 Provider。
升级程序保留已有 Runtime Home、身份与配置；已运行的进程需要重启才能使用新版本。

## Direct executor API

Prioritize stability: recommend SDK access over IPC to an independent Executor
Kernel for production hosts, especially Electron. The new Kernel's IPC and
supervision implementation belongs to issue #47; the existing isolated worker
and NDJSON path remain available during the transition. Direct embedding is an
explicit, simpler SDK integration option with a shared host process failure domain.

Import `AgentExecutor` and `HostedAdapter` from
`@mininglamp-oss/octo-runtime/executor-core`. The host explicitly registers its
adapters and owns the instance lifecycle. `invoke` supports native/canonical
output, `invokeFrames` exposes source frames, and `cancel`, `respondInteraction`
and `respondNative` act on the original invocation. No Kernel, IPC endpoint,
cloud identity, Extra or implicit provider installation is required.

Input is snapshotted at invocation creation; admission happens on the first
iterator `next()`. Catch errors around consumption. A visible running receipt
already owns cancellation, even before the Provider starts. Close abandoned
iterators with `return()` or cancel their invocation.

Always inspect `await executor.shutdown()`: `cleanup: "incomplete"` retains
ownership. A subsequent shutdown can observe pending cleanup completing; failed
or unverified iterator cleanup stays incomplete and is not retried via another
`return()`. A rejected `next()` cannot prove finalizer success either. Closed admission
does not prove that resources exited or authorize releasing a host Home lock.
Direct execution shares the host process: process exit, OOM and synchronous
blocking cannot be isolated. Default worker execution over stdio NDJSON remains
available and uses the same Core implementation. Interrupted Runs are never
automatically replayed.

## 许可证

本项目采用 Apache License 2.0，完整条款见随包分发的 `LICENSE` 文件。Copyright 2026 Mininglamp Technology。
随包分发的第三方依赖保留各自许可证与版权声明。
