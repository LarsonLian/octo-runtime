# Octo Harness 接入指南

本文介绍客户 App 的本地 SDK 接入，以及标品 CLI 的独立 Runtime 运维。先读 [Runtime 本地存在与按需在线合同](docs/runtime-local-and-online-contract.md)：本地身份与执行不依赖注册、设备 online 或 IM。

接口依据为 2026-10-14 当前工作区源码。参考 App 是同级目录的 [`octo-harness-work-app`](../octo-harness-work-app)，即本文参考的 Octo Work 实现。服务地址、Token、ID 和本地路径需要替换为实际配置。npm 安装命令以对应包版本已经发布到接入方可访问的 registry 为前提。

## 1. CLI 操作说明

CLI 适用于安装、注册、启动和诊断独立 Runtime。远程调用在显式启用 Worker 后通过其执行入口下发；本地 App 直接使用 SDK，本地命令行执行可用 `playboard` 调试。

### 1.1 安装

要求 Node.js 24 或更高版本，执行：

```bash
npm install -g @mininglamp-oss/octo-harness
octo-harness --help
```

从源码运行时，先构建，再使用编译后的入口：

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js --help
```

源码构建要求 pnpm 11 或更高版本。后续示例统一使用 `octo-harness`，源码环境可替换为 `node apps/cli/dist/index.js`。

### 1.2 选择 Home 和 profile

| 参数             | 说明                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `--home PATH`    | Runtime 状态目录；默认 macOS/Linux 为 `~/.octo-harness`，Windows 为 `%LOCALAPPDATA%\OctoHarness` |
| `--profile NAME` | Runtime 配置名称，默认为 `default`                                                               |

一个 Home 运行一个 daemon 和共享 adapter-host，可以包含多个 profile。每个 profile 有独立 `runtime_id`；仅启用云端接入时需要其设备凭据和 Worker 连接；daemon 启停作用于整个 Home。

下文 Bash/zsh 示例使用以下变量：

```bash
HARNESS_HOME="$HOME/.octo-harness"
HARNESS_PROFILE="default"
```

### 1.3 注册 Runtime

先在管理端或 App 登录流程中获取一次性 enrollment grant，再通过 stdin 注册：

```bash
printf '%s\n' 'octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN' | octo-harness \
  --home "$HARNESS_HOME" --profile "$HARNESS_PROFILE" login \
  --server-url https://im-test.deepminer.com.cn \
  --agent-work-url https://im-test.deepminer.com.cn/agentworker/api \
  --enroll-token-stdin \
  --runtime-name "本机 Runtime"
```

| 参数                   | 说明                                                     |
| ---------------------- | -------------------------------------------------------- |
| `--server-url`         | Octo 服务根地址                                          |
| `--agent-work-url`     | Worker API 根地址；省略时为 `SERVER_URL/agentworker/api` |
| `--enroll-token-stdin` | 从 stdin 读取一次性 `octo_enroll_` grant                 |
| `--runtime-name`       | 首次注册的 Runtime 展示名                                |

`login` 是现有 CLI 的显式云端注册入口，完成设备凭据保存，不创建或 ensure 业务 Agent。CLI 仍保留 enrollment 中心的引导；客户 SDK 在本地初始化时先产生身份，不能把 CLI 登录当作 SDK 前置条件。重复登录已有 profile 复用身份。

Human Token、enrollment grant 和 Runtime credential 是三种不同凭据。CLI 首次登录需要 grant，不能直接传 Human Token 或 Bot key。程序调用时将 grant 直接写入子进程 stdin；不要把真实凭据拼进 argv、脚本或日志。上面的 Token 是占位符。

### 1.4 启动、停止和卸载

```bash
# 注册为当前用户的原生服务，默认启用登录自启
octo-harness --home "$HARNESS_HOME" daemon install

# 启动本地服务（该 CLI 会恢复已保存的云端 profile）
octo-harness --home "$HARNESS_HOME" daemon start

# 仅需要验收云端连接时，额外等待选中 Runtime 在线
octo-harness --home "$HARNESS_HOME" --profile "$HARNESS_PROFILE" \
  daemon start --wait-online --timeout-ms 30000

# 查询、重启、停止
octo-harness --home "$HARNESS_HOME" daemon status
octo-harness --home "$HARNESS_HOME" daemon restart
octo-harness --home "$HARNESS_HOME" daemon stop

