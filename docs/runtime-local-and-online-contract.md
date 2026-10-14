# Runtime 本地存在与按需在线合同

日期：2026-10-14。本文是当前 Harness 包边界、接入与状态判断的统一说明；目标验收见 [IPD-SE](../../docs/local-runtime-ipc-on-demand-ipd-se.md)。Run 固定为 7，Context 固定为 `octo.context-envelope/v3`，各协议版本独立。

## 1. 设计原则

设备客观存在。HostApp 安装并初始化 Runtime 后，本地执行对象及其稳定身份即存在；云端登记只增加远程可见性，不创建本地存在的事实。未开放 online、未注册、云端断线或接入失败，均不撤销本地 Runtime 身份。

Runtime 存在、本地就绪、注册成功、允许对外在线、实际设备连接、IM 频道连接和某次执行完成是不同事实。HostApp 必须按各自证据判断，不能合成一个“在线即一切可用”的状态。

HostApp 决定安装哪些 Runtime、版本、方式，以及携带和启用哪些接入包。SDK、daemon、Host 和 Adapter 执行宿主明确提供的方案；缺失依赖时返回错误，不在启动、探测、注册或执行时自行下载。

业务发起方负责 `Actor + Trigger + Target + Input + Context`，处理业务 defaults／mandatory，选择每轮模型上下文。底层校验协议、执行身份和资源权限，转发本轮快照；Host 只按白名单保序渲染。启动、注册和本地调用不要求 Worker 创建、ensure 或 prepare Agent。

## 2. 身份与状态

| 事实 | 当前证据或责任 | 不代表什么 |
| --- | --- | --- |
| 本地 Runtime 已初始化 | 对应 Home、账号和租户 profile 保存稳定 `runtime_id` | Host 正在运行或已注册 |
| 本地就绪 | IPC 实际可访问且就绪响应有效；SDK `health.local.ready` 与 `adapterHostReady` | 所有 Provider 已安装、认证或可执行 |
| 云端注册成功 | 注册接口真实回执，身份与作用域校验通过 | 持续在线或执行完成 |
| 允许设备在线 | HostApp 的明确启用策略；持久化开关为产品目标 | 当前连接成功 |
| 设备实际连接 | 已启用 Worker 模块的实际连接状态 | IM 频道在线或输出已保存 |
| IM 频道连接 | 该频道自己的连接状态 | Runtime 必须先注册到 Worker |
| 执行完成 | 对应 Run 的真实终态事件 | 业务验收或消息投递完成 |

本表是语义划分，不新增 API 枚举。模块配置已登记与 `startModule` 接纳启动请求，都不等于模块已经连接成功。

SDK 在同一 app-owned Home、subject 和 tenant profile 中复用 Runtime ID。注册、重连、停止模块、普通重启和重领注册凭据不更换该 ID；Worker 注册沿用本地 ID。聊天 reset 只处理会话，不删除 Runtime 身份。显式删除本地身份属于另一个破坏性操作，不能作为连接故障的自动修复。

`machine_id` 是 Home 级安装分组标识，不是可信硬件指纹、认证凭据或跨产品全局设备身份。同一 Home 可以有多个账号／租户 Runtime；不同 app-owned Home 不自动合并。Runtime ID、业务 Agent ID 和 Provider session ID 不可互换。

## 3. 包与进程边界

`octo-harness-embedded` 独立包已删除。本地身份、Home、子进程监督、IPC 和执行流 API 合入 `octo-harness-daemon/src/runtime`。这保留了可复用的本地能力，移除了独立 embedded 包层级。

| 接入范围 | HostApp 携带的包 | 启用方式 |
| --- | --- | --- |
| Eva2.0 等仅需本地执行的客户项目 | daemon 及其本地执行依赖 | `createDaemonRuntime → startAccount → invoke` |
| 本地执行加 IM | 上述包加 channel-im | 显式登记工厂并 `startModule("channel-im", config)` |
| 标品需要 Worker 接入 | 上述包加 worker-access | 显式登记工厂并 `startModule("worker-access", config)`；最终职责待评审 |

