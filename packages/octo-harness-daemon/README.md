# @mininglamp-oss/octo-harness-daemon

围绕 reference Core 的单机 FIFO 执行器。它调度已经存在的 AgentRun、等待终态、取消 invocation，并在启动时恢复本地未完成 Run。

它不运行 cron/event/webhook scheduler，不创建 Loop Task，不判断 Chat/Task 类型。生产模式由 Agent Worker 下发 `run.start`，对应实现位于 `apps/daemon/src/agent-work-runtime.ts`；本包主要服务本地 reference profile 和测试。