# 停止并移除原生服务定义，保留 Home 内的数据和凭据
octo-harness --home "$HARNESS_HOME" daemon uninstall
```

现有 CLI 原生服务安装流程仍要求 profile 身份；它不代表客户 SDK 必须注册才能启动。最终显式频道／设备在线配置仍按独立里程碑实施。

原生服务对应 macOS LaunchAgent、Linux systemd user service、Windows 当前用户 Task Scheduler。`daemon start` 要求服务已经安装且启用；`daemon install --no-autostart` 可关闭登录自启。

`stop`、`restart` 和 `uninstall` 默认先关闭新 Run 准入并等待活动 Run。`--force` 跳过该等待。`--timeout-ms` 单位为毫秒，支持 1 到 600000 的整数。`--wait-online` 检查所选 Runtime 的 WSS 在线，而不仅是进程存在。

前台调试使用：

```bash
octo-harness --home "$HARNESS_HOME" daemon run
```

Ctrl+C 退出前台进程；`--quiet` 关闭终端状态输出，`--verbose` 输出更详细的运行诊断。

### 1.5 查询状态和执行记录

```bash
octo-harness --home "$HARNESS_HOME" status
octo-harness --home "$HARNESS_HOME" --profile "$HARNESS_PROFILE" doctor
octo-harness --home "$HARNESS_HOME" adapter list
octo-harness --home "$HARNESS_HOME" adapter probe codex
octo-harness --home "$HARNESS_HOME" agent-session list
octo-harness --home "$HARNESS_HOME" agent-session get <agent-session-id>
octo-harness --home "$HARNESS_HOME" agent-run list
octo-harness --home "$HARNESS_HOME" agent-run get <run-id>
octo-harness --home "$HARNESS_HOME" agent-run wait <run-id>
octo-harness --home "$HARNESS_HOME" agent-run cancel <run-id>
```

`doctor` 检查 Node、身份、凭据、原生服务、本地 IPC 和所选 Runtime 的云端连接，并提供失败项的修复建议。全部通过退出码为 0，否则为 1。

普通命令的 stdout 为 JSON，可能跨多行；错误输出到 stderr 并返回非零。接入程序应先检查退出码，再解析完整 stdout。`daemon run` 是长期运行进程，不使用一次性 JSON 请求的等待方式。生产远程 Run 的业务状态使用第 2.6 节的 Worker 查询接口。

### 1.6 本地唤起 Agent：playboard

`playboard` 用于本地开发和调试：从 stdin 读取一个完整 JSON 对象，启动独立 Host，执行一轮后退出。无需登录或运行 daemon，但 Provider 必须预先安装并完成认证。

```bash
octo-harness playboard <<'JSON'
{
  "inputs": [{ "type": "text", "text": "回复 OK，不使用工具。" }],
  "contexts": {
    "schema": "octo.context-envelope/v3",
    "items": [
      {
        "namespace": "octo.execution",
        "name": "adapter",
        "payload": { "type": "codex" }
      }
    ]
  },
  "sessionId": "local-trial",
  "protocol_mode": "canonical"
}
JSON
```

| 字段              | 说明                                                 |
| ----------------- | ---------------------------------------------------- |
| `inputs`          | 必填，非空的模型输入列表                             |
| `contexts`        | 必填 Context v3；`items: []` 有效                    |
| `sessionId`       | 可选业务会话标识；重复此值不会自动恢复 Provider 历史 |
| `protocol_mode`   | `native` 为默认值；`canonical` 输出标准事件          |
| `providerSession` | 可选，使用实际返回的 Provider 绑定请求续聊           |
| `continuityMode`  | 有绑定时默认 `continue`，否则默认 `fresh`            |

默认执行配置为 codex、当前工作目录、审批 `ask`、超时 120000 毫秒。可在 `contexts.items` 中增加 workspace：

```json
{
  "namespace": "octo.execution",
  "name": "workspace",
  "payload": { "mode": "fixed", "path": "/absolute/workspace" }
}
```

stdout 为 NDJSON，每行一个 `HostFrame`，canonical 事件位于 `frame.event`。退出码：0 完成，1 校验/启动/Provider/交互失败，130 取消或 Ctrl+C，143 SIGTERM。输入上限为 16 MiB。

出现审批或问答时，playboard 输出交互 frame 后以 `PLAYBOARD_INTERACTION_REQUIRED` 失败，不继续接收答复。独立 App 的持续会话和交互使用 SDK。

OpenClaw 可先配置 profile 的连接，再通过 Context 指定已有 Agent：

```bash
octo-harness --home "$HARNESS_HOME" --profile "$HARNESS_PROFILE" \
  adapter connect openclaw --openclaw-home /absolute/openclaw-home
