---
type: Journal
title: Playboard 临时 daemon 执行实施与验证
description: 记录统一启动、IPC、资源隔离、回归检查与真实 Provider 验证范围。
tags: [architecture, invoke, ipc, lifecycle, testing, openclaw]
timestamp: 2026-10-15T00:00:00Z
---

# 实施结果

依据[任务决策](../../tasks/playboard-daemon-execution/brief.md)，在当前 `octo-runtime` 分支工作树实施，不切换分支、不提交或推送。已有其他任务的修改保留。

- [playboard.ts](../../../apps/cli/src/playboard.ts) 不再导入 OpenClaw 配置函数或直接启动 Host。准备统一输入后启动临时 daemon，通过现有 `invokeDaemonRun` 与输出视图返回 native/canonical 事件；所选 profile 经执行元数据传递，与请求中显式 profile 冲突时拒绝。
- [temporary-daemon.ts](../../../apps/cli/src/temporary-daemon.ts) 为本次调用建立独立临时目录，隔离 socket/Pipe、PID 和执行账本。启动独立 daemon 子进程，经 IPC 就绪消息和实际 socket 状态确认可用；诊断进入 stderr。结束时等待 daemon 清理，异常退出使用本次账本回收已确认身份的孤儿 Host，不触碰常驻目录。
- [daemon 统一入口](../../../apps/daemon/src/index.ts) 通过 `--execution-only` 选择单一 profile，复用既有 Provider 初始化；跳过 Extra 目录读取及有业务配置的渠道工具同步。临时执行不启动第二个 IM 消费者，不重启外部 OpenClaw Gateway。
- [runtime-options.ts](../../../apps/daemon/src/runtime-options.ts) 透传临时执行选项；[server.ts](../../../packages/octo-runtime-daemon/src/server.ts) 新增可选运行状态目录，默认路径保持原行为，daemon 到 Host 继续使用 stdio `AdapterHostRpcClient`。
- daemon 在启动期间也接收停止信号，并在启动完成后统一清理；临时调用方 IPC 消失时请求停止。Host 启动失败时发现进程组退出竞态会返回 `EPERM`，在 [process.ts](../../../packages/octo-runtime-adapter-host/src/process.ts) 回退为终止所属子进程，保留原始启动错误。

CLI 参数、stdin 大小约束、输出模式、退出码及待交互失败合同保留。Run=7、Context=v3 未修改，不涉及 Worker 或桌面协议变更。新构建由每次 CLI 启动的临时进程直接加载，未重启任何既有 Runtime，也未删除既有 Home、profile 或 Provider 身份。

# 自动化验证

| 检查 | 结果与范围 |
| --- | --- |
| `pnpm typecheck` | 通过，含 workspace 完整构建及根类型检查；后续小改动另构建 daemon-app、adapter-host，并再次执行根 `tsc --noEmit` |
| `pnpm lint` | 通过，覆盖 apps/packages |
| `node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js` | 769 项，762 通过、7 跳过、0 失败；跳过项不算验收通过 |
| 最后补充启动取消隔离测试后的 `node --test test/playboard.test.js` | 16 项全部通过，覆盖最终专项测试状态 |
| `git diff --check` | 通过 |

[Playboard 回归](../../../test/playboard.test.js)覆盖统一 Context、native/canonical、失败终态、期限、待交互失败、Ctrl+C、输出断流、启动失败与启动取消清理；检查 daemon 和 Host 均退出。并行执行与常驻 daemon 共用配置 Home 时，临时进程、Host 和账本独立，常驻服务仍就绪，原身份及账本内容保持。

OpenClaw 自动化使用真实 Adapter 和测试 WebSocket Gateway，经完整 CLI → daemon → Host 路径执行。验证 profile 选择、已有 Agent、轮换后来源刷新、设备身份稳定，以及 Gateway 不可达时失败。此处 Gateway 为测试替身，不代表真实 Provider 或线上业务验证。

# 真实 Provider 与线上环境

执行 [verify-playboard-live.mjs](../../../scripts/verify-playboard-live.mjs)，脚本先只读请求 `https://im-test.deepminer.com.cn/`，确认 HTTP 200，再分别通过新的 playboard 临时链路调用已安装 Codex 和已运行 OpenClaw Gateway。模型请求只要求返回固定标记，不调用工具、不发送消息。临时验证 Home 与工作目录由该脚本创建并回收，不销毁既有 Runtime。

| Provider | 退出码 | 实际终态 | 预期响应 | canonical 事件数 |
| --- | --- | --- | --- | --- |
| Codex | 0 | `run.completed` | 匹配 | 18 |
| OpenClaw | 0 | `run.completed` | 匹配 | 34 |

两次通过执行均无 stderr 诊断。Gateway 健康探测也返回运行中且 RPC 可用；没有安装或重启 Gateway，没有读取或打印 token。

此前曾尝试让 Codex 通过 curl 访问 im-test，该调用产生 `interaction.requested`，playboard 按既有一次性输入合同以 `PLAYBOARD_INTERACTION_REQUIRED` 失败退出；没有自动回答该交互。后续成功运行改用无工具请求。线上 HTTP 检查由测试脚本独立执行，不声称 Provider 工具已经访问 im-test。

# 验证边界

- 验证平台为 macOS Unix Socket。Windows Named Pipe 路径已保留实现分支，但未做 Windows 实机验收；不能据此声称 Windows 的进程身份识别和清理已通过。
- im-test 验证为独立 HTTP 只读检查；真实模型执行验证本地 Provider 链路，不证明 IM 收发、外部共享访问、云端登记或审批应答通过。
- 正常结束、信号取消、输出断流、启动失败及启动取消已测；40 秒强制关闭超时和不可验证孤儿身份分支未做故障注入。清理失败会返回明确错误，不作为已清理成功。
