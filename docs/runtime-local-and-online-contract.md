# Runtime 本地存在与接入边界

本文按当前源码说明本地身份、SDK 与状态。Run 固定为 7，Context 固定为 `octo.context-envelope/v3`，各协议版本独立。

## 本地存在

HostApp 安装并初始化 Runtime 后，本地执行对象及稳定身份即存在。SDK 在同一 app-owned Home、subject 和 tenant profile 中复用 Runtime ID；模块停用、外部断线和普通重启不删除该身份。显式销毁身份是另一个操作，不能作为连接故障的自动修复。

`machine_id` 是 Home 级安装分组标识，不是硬件指纹、认证凭据或跨产品全局设备身份。同一 Home 可以有多个账号／租户 Runtime；不同 app-owned Home 不自动合并。

| 事实 | 当前依据 |
| --- | --- |
| Runtime 已初始化 | profile 中保存合法本地 `runtime_id` |
| 本地就绪 | 有效 IPC 响应、`health.local.ready` 和 `adapterHostReady` |
| Provider 可用 | 实际 probe；不等于已认证或本次调用一定成功 |
| 扩展初始化完成 | 扩展生命周期状态；不等于其所有业务连接健康 |
| 执行完成 | 对应 Run 的真实终态；不等于业务保存或投递成功 |

## 安装与包

所有 Runtime 及依赖的安装方案由 HostApp 决定。SDK、Host 和 Adapter 只能执行明确方案；缺失或版本不符时返回状态，不在注册、探测或执行时自行下载。

本地 SDK 位于 `octo-runtime-daemon/src/runtime`；独立 embedded 包已删除。daemon 的生产依赖只包含本地执行及协议所需包，不依赖业务 Channel。Octo 与 WeCom 由各自 `extra-channel-*` 包提供，宿主按需携带和启用。

当前 `worker-access` 包已移除，不再提供 Worker 注册、WS、心跳或远程执行工厂。本地 SDK 不要求 Human Token、Worker URL 或 Runtime credential。其他产品的云端登记与设备在线能力必须使用其实际实现和回执，不能由本地 ready 推导。

## SDK 生命周期

1. HostApp 准备 Node、runner、manifest、Adapter Host 及 Provider。
2. `createDaemonRuntime({appId, home, ...})` 创建本地 SDK。
3. `startAccount({subject, tenants})` 初始化本地身份并启动 IPC／Host。
4. 宿主显式配置需要的模块或 extras，业务层提交已准备的本轮输入。
5. 宿主消费输出、保存完整历史、处理交互和取消；停止账号或应用时等待 `stop(reason)` 回收资源。

当前 SDK 使用 daemon server 承载本地控制子进程，同一账号多个 profile 共享 Host。不要把包解耦写成完全没有子进程，或把计划中的专用对外进程写成已完成。

## 上下文与恢复

每轮模型 Context 由业务方选择，允许空值、仅当轮项或显式重复。执行配置独立解析校验，不让业务背景变为必填。Host 不采集业务状态，不缓存、补齐、合并、去重或省略模型输入，见 [注入约束](context-llm-injection.md)。

Provider session 不保证恢复成功。业务方管理 binding 与 reset，并决定新会话要发送的背景。Host 源流有界，重启后不恢复旧执行，不自动重新 invoke。历史与可靠投递属于消费应用。

当前 API 以 [SDK 类型](../packages/octo-runtime-daemon/src/runtime/types.ts)、[daemon 导出](../packages/octo-runtime-daemon/src/index.ts)和[Extras 合同](extra-plugins.md)为准。真实测试记录按当时日期和范围解释，不代表后续改造已完成线上验收。