octo-harness --home "$HARNESS_HOME" --profile "$HARNESS_PROFILE" adapter probe openclaw
```

adapter payload 使用 `{ "type": "openclaw", "provider_agent_id": "main" }`。playboard 支持 `--home` / `--profile` 选择连接来源；该调用仍为独立本地调试，不通过 daemon 调度。

完整命令参见 [CLI 使用说明](apps/cli/README.md)。

## 2. 作为 SDK 接入独立 App

独立 App 通过 daemon SDK 管理内置 Runtime，通过本地 SDK 或远程 Worker API 唤起 Agent。Node.js 服务和桌面 App 均可使用；纯浏览器不能直接运行 Node Runtime，需要由本机宿主或后端承接。

| 开发需求                                | 接入入口                                     |
| --------------------------------------- | -------------------------------------------- |
| 按宿主策略启动本地 Runtime          | `createDaemonRuntime()` + `startAccount()` |
| 获取本地 Runtime ID 与独立模块状态 | `health()` / `onHealth()`                    |
| 探测本机执行引擎                        | `listAdapters(runtimeId)`                    |
| 本机直接执行一轮 Agent                  | `invoke(adapterType, request, options)`      |
| 从任意 App 经服务端远程调用 Agent       | Worker `POST /v1/agent_run/submit`                     |
| 接收远程执行输出                        | Worker 当前执行流接口，SSE                   |
| 取消和回复交互                          | 本地 SDK 方法或远程 Worker API               |

### 2.1 安装 SDK 与准备接入配置

```bash
pnpm add @mininglamp-oss/octo-harness-daemon @mininglamp-oss/octo-harness-protocol
```

宿主需要提供：

| 配置                         | 用途                                      |
| ---------------------------- | ----------------------------------------- |
| `appId`                      | 稳定产品标识，用于生成 profile 名         |
| `home`                       | 产品专属的本地绝对目录，保存 Runtime 状态 |
| 用户 `uid`                   | 宿主业务的稳定 subject 身份；本地 SDK 不要求 Octo 登录 Token                |
| 宿主授权的完整 tenant 列表          | 每个 Space 建立独立 Runtime profile       |
| 可选模块配置 | 仅启用连接时提供服务地址与凭据；本地执行不要求 |

SDK 要求 Node.js 24+。桌面 App 在具有 Node 能力的宿主进程中使用 SDK，凭据不传给 renderer。真实执行还要求 HostApp 已决定安装相应 Provider 并完成认证；SDK 不会在执行时自行决定安装。

Home 使用 SDK 的 `resolveDaemonHome(appId)` 或产品指定路径，与 standalone CLI 的 Home 分开。Octo Work 指定自己的 `~/.octo-harness-work`；第三方 App 不需要复用这个目录名。

### 2.2 本地启动与可选云端接入

Node.js 24+ 宿主仅使用本地执行时：

```ts
import {
  createDaemonRuntime,
  resolveDaemonHome,
  type DaemonHealth
} from "@mininglamp-oss/octo-harness-daemon";

export const harness = createDaemonRuntime({
  appId: "customer-app",
  home: resolveDaemonHome("customer-app")
});

