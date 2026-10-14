# Daemon 本地 Runtime SDK 与可选模块装配

本包提供本地 Runtime 生命周期与 IPC SDK，以及按宿主配置启用的对外模块装配。HostApp 决定启用哪些连接；daemon 执行模块生命周期并注入共享 Host。统一原则见 [Runtime 合同](../../docs/runtime-local-and-online-contract.md)。

## 当前包接入

`octo-runtime-embedded` 已移除。本地生命周期与 IPC API 合入本包的 `src/runtime`，enrollment 移入可选 worker-access。本包及其生产依赖不含 worker-access 或 channel-im。

```ts
import { createDaemonRuntime, resolveDaemonHome } from '@mininglamp-oss/octo-runtime-daemon';

const runtime = createDaemonRuntime({ appId: 'eva2', home: resolveDaemonHome('eva2') });
await runtime.startAccount({ subject: { type: 'user', id: userId }, tenants: [{ id: tenantId }] });
// 本地 ready 即可 invoke；不要求注册、Human Token 或云端连接。
await runtime.stop('quit');
```

宿主发布时可以只部署本包及其本地执行依赖，明确提供 Node、runner、manifest 和 adapter-host 入口；执行层不自动安装。

需要连接时，HostApp 额外携带对应包，并在 `modules` 登记 `{ id, module, exportName }` 工厂描述。`startAccount` 只启动本地 IPC 和 Host；登记模块不导入它，也不建联。显式 `startModule(id, config)` 才加载工厂。凭据经本地 IPC 传递，不写入 runner session 或模型上下文。`requestModule(id, method, params)` 调用模块方法，`stopModule(id)` 只关闭该模块。

| 模块 ID | 额外包 / 工厂 | 配置 |
| --- | --- | --- |
| `worker-access` | `octo-runtime-worker-access/daemon-module` / `createWorkerAccessModule` | `registrations` 或显式 `runtimes`；现有职责仍未通过最终评审 |
| `channel-im` | `octo-runtime-channel-im/daemon-module` / `createImModule` | `bots`；可独立启用，无需 Worker 包 |

模块启动异步执行，`startModule` 返回启动接纳状态；实际结果看 `health.modules[id].phase` 和模块 `state`，不能把返回值当作云端在线 ACK。连接失败不改变 `health.local.ready`；缺少已启用模块时报告错误，不隐式安装。关闭账号或应用时停止所有已启用模块并回收共享 Host。

直接使用 `startDaemonServer` 的宿主可注入 `modules: [{ id, create, config? }]`；只有显式提供 `config` 才在启动后激活。工厂通过 `context.host` 复用同一个 `HostRunService`，不自行创建 Host。

生产隔离验证：`scripts/verify-daemon-deployment.mjs <pnpm-deploy-dir>` 实际检查 Worker/IM 缺席、启动并执行，再启用缺失模块，确认本地继续执行。完整示例见 [INTEGRATION](../../INTEGRATION.md#2-作为-sdk-接入独立-app)。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

## 责任边界

2026-10-14 最终架构期望，实施中、待验收：

- 宿主决定启用哪些对外模块、使用哪类 token、连接哪个服务。daemon 执行该配置，动态加载已启用模块，管理连接的启动、停止及真实状态。
- channel-adapter 管理 IM 长连接和消息收发。access 的已确认职责仅为设备与 Runtime 注册，注册由用户或宿主显式操作发起。
- 设备在线与 IM 频道启用分别控制。Work App 后续须在本地持久化“允许当前设备在线”选择；关闭时不加载设备连接，并停止已有对应连接。登录、导入 package 或启动 Host 不得自动开启。
- 本地执行走 `HostApp → SDK → IPC → Host → Adapter`。纯本地调用无需启用对外模块；当前 SDK 仍使用 daemon 包的本地控制进程；对外入口复用 Host 执行能力，关闭连接不得停止仍供本地使用的 Host。
- 五元组、Agent 定义及 defaults／mandatory 归业务方。daemon 不补齐业务 Context，不执行 Agent prepare／ensure，不安装宿主未指定的 Runtime。

access 与设备 WS 的接口归属、heartbeat、关闭后云端状态失效及初始在线默认值仍待最终架构评审。现有 worker-access 的全部实现不能视为最终 access 的职责。

## 现有实现与退出目标

当前包边界与可选装配已实现：`server.ts` 无 Worker/IM 静态依赖，模块工厂位于各接入包，SDK runner 按宿主描述动态加载。`server.ts`、`runtime-core.ts` 仍包含本地控制进程和 reference Run 调度；最终进程职责拆分及 Work App 持久化在线 toggle 尚待独立实施。`HostRunService` 位于 adapter-host，管理本地执行源流、短窗口重放、终态查询及取消，不保存聊天历史。

整体架构见 [Runtime README](../../README.md#设计原则与实施状态)，需求与验收见 [IPD-SE 基线](../../../docs/local-runtime-ipc-on-demand-ipd-se.md)。

原 daemon 控制接口包括 `agent_run.submit` / `invoke` / `subscribe` / `get` / `cancel` / `respond`，使用 UDS/Windows Pipe。目标本地执行与交互接口由 Host 提供。源流查询使用 `run_id`，订阅带 `stream_id` 和 `after_seq`；断开订阅不取消 Run。现有 reference Run 调度属于待调整实现，不为保留它新增业务 prepare 服务。历史实现范围见 [本地流方案](../../docs/26-channel-local-stream-and-ack-plan.md)。
