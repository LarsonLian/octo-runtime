---
type: Task
title: Playboard 统一经过 daemon 执行的改造决策
description: 记录绕过 daemon 和重复装配 OpenClaw 的问题，明确临时 daemon、本地 RPC 与资源归属。
tags: [architecture, invoke, ipc, lifecycle, openclaw]
timestamp: 2026-10-15T00:00:00Z
---

# 决策与实施状态

用户已明确：`playboard` 应由 CLI 拉起临时 daemon，通过临时本地 socket 提交执行，结束后销毁本次临时资源；Provider 配置装配复用 daemon 的统一启动流程，不能在 playboard 再实现一套 OpenClaw 连接管理。

初次记录仅包含源码核对、问题复盘和目标合同。用户随后授权在当前分支实施；2026-10-15 当前工作树已改为临时 daemon + 本地执行 IPC，移除 playboard 的 OpenClaw 配置分支，隔离运行状态并跳过 Extra 装配。相关规则及 CLI/接入说明已同步。[实施验证记录](../../journal/shared/2026-10-15-playboard-daemon-execution.md)区分自动化、真实 Provider 和线上环境检查；Windows 尚未实机验收。

# 改造前实现事实

以下为 2026-10-15 改造前的源码核对结果，用于解释改造原因，不描述修改后的调用链。

```text
CLI playboard
  → 读取 stdin JSON，prepareInvokeInput
  → 若 adapterType=openclaw，configureCliOpenClaw 并注入 profile root
  → spawnAdapterHost
  → AdapterHostRpcClient（子进程 stdin/stdout）
  → AdapterHost → Provider Adapter → Provider
  → 输出事件，finally 关闭本次 adapter-host
```

- [playboard.ts](../../../apps/cli/src/playboard.ts) 直接启动独立 adapter-host，没有启动或复用 daemon。已有 daemon 是否运行不影响这条路径；已有 daemon 运行时仍会另起 adapter-host。
- [process.ts](../../../packages/octo-runtime-adapter-host/src/process.ts) 启动子进程，使用 `AdapterHostRpcClient` 并通过 `list` 等待 Host 就绪。当前不是在 CLI 进程内直接调用 Host 的模拟执行。
- [daemon 启动入口](../../../apps/daemon/src/index.ts) 已负责 profile 的 OpenClaw 初始化、连接可用性探测及相应启动装配，再启动 daemon server。
- [daemon server](../../../packages/octo-runtime-daemon/src/server.ts) 管理共享 adapter-host、按 profile 选择执行配置、执行账本及 Host 故障恢复。playboard 绕过了这些步骤。
- [OpenClaw 启动配置](../../../apps/daemon/src/openclaw.ts) 解析并保存连接快照；[OpenClaw Adapter](../../../packages/octo-runtime-adapter-openclaw/src/index.ts) 消费连接并访问 Gateway。Octo daemon 和 OpenClaw Gateway 是两个不同的服务；启动前者不表示启动后者。

# 之前的问题点与改造原因

| 问题点 | 当前原因与影响 | 为什么要改 |
| --- | --- | --- |
| 执行命令包含 Provider 特殊分支 | playboard 为 OpenClaw 调用 `configureCliOpenClaw` 并写入 providerOptions | Provider 的发现、连接刷新和执行装配应由统一宿主启动编排负责；不能每增加一个启动依赖就给 playboard 增加分支 |
| 同一装配能力有两个调用入口 | daemon 启动和 playboard 都触发 OpenClaw 配置解析、快照保存；不是同一次 playboard 必然连续执行两遍 | 即使复用了同一个 helper，两套编排仍会产生探测、配置同步和失败处理差异。统一启动流程才能避免两条路径持续漂移 |
| playboard 的验证范围小于实际使用路径 | 直接 Host 调用可以通过，但没有覆盖 daemon 的 profile 配置选择、执行接纳和流传输 | playboard 应验证真实的本地 Runtime 执行链；Host 单元测试通过不能替代该链路通过 |
| Host 可启动被误认为 Provider 可用 | Host 的 `list` 就绪不证明 OpenClaw Gateway 已启动、认证有效或目标 Agent 存在 | 分别报告 daemon 就绪、Host 就绪、Provider 可用和 Run 终态，避免错误归因 |
| 图中的 RPC 名称与当前传输容易混淆 | 当前 `AdapterHostRpcClient` 通过流读写 Host 协议；daemon 的 UDS/Pipe 对外使用另一层控制及执行协议 | 改造必须复用匹配的客户端与服务端合同，不能只替换底层连接而假定两层 RPC 等价 |

问题不在于 RPC 本身，也不在于 OpenClaw 只能由 Octo daemon 调用。问题在于通用执行入口绕过了已有启动编排，然后用 Provider 特殊分支补齐依赖。

# 目标调用链与职责

```text
CLI playboard 读取统一 InvokeInput
  → 启动临时 Octo daemon，复用统一宿主启动装配
  → 等待临时 IPC 与 adapter-host 实际就绪
  → 本地执行客户端（Unix Socket / Windows Named Pipe）提交本轮输入
  → daemon 选择本轮 profile 执行配置
  → AdapterHostRpcClient（当前 daemon → Host 为 stdio）
  → AdapterHost → Provider Adapter → Provider
  → 原调用链返回所选输出模式的事件与真实终态
  → 关闭本次临时 daemon、adapter-host 和 IPC，回收临时资源
```