export async function startRuntime(session: {
  uid: string;
  spaces: Array<{ spaceId: string; name?: string }>;
}): Promise<DaemonHealth> {
  return harness.startAccount({
    subject: { type: "user", id: session.uid },
    tenants: session.spaces.map(space => ({ id: space.spaceId, name: space.name }))
  });
}
```

本地启动创建 Home、machine_id、隔离 profile 和稳定 Runtime ID，然后启动本地 IPC 与共享 Host。不申请 enrollment、不发送设备上报、不读取 Human Token，也不加载 worker-access。Eva2.0 可直接复用 daemon 包及其生产依赖，不需要拷贝 worker-access 或原 embedded 代码。

标准产品需要云端接入时，由 HostApp 额外安装并携带 worker-access。在创建 SDK 时登记工厂位置；登记本身不启用：

```ts
const standardRuntime = createDaemonRuntime({
  appId: "standard-app",
  home: resolveDaemonHome("standard-app"),
  modules: [{
    id: "worker-access",
    module: import.meta.resolve("@mininglamp-oss/octo-harness-worker-access/daemon-module"),
    exportName: "createWorkerAccessModule"
  }]
});
await standardRuntime.startAccount({ subject, tenants });
// 仅在宿主明确启用时调用；凭据只在 main/Node 宿主及本地 IPC 内传递。
await standardRuntime.startModule("worker-access", {
  registrations: [{
    id: tenants[0].id,
    humanToken: currentHumanToken,
    serverUrl: "https://im-test.deepminer.com.cn",
    agentWorkUrl: "https://im-test.deepminer.com.cn/agentworker/api"
  }]
});
```

该工厂承接现有 enrollment 和 Worker 连接实现，最终 access/设备 WS 职责仍待架构评审。模块注册和连接失败只反映在模块状态，不改变本地 ready。Human Token 和一次性 grant 不落盘，长期 Runtime credential 留在 worker-access 管理的 profile 中；注册沿用本地 Runtime ID，不创建 Agent。

IM 接入独立携带 channel-im 并登记其 `createImModule` 工厂。宿主显式 `startModule("channel-im", { bots })` 或启动后通过 `requestModule("channel-im", "upsert", { config })` 添加 bot。不需要同时携带或启用 worker-access。

参考实现：[Octo Work DaemonRuntimeService](../octo-harness-work-app/src/main/daemon-runtime-service.ts)。正式桌面宿主通过 `DaemonRuntimeOptions.distribution` 指定已安装的 Node、runner、manifest 和 adapter-host 入口；SDK 不自动安装这些依赖。公开类型见 [SDK 类型](packages/octo-harness-daemon/src/runtime/types.ts)。

### 2.3 获取 Runtime ID 和管理生命周期

```ts
export function currentRuntime(spaceId: string) {
  const health = harness.health();
  const profile = health.profiles.find(item => item.tenantId === spaceId);
  return {
    runtimeId: profile?.runtimeId,
    localReady: health.local.ready && health.local.adapterHostReady,
    modules: health.modules,
    phase: health.phase,
    problem: health.problem
  };
}

export function watchRuntime(publish: (health: DaemonHealth) => void) {
  return harness.onHealth(publish);
}
```

`running` 只表示本地就绪。可选连接状态查看 `health.modules`：Worker 的 `state.runtimes[].connected` 才表示当前连接；注册 ACK 和本地 profile 的 `ready` 均不能当作云端在线证据。`onHealth()` 立即发送当前快照，返回取消订阅函数。

| App 行为 | 调用方式 |
| --- | --- |
| UI 切换当前 Space | 按 tenantId 选择本地 Runtime；授权集合未变时不重启 |
| 授权 Space 集合变化 | `reconcileTenants(完整新列表)`；当前实现重启，宿主重新应用已启用模块配置 |
| 切换账号 | `stop("account-switch")`，然后为新账号 `startAccount()` |
| 退出登录 / App 退出 | `stop("logout")` / `stop("quit")` |
| 关闭一个连接模块 | `stopModule(id)`，本地 Host 继续工作 |
| 操作已启用模块 | `requestModule(id, method, params)` |

普通 stop 保留本地身份和已保存凭据。重新 enrollment 属于 worker-access：显式 `requestModule("worker-access", "reset", { tenantId })` 清理目标凭据，再由宿主显式启动该模块重新注册；本地 Runtime ID 保持稳定。此操作不是聊天会话 reset。

### 2.4 业务目标与执行配置

Runtime 是执行对象，Agent 是业务目标；`runtime_id`、`agent_id` 和 Provider 名称不可互换。

HostApp 的业务层负责 Agent 定义、目标选择、defaults／mandatory、工作区和本轮五元组。应用把处理完成的执行请求交给 SDK；本地执行不要求 Worker 中存在 Agent 记录，也不查询 Worker 默认 Agent、readiness 或 Context configuration 接口。

Worker 不负责 Agent registry、默认 Agent 自动创建或业务配置合并。业务授权由业务方处理；执行边界仍校验调用者、Runtime、租户及必要资源权限。不能用传入 Agent ID 替代认证。

仅需要远程设备时，使用 Worker 当前 Runtime 查询合同选择已登记且有权访问的对象。云端列表是登记视图，不是所有本地设备／Runtime 的存在性清单。远程调用见第 2.6 节。

### 2.5 本地唤起 Agent：调用 SDK invoke

适合在 App 当前设备直接执行，调用链为 `App -> daemon SDK -> daemon -> Host -> Adapter`。以下示例与第 2.2 节放在同一个宿主模块，使用 codex 和已准备好的绝对工作目录。

```ts
import { randomUUID } from "node:crypto";
import {
  assertInvokeRequest,
  type CanonicalEvent,
  type InvokeRequest,
  type ProviderSession
} from "@mininglamp-oss/octo-harness-protocol";

