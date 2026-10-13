# inspect-web

## 模块责任边界

- 负责：展示 Daemon 观测流与诊断状态。
- 不负责：保存聊天历史、决定 AgentRun 终态、连接 IM Server。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
