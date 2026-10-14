# 外部传输与多节点边界

当前执行内核通过本地 IPC 和 Adapter Host RPC 工作，见 [模块与传输流程](02-module-and-transport-flow.md)。`worker-access` 已移除，本仓库不再提供旧 Worker WS 注册、心跳及远程执行接入。

HostApp 可以显式加载业务扩展，由扩展接收外部请求并调用注入的共享 Host。扩展自行负责请求者认证、租户／owner 作用域、远程授权及结果投递；本地 Runtime ID 不是授权凭据。HTTP/SSE 示例只演示本地调用代理，不代表已有跨节点调度、租约、fencing 或共享设备控制面。

命令接纳不等于执行完成，取消接纳不等于 Provider 已退出。Host 源窗口是有界内存，没有 durable outbox 或逐事件 ACK；断流修复只能沿原源游标进行，缺口与过期明确报错，不能重新 invoke。

业务需要多节点路由、幂等、防重复副作用、持久历史或可靠投递时，应在拥有该业务的系统内定义并实现合同。不能把旧 Worker 文档中的持久化、重启重放或协调能力当作本地 SDK 已具备的能力。