export async function* invokeLocalAgent(input: {
  spaceId: string;
  agentId: string;
  agentSessionId: string;
  workdir: string;
  text: string;
  signal: AbortSignal;
  providerSession?: ProviderSession;
}): AsyncGenerator<CanonicalEvent> {
  const runtime = currentRuntime(input.spaceId);
  if (!runtime.localReady || !runtime.runtimeId) {
    throw new Error("LOCAL_RUNTIME_UNAVAILABLE");
  }
  const adapters = await harness.listAdapters(runtime.runtimeId);
  if (!adapters.some((item) => item.type === "codex" && item.available === true)) {
    throw new Error("ADAPTER_UNAVAILABLE");
  }
  const request: InvokeRequest = {
    protocolVersion: 2,
    invocationId: `invoke_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    agentSessionId: input.agentSessionId,
    agentSource: "provisioned",
    prompt: input.text,
    modelInput: input.text,
    controlInstructions: "",
    workdir: input.workdir,
    approvalMode: "ask",
    context: {
      schema: "octo.context-envelope/v3",
      items: [
        { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } },
        {
          namespace: "octo.execution",
          name: "workspace",
          payload: { mode: "fixed", path: input.workdir }
        },
        { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
      ]
    },
    agentConfig: { workdir: input.workdir },
    runMetadata: { runtimeId: runtime.runtimeId, agentId: input.agentId },
    continuityMode: input.providerSession ? "continue" : "fresh",
    ...(input.providerSession ? { providerSession: input.providerSession } : {}),
    signal: input.signal
  };
  assertInvokeRequest(request);

  let terminal = false;
  for await (const event of harness.invoke("codex", request, { protocolMode: "canonical" })) {
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) terminal = true;
    yield event;
  }
  if (!terminal)
    throw new Error(input.signal.aborted ? "CANCELLED" : "HOST_ENDED_WITHOUT_TERMINAL");
}
```

关键输入：

| 字段                     | 接入约定                                                         |
| ------------------------ | ---------------------------------------------------------------- |
| `agentSessionId`         | 宿主保存的执行会话 ID；同一会话复用，每次新 Run 仍生成独立 ID    |
| `runId` / `invocationId` | 本轮执行与 Host 调用 ID，用于事件关联、取消和交互                |
| `runMetadata.runtimeId`  | 当前 Space 的 Runtime ID；多 Space App 必须显式选择              |
| `runMetadata.agentId`    | 本地业务关联信息；不会触发 SDK 自动读取云端 Agent 配置或执行授权 |
| `workdir`                | 宿主已准备的绝对本地工作目录                                     |
| `context`                | 本轮 Context v3，含执行配置及宿主选择的模型上下文                |
| `providerSession`        | 上一轮真实返回的 Provider 绑定；用于请求续聊                     |

上例展示基础执行合同。接入业务 Agent 时，先解析其 defaults/mandatory，并把模型、工作区、审批等配置同时映射为一致的 Context 和执行字段。参考 [Octo Work prepareLocalAgentRun](../octo-harness-work-app/src/main/local-agent-run-access.ts)，需要工作区准备时可调用 SDK 公开导出的 `prepareRunContext()`。

本地 `invoke()` 不会自动创建 Worker 的业务 Event，也不会仅凭传入 `agentId` 自动实现云端 Agent 授权。需要服务端调度、授权和调用记录时使用远程路径。

返回值与控制方法：

| SDK 方法或事件                                          | 说明                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `invoke(..., { protocolMode: "canonical" })`            | 返回 `CanonicalEvent` 异步流，适合跨 Provider 展示                                |
| `invokeFrames()`                                        | 返回带序号、stream ID 和协议信息的完整 `HostFrame`                                |
| `session.update`                                        | 保存 `payload.providerSession`，供后续续聊使用                                    |
| `interaction.requested`                                 | 显示审批/问答，再调用 `respondRun()`                                              |
| `respondRun(runId, { interactionId, outcome, value? })` | 回答 canonical 交互；outcome 为 `accepted`、`declined`、`answered` 或 `cancelled` |
| `cancelRun(runId)` / abort signal                       | 请求取消；最终状态以终态事件为准                                                  |
| `run.completed` / `run.failed` / `run.cancelled`        | 完成、失败、取消；流关闭本身不代表成功                                            |

默认 `invoke()` 为 native 模式，返回 `HostFrame`；上述示例显式选择 canonical。使用原生交互时对应 `respondNativeRun()`。缺失终态、流异常或主动结束消费，都应由 App 处理为明确的中断状态。

### 2.6 可选远程执行：Worker 接入

远程路径为 `业务应用 → Worker 执行 API → 已连接 Runtime → 共享 Host → Adapter`。它只适用于 HostApp 明确启用的 Worker 接入；客户只需本地或 IM 时不携带 worker-access。

当前 Worker 的执行入口是 `POST /v1/agent_run/submit`，执行流与查询分别为 `GET /v1/agent_run/event_stream`、`GET /v1/agent_run/get`，取消为 `POST /v1/agent_run/cancel`。交互按当前 interaction 合同处理。服务地址、认证主体、权限、请求体及查询参数以 [Worker 路由](../octo-agent-worker/internal/handler/router.go)和[当前 OpenAPI](../octo-agent-worker/openapi/swagger.yaml)为准；不能将本地 InvokeRequest 直接当作远程提交体。

旧 `/v1/events`、Worker Agent default／configuration 及业务 Event／ActionExecution 记录入口已退出本轮设计，本文不再提供这些调用示例。业务方保存自己的触发事实、幂等语义和本轮快照，并提交准备完成的 Run；执行不先创建 Worker 业务记录。

远程提交、取消、模块启动的接纳均不是执行终态。调用方必须消费真实执行事件；实时流与有界内存窗口不能当作永久历史或可靠业务投递。连接失败不删除本地身份，也不影响独立本地 invoke。

现有 `createWorkerAccessModule` 仍承接注册、Worker WS 与远程执行，最终 access／设备 WS 职责待架构评审。注册沿用 SDK 本地 Runtime ID，但不能把当前工厂当作最终注册专用模块或宣称所有远程场景已经验收。

### 2.7 会话和 Context 接入规则

当前 Context 固定为 `octo.context-envelope/v3`，Host 请求为 `protocolVersion=2`，远程内部 Run 为 `schema_version=7`，三者属于不同协议。

每轮模型上下文由 App 决定内容、顺序和发送时机。首次可发送背景，续聊无变化时可发送空列表，也可显式重复发送。底层不按 session ID 补齐、合并或去重模型上下文；adapter、runtime、workspace、model、limits、envs 和审批等执行项不注入模型文本。

本地续聊保存真实 `providerSession`；远程续聊复用业务 `session_id`，Provider 绑定由执行链管理。session 标识存在不保证 Provider resume 成功。reset、新建 Provider 会话或恢复失败后，由 App 决定并重新提供必要背景。

生命周期问题使用 `DaemonRuntimeError.code/scope/retryable` 或 health 的 `problem` 判断；执行流也可能抛出普通 Error。SDK 的本地流是有界内存窗口，Worker 远程 SSE 是实时流，两者都不能当作永久历史存储。

### 2.8 Octo Work 参考代码

| 文件                                                                                        | 参考内容                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [DaemonRuntimeService](../octo-harness-work-app/src/main/daemon-runtime-service.ts)     | 本地生命周期、独立可选连接、当前 Runtime 选择和健康投影 |
| [prepareLocalAgentRun](../octo-harness-work-app/src/main/local-agent-run-access.ts)         | 解析 Agent 配置、选择 Adapter、准备工作区和构造 InvokeRequest            |
| [AgentConversationService](../octo-harness-work-app/src/main/agent-conversation-service.ts) | 本地事件消费、Provider session 保存、交互、取消与历史存储                |
| [AgentWorkClient](../octo-harness-work-app/src/main/agent-work-client.ts)                   | 宿主业务 API 封装、Runtime／远程请求与 Human Token/Space 请求头                        |
| [宿主 main 入口](../octo-harness-work-app/src/main/index.ts)                                | `notifyAuthChange` 统一处理认证变化，再调用 SDK 更新运行状态             |

Octo Work 的 `AgentWorkClient` 是宿主私有封装，不是 Harness 发布的 HTTP SDK。第三方 App 可参考其请求方式，自行封装第 2.4/2.6 节接口；本地执行则直接依赖公开 daemon SDK。

更多字段见 [SDK 导出](packages/octo-harness-daemon/src/runtime/index.ts)、[SDK 类型](packages/octo-harness-daemon/src/runtime/types.ts)、[执行协议](packages/octo-harness-protocol/src/index.ts)、[Worker 路由](../octo-agent-worker/internal/handler/router.go) 及 [Runtime 合同](docs/runtime-local-and-online-contract.md)。
