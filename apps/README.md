# 可执行入口与责任边界

| 入口 | 负责 | 实现依赖 |
|---|---|---|
| [cli](cli/README.md) | 运维、Home/profile、原生服务与诊断 | cross-service、daemon |
| [daemon](daemon/README.md) | 配置、进程启动、信号转发 | daemon 装配 worker-access 与共享 Host |
| [adapter-host](adapter-host/README.md) | 独立 Host 进程与 stdio IPC | adapter-host、Adapters |
| [inspect-web](inspect-web/README.md) | 诊断展示 | Daemon 观测接口 |

沿用已有 CLI，不为 IM 或本地助理新增 Runtime 项目。Worker 与 IM 是 packages 中的接入模块，所有 AgentRun 通过同一个 adapter-host 执行。IM 包当前仅骨架。
