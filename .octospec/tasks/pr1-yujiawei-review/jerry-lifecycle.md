---
type: Task
title: Jerry-Xin 两项 Provider 生命周期阻塞分析
description: 独立复现 ACP 启动错误导致共享 Host 退出，以及父进程退出后工具后代仍存活，提出边界内的最小整改与验收。
tags: [review, adapter, lifecycle, ipc, testing]
timestamp: 2026-10-17T00:00:00Z
---

# Jerry-Xin 生命周期评审

属于[同一 PR 评审计划](brief.md)，来源为 [Jerry-Xin 的 Changes Requested](https://github.com/Mininglamp-OSS/octo-runtime/pull/1#pullrequestreview-5556251807)。分析基线 `0eb8b8d8fe8be5829da74ec6e686bfa39432f521`。本轮只分析及补文档，产品源码未修改。

## 结论与价值

两项均为真实 P1，建议作为本次合入前的修复项。这两项不是吞吐、内存微优化或为极端条件新增系统：

- R05 维护单次调用与共享 Host 的故障隔离。一个 Provider 不存在，不应中止同一个 Host 内其他正常任务。
- R06 维护取消和资源回收合同。Provider 父进程退出不等于其工具后代停止，不能将“执行已停止”建立在只检查父进程的基础上。

这与当前干净架构一致：HostApp 负责选型和安装；Adapter/传输层负责自己启动的进程、管道及清理。修复不要求 Channel 控制工具流程，不要求每 Bot 独立 Host，不新增全局进程调度或业务状态库。共享内核的复用价值建立在单任务故障不会随意扩散的基础上。

## R05：ACP 启动失败拖垮共享 Host

### 根因与影响

[AcpClient](../../../packages/octo-runtime-acp-client/src/index.ts) 在构造时监听 stderr data、stdout 行和 child exit，却没有处理 child error；spawnAcpClient 也没有补该监听。stdin 写回调虽然拒绝 pending 请求，但不等同于安装流的 error 监听。

spawn 的异步错误通过 EventEmitter 发出，不属于调用该函数时的同步异常。调用方 async generator 的 try/catch 不能捕获无人处理的独立 error 事件。当前 [serveAdapterHost](../../../packages/octo-runtime-adapter-host/src/serve.ts) 只有 uncaughtExceptionMonitor 诊断，不吞掉异常；[Node 24 文档](https://nodejs.org/docs/latest-v24.x/api/process.html#event-uncaughtexceptionmonitor)明确 monitor 不改变进程的默认崩溃行为。

缺失可执行文件已可触发，无需伪造业务输入。即使 probe 或 workdir 校验曾成功，安装状态和文件系统也可能在实际 spawn 前变化，不能用强制预探测替代传输层错误处理。Host 初始校验能拦下的非法 cwd，与实际 spawn 的失效竞态分别验收。

共享 Host 是 SDK、IPC 与多个 Extra 共用的执行资源。该缺陷影响的不只是选中失败 Adapter 的任务；崩溃使同进程其他任务失去事件源，重启 Host 也不能恢复已失去的工具副作用。不得自动重新 invoke 其他任务来假装修复。

### 独立复现

环境为 macOS、Node v24.19.0，调用当前构建产物。为避免影响真实 Runtime，在独立 Node 子进程内创建 AdapterHost，注册一个合成正常 Adapter 和一个命令为不存在路径的 createAcpAdapter；请求走现有 InvokeInput 准备和 canonical 帧链路。

先启动正常任务，确认已收到 message.delta 且仍在等待，再启动失败任务。观察到：

| 观察项 | 结果 |
| --- | --- |
| 失败任务 | 已接纳并出现 activity.started，随后没有 run.failed |
| Host 所在探针进程 | unhandled error，spawn ENOENT，退出码 1 |
| 同 Host 的正常任务 | 崩溃前已开始；没有机会返回 run.completed |

该独立探针验证的是同进程 AdapterHost 层。Jerry-Xin 还报告跨 Host RPC 的兄弟流断开；本轮未重复 RPC 探针，不将其列为自己的独立实测，后续正式回归必须覆盖真实 Host RPC 子进程。

### 最小方案与验收

建议在 ACP 传输创建时及时安装进程和相关管道 error 处理，统一进入该 client 的失败收敛路径：

1. 保存真实首个传输失败原因；拒绝所有 pending 请求并结束更新队列，后续请求明确失败，不等待默认的长超时。
2. error、exit、close、写回调、主动 close 和取消可能相继到达，收敛必须幂等；不产生重复终态、未处理 Promise rejection 或新的未监听 error。
3. 继续由既有 Adapter/Host 路径返回本次失败，保留真实错误及诊断，不全局拦截 uncaughtException 后强行继续服务。
4. 清理当前调用持有的进程、流、监听器和定时器；一个失败不能销毁共享 Host、其他 Provider 或另一个任务的传输。

正式回归覆盖缺失命令、实际 spawn 时 cwd 失效、stdin/EPIPE 及错误与关闭竞态。核心验收必须在独立的真实 Host RPC 子进程内并行两条调用：坏调用得到真实失败且只结束一次；好调用继续完成；随后 list 和新调用仍可用；无永久挂起。不能只加一个模拟 error 被吞掉的单测。

## R06：父进程退出后工具后代继续运行

### 根因与影响

[NDJSON spawnJsonLines](../../../packages/octo-runtime-adapter-sdk/src/index.ts) 和 ACP 传输都在 POSIX 将新 Provider 置于独立进程组，并向该组发 SIGTERM。但其后续 SIGKILL 依赖直接子进程 exitCode/signalCode 仍为空。

NDJSON 还在 generator finally 中清掉 escalation timer；ACP close 在父进程 exit 时结束等待并跳过升级。因此只要父进程响应 TERM 退出、工具后代忽略 TERM，后代就可能一直活着。Provider 使用独立进程组，不能假定之后终止 Host 组会顺便回收它。

这首先是正确性和稳定性问题，资源增长是后果：残留进程会继续占用资源、写文件或发送请求；重复取消可积累残留。不得把已发生的外部副作用描述成可撤回，也不能以取消卡片已经显示为清理证据。

### 独立复现

每种传输创建一个专属临时目录和合成 Provider。Provider 启动一个同组工具后代；工具装好 SIGTERM 忽略处理后报告 ready，并每 25 ms 向临时计数文件追加一个字节。Provider 自己采用 TERM 的默认退出行为。NDJSON 从 ready 事件触发 abort，ACP 在 ready 后调用 close。

| 传输 | 传输收尾返回耗时 | 1.3 秒后父进程 | 1.3 秒后后代 | 此后 150 ms 的新增写入 |
| --- | --- | --- | --- | --- |
| NDJSON | 约 0 ms | 已退出 | 仍存活 | 6 字节 |
| ACP | 约 1 ms | 已退出 | 仍存活 | 6 字节 |

新增写入证明后代仍在执行，不只是通过 kill(pid, 0) 观察到一个未回收 PID。本轮各组均由探针显式 SIGKILL 清理并复查后代已不存在，再删除临时目录。没有调用真实模型、触碰用户 Home 或取消现有业务任务；这不是线上服务验收。

现有 [Antigravity 回归](../../../test/antigravity-adapter.test.js)使用父子都忽略 SIGTERM 的 fixture：父进程一直未退出，所以原有升级条件成立。该测试通过不能覆盖“父先退、子不退”的缺口。

### 最小方案与验收

建议让本次受管进程组的清理完成条件独立于 leader 的 exit 状态：

1. 仅对该传输实际创建、仍处于本次有界所有权周期内的进程组执行 TERM 和必要的 KILL，不使用全机按名称扫描、不重用历史 PID、不终止外部已有 Gateway。
2. leader 退出后，仍完成本次组的检查及升级，不能仅因此清除定时器或跳过 SIGKILL。组已消失时正常结束，不强制每次等待完整宽限期。
3. 把取消、显式 close、generator 提前结束和错误退出收敛到可等待的清理结果；重复调用共享同一次收尾，不因为 closed 标记已置位就误报清理已经完成。
4. 宽限、升级和最终等待都必须有界。当前传输 TERM 宽限约 1 秒，Host 默认 cancelGraceMs 也是 1 秒，ACP 取消另有 250 ms 关闭延迟；实施时必须对齐这些时间窗，不能增加更长等待后继续声称满足较短的执行合同。调用方显式更短预算须得到真实清理超时结果，不静默放大预算。
5. 清理失败、权限不足或预算到期时记录并返回真实事实，不伪报成功回收。定时器和监听器只有在完成或有明确失败归属后释放，不能提前丢失组清理责任。

正式回归必须分别覆盖 NDJSON 和 ACP 的以下场景：父先退、后代拒绝 TERM；父子都拒绝 TERM；正常组已消失；重复取消/close；初始化失败和提前停止消费；清理超时。校验后代实际停止执行、组回收、兄弟任务不受影响、定时器不泄漏；Linux/macOS 都运行。

边界是本次受管进程组，不等于对任意进程树提供操作系统沙箱。主动 setsid 脱离进程组的工具、其他用户进程和远端服务不由这一补丁保证。Windows 未运行该探针，需按现有平台终止方式单独评估，不能将 POSIX 负 PGID 直接搬过去。

邻近的 [spawnAdapterHost 清理](../../../packages/octo-runtime-adapter-host/src/process.ts)也按 leader 退出判断是否继续升级。后续定向检查已通过 public launcher 独立复现同组工具残留，记为[同类项 S02](assessment.md)；该补充同时记录 Codex stdin 断管导致进程退出的 S01。ZCode 同类清理条件仍仅有源码证据，不能混写为已复现。均不扩张为全局进程管理重构。

## 实施顺序与决策

先修 R05，确保正常启动失败可以进入现有错误与清理路径；再修 R06，确保该路径不会遗留受管后代。两项分别提交并补交叉回归，之后处理主计划的 HTTP helper 与文档。核心注释引用本专项，解释故障隔离和组清理为什么不能只看 leader。

无需新增产品开关或改变共享 Host 架构。清理预算的实现细节需在编码前对照现有显式限制收敛；如果方案要求改变公开取消合同或增加 Windows 能力，另列具体差异，不能悄悄写成完成。

本轮未实施修复，未运行修改后的测试或再次触发 CI。现有 CI 全绿不推翻上述独立复现，后续验收须包含新增失败场景。