1. playboard 负责 stdin 大小与 JSON 检查、启动本次执行宿主、提交输入、消费输出、信号处理及结束清理。公共输入继续复用既有解析入口；playboard 不自行解释 Provider 连接配置，不保留 `adapterType === "openclaw"` 的装配分支。
2. CLI 是该场景的 HostApp。CLI 的统一启动编排负责已选 Home/profile 的 Provider 配置解析和必要装配，临时 daemon 与普通 daemon 复用该流程；不能只启动低层 server 后把缺失装配搬回 playboard。
3. daemon 启动并管理 adapter-host；playboard 不再直接 `spawnAdapterHost`。临时 daemon 的生命周期属于本次 CLI 调用，不复用或停止已运行的常驻 daemon。
4. 本地 socket 使用现有 daemon 执行协议及其配套客户端，优先复用 [run-stream.ts](../../../packages/octo-runtime-daemon/src/runtime/run-stream.ts) 等现有能力。公共输入到内部请求的转换继续在既有边界完成，不假定当前 socket 已能直接接收原始 stdin JSON。
5. `AdapterHostRpcClient` 继续承担 daemon 到 Host 的 RPC。它目前接收 Readable/Writable，并非专门的 Unix Socket 客户端；本次不要求把 Host stdio 改成 socket，也不把两种服务协议合并。
6. Adapter 只消费已装配的执行配置。OpenClaw Gateway 的安装、启动和重启由有该权限的宿主操作决定；本次临时 daemon 不隐式安装 Provider，不因 Gateway 不可用而重置连接或身份。

# 配置与资源归属

“临时”修饰本次进程与 IPC，不表示现有 Runtime 身份、Home 或 profile 可以删除、重新初始化或恢复成默认值。

- `--home`、`--profile`、`--manifest` 继续选择相应配置和 Adapter 声明。连接刷新沿用统一编排的既有合同；playboard 不另存一套 Provider 配置、不回退到其他 profile。
- 临时 socket/Pipe、PID 文件、执行账本和孤儿进程回收信息必须与常驻实例隔离。当前 server 的执行账本默认位于 Home 下的 `run/invocations.json`，因此仅更换 socket 路径不足以完成隔离；实现须核对状态路径及进程回收作用域。
- 并行 playboard 调用使用各自独立的进程与临时资源。清理只针对本次拥有的对象，不能删除常驻 socket、停止常驻 Host 或关闭外部 OpenClaw Gateway。
- Provider 装配与 Extra 加载是不同职责。临时执行不能因复用启动代码就隐式加载全部已配置渠道、同步渠道工具凭据或建立重复的 IM 消费连接。具体启动选项和接口形状在实施中确定，不在本文虚构参数。
- 未启动、启动失败、请求拒绝、Provider 不可用、执行失败与清理失败分别报告。stdout 保持执行事件的 NDJSON 通道，诊断写 stderr，不泄露凭据。
- 正常结束、启动中失败、SIGINT、SIGTERM、输出断流和等待交互无法继续时，均须取消或终止本次执行并等待资源清理；不能仅断开订阅就声称 Provider 已停止。取消及退出码沿用现有 playboard 合同，清理失败不得报告为清理成功。

# 协议与影响范围

本次是本地执行路径与启动职责调整。Run 保持 `schema_version=7`，Context 保持 `octo.context-envelope/v3`；不因临时 daemon 增加业务上下文，也不按 session 补齐、缓存或省略本轮模型输入。必要执行配置不进入模型文本。

实施范围包括 playboard、CLI/daemon 共享启动编排、临时运行资源路径、现有 IPC 客户端复用及测试。无需扩大 Worker、云端登记或共享访问协议；本地执行不依赖登录、enrollment 或 IM 建联。

同步更新 CLI README、接入指南、[本地执行规则](../../rules/local-execution.md)和 [OpenClaw 规则](../../rules/openclaw.md)，明确现状、改造完成状态和实际验证范围。不将本文目标提前写成现有能力。

# 后续验收

- 无常驻 daemon 时，playboard 自行启动临时 daemon 和 Host，并经 UDS/Pipe 完成执行；已有常驻 daemon 时，临时执行结束后常驻实例及其任务仍可用。
- 通过真实进程和 IPC 证据确认调用链，不仅断言输出文本。playboard 源码不再直接启动 Host，不包含 OpenClaw 连接解析或装配分支；每次临时启动由统一流程完成相应装配。
- 验证 Home/profile/manifest 选择及多次并行调用，既有身份与 Provider 配置不会被清理，临时账本不会回收常驻 Host。
- 分别验证 Codex 等子进程 Provider 和 OpenClaw Gateway Provider。OpenClaw Gateway 未启动、认证失败、目标无效时如实失败；Gateway 已可用时经统一链路取得真实执行终态。用临时 daemon 启动成功不能替代 OpenClaw 执行验收。
- 验证 native/canonical 输出、Provider 失败、启动失败、信号取消、输出断流和待交互行为；正常和失败退出后没有本次 daemon、Host、socket 或执行记录残留，不自动重新 invoke 产生重复副作用。
- 临时执行不启动未授权的 Extra 连接，不影响已有 IM 消费者。Windows Named Pipe 必须有实际验证证据；未测平台明确记为未验收。
- 实施后执行适用的构建、类型检查和回归测试。涉及真实接口的联调必须连接线上测试环境 `https://im-test.deepminer.com.cn/`，记录所验证边界，不记录凭据。本地 Host/Provider 测试不能当作线上渠道收发证据。

初次文档交付未运行执行测试或线上联调。后续实施和验证见上述记录；本次未关闭或重启任何既有 Runtime，CLI 的临时进程直接运行新构建。
