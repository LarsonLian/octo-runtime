# Daemon 本地 Runtime SDK 与可选模块装配

本包提供本地 Runtime 生命周期与 IPC SDK，以及按宿主配置启用的对外模块装配。HostApp 决定启用哪些连接；daemon 执行模块生命周期并注入共享 Host。统一原则见 [Runtime 合同](../../.octospec/rules/runtime-lifecycle.md)。

## 当前包接入

`octo-runtime-embedded` 已移除。本地生命周期与 IPC API 合入本包的 `src/runtime`，enrollment 移入可选 worker-access。本包及其生产依赖不含 worker-access 或 channel-gateway。

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
| `channel-gateway` | `octo-runtime-extra-channel-gateway/daemon-module` / `createImModule` | Octo `bots` |
| `channel-wecom` | `octo-runtime-extra-channel-wecom/daemon-module` / `createImModule` | 企业微信 `bots` |

worker-access 已移出生态目录，作为独立预研备份，不再由标准 CLI 或 Work App 装配。

模块启动异步执行，`startModule` 返回启动接纳状态；实际结果看 `health.modules[id].phase` 和模块 `state`，不能把返回值当作云端在线 ACK。连接失败不改变 `health.local.ready`；缺少已启用模块时报告错误，不隐式安装。关闭账号或应用时停止所有已启用模块并回收共享 Host。

直接使用 `startDaemonServer` 的宿主可注入 `modules: [{ id, create, config? }]`；只有显式提供 `config` 才在启动后激活。工厂通过 `context.host` 复用同一个 `HostRunService`，不自行创建 Host。

生产隔离验证：`scripts/verify-daemon-deployment.mjs <pnpm-deploy-dir>` 实际检查 Worker/IM 缺席、启动并执行，再启用缺失模块，确认本地继续执行。完整示例见 [INTEGRATION](../../INTEGRATION.md#2-作为-sdk-接入独立-app)。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../.octospec/rules/context-input.md) 与 [IPD-SE](../../.octospec/rules/context-input.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

## 责任边界

当前实现的职责：

- 宿主决定启用哪些对外模块、使用哪类 token、连接哪个服务。daemon 执行该配置，动态加载已启用模块，管理连接的启动、停止及真实状态。
- Octo 和 WeCom Extra 管理各自的连接和消息收发。当前包不提供 Worker 设备注册或远程执行工厂。
- 本地执行走 `HostApp → SDK → IPC → Host → Adapter`。纯本地调用无需启用对外模块；当前 SDK 仍使用 daemon 包的本地控制进程；对外入口复用 Host 执行能力，关闭连接不得停止仍供本地使用的 Host。
- 五元组、Agent 定义及 defaults／mandatory 归业务方。daemon 不补齐业务 Context，不执行 Agent prepare／ensure，不安装宿主未指定的 Runtime。

设备共享访问的最终方案仍待确定；本地 ready 不证明已具备远程共享能力。

## 当前执行与源流

daemon 不静态依赖 Worker/IM，工厂位于各接入包，SDK runner 按宿主描述动态加载。`HostRunService` 位于 adapter-host，管理执行源流、短窗口重放、终态查询及取消，不维护业务调度、聊天历史或持久 outbox。

整体架构见 [Runtime README](../../README.md#设计原则与实施状态)，需求与验收见 [IPD-SE 基线](../../.octospec/rules/runtime-lifecycle.md)。

公共调用使用 `invoke(InvokeInput, environment)`。内部执行与订阅通过 UDS/Windows Pipe 的 JSON-RPC 2.0 传输；源流使用 `run_id`、`stream_id` 和 `after_seq`，断开订阅不取消 Run，修复连接不重新执行。见 [本地传输](../../.octospec/rules/local-execution.md) 和 [渠道接入](../../.octospec/rules/channel-integration.md)。