daemon 的生产依赖不含 worker-access 和 channel-im。客户无需复制标品业务代码、embedded 代码或 apps/cli。复用包的公开 API，由客户自己的 HostApp 决定组合。

HostApp 决定“是否启用”；daemon 执行模块的加载、启动、停止和状态管理；各接入包实现自己的协议。Node 宿主也可直接使用 daemon server 并注入工厂，但不能让包导入自动建立连接，或让接入模块另起一套 Host。

当前 SDK 的本地控制子进程仍由 daemon 包 server 承载；同一账号内的多个 profile 共享 Host。包解耦不等于已经完成“本地控制进程与对外专用进程”的物理拆分。纯本地调用无需激活对外模块，不能误写为当前 SDK 完全没有 daemon 子进程。

## 4. 生命周期与失败

1. HostApp 明确准备 Node、runner、adapter manifest、adapter-host 及所需 Provider。
2. `startAccount({subject, tenants})` 初始化本地身份并启动 IPC／Host；不要求 Octo Human Token、Worker URL 或 enrollment。
3. HostApp 需要某个接入时才额外携带并登记工厂，显式调用 `startModule(id, config)`。
4. 业务层提交已准备的本轮请求，消费真实事件，处理取消与交互；历史保存由业务应用负责。
5. `stopModule(id)` 只停止对应接入。关闭账号或应用时 `stop(reason)` 回收模块和共享 Host，保留本地身份。

Worker 或 IM 失败只影响对应接入状态。Host IPC、执行参数或 Provider 失败影响本地执行，应返回实际原因；不能用云端 online 掩盖本地错误。

Host 源事件和当前远程 relay 使用有界内存，不是永久历史或 durable outbox。断流修复沿原源游标进行；缺口与过期必须报错，不能自动重新 invoke。业务应用需要历史或可靠投递时自行保存完整事件及业务状态。

## 5. 已实现与待完成

| 项目 | 当前状态 |
| --- | --- |
| embedded 包移除，daemon 提供本地 SDK | 已实现并验证 |
| daemon 生产部署无 Worker／IM；缺失可选模块仍可本地执行 | 已验证 |
| 本地身份先生成，Worker 注册沿用同一 ID | 已实现；注册仍需真实授权 |
| Worker／IM 独立装配，共享 Host | 已实现工厂和显式模块生命周期 |
| Work App 本地启动默认不启用 worker-access | 已实现，真实 renderer 本地执行通过 |
| Work App 持久化“允许当前设备在线”toggle | 待实施，不宣称已经存在 |
| access 注册职责与设备 WS／heartbeat 最终划分 | 待架构评审；现有 worker-access 仍组合注册、WS 与远程执行 |
| 对外专用进程拆分、CLI 显式频道配置及独立注册命令 | 按独立里程碑实施；候选命令不是现有 API |

当前 CLI／安装器是标品运维装配，仍会从已保存的云端 profile 恢复 Worker 接入。其登录、原生服务安装和 `--wait-online` 流程不能当作客户 SDK 的前置条件，也不代表最终在线开关合同已完成。

代码与真实测试证据见 [包解耦验证](validation/daemon-package-modules-2026-10-14.md) 和 [生态本地 IPC 验证](../../docs/local-runtime-ipc-validation-2026-10-14.md)。各 Provider 和最终设备链路按各自场景验收，不能由一次本地执行通过推导全部完成。

## 6. 接入入口

- [SDK 与 CLI 接入指南](../INTEGRATION.md)：当前 API、身份、生命周期、invoke 和可选模块。
- [架构](../ARCHITECTURE.md)与[模块流程](02-module-and-transport-flow.md)：本地和可选远程路径。
- [部署](../DEPLOYMENTS.md)与[运维](07-operations.md)：最小发行物、凭据和分层排障。
- [Work App 内置 Runtime](../../octo-harness-work-app/docs/embedded-runtime.md)：宿主组合与发行物。
