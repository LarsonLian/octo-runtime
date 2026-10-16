# Octo Runtime SDK 原生接入指南

## 背景与适用场景

本指南面向需要把 Runtime 执行能力融入自身产品的客户宿主应用。**基于 Electron 或 Tauri 2 的桌面程序必须通过 SDK 原生接入，严禁使用 CLI 接入。** 宿主直接调用 SDK，管理 Runtime 生命周期、Adapter 和 Extra 装配、配置、执行及交互答复；不得依赖全局 CLI、拼接 CLI 命令、解析终端输出，或借用 CLI 的系统服务作为业务接入层。

调用链为 `客户宿主应用 → daemon SDK → daemon → Host → Adapter`。SDK 接入仍可能启动独立的 daemon、Host 或 Provider 子进程，部分 Adapter 也依赖 Provider CLI；这些执行依赖由宿主的安装、打包及生命周期方案管理。

Electron 在具备 Node.js 能力的主进程中调用 SDK。Tauri 2 需要由宿主准备具备 Node.js 能力的辅助进程，在其中调用 SDK，再桥接到应用；不能直接在 Rust 或 WebView 中导入 Node.js SDK。本指南给出 Node.js 宿主和 Electron 发行路径示例，不提供现成的 Tauri 插件。

[CLI 使用指南](CLI_USAGE_GUIDE.md)面向云端设备的定制接入、部署和运维。CLI 发行物默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力；SDK 宿主自行决定依赖与装配范围，不必沿用 CLI 的默认集合。

接口依据为 2026-10-16 当前工作区源码。参考 App 为同级目录的 [Octo Work](../octo-work-app)。服务地址、Token、ID 和本地路径须替换为实际配置；本次文档分拆不新增 SDK API。

> **配置来源由宿主决定。** SDK 接收配置对象；宿主可从内存、文件、SQLite、其他数据库或配置平台读取配置。CLI 的 JSON 文件和 Octo Work 的 SQLite 都是具体入口的选择，不是 SDK 接入限制，详见第 1.2 节。

## 1. Runtime：设备与 invoke 执行管理

Runtime 负责设备身份、本地执行生命周期和统一 `invoke` 管理。HostApp 决定安装和装配哪些 Extra；框架只提供 Extra 加载、卸载、资源清理和自定义状态转发。外部连接、认证、重连、业务路由、业务状态和结果投递由 Extra 自己处理，不属于 Runtime 的设备或执行管理合同。Extra 的业务状态不作为本地 `invoke` 的就绪条件。

RuntimeDevice 表示客观存在的 Runtime 设备。设备始终在那里；安装并初始化 Runtime 后，本地执行身份由本地保存。未注册、未公开远程可见、未连接远程服务或连接中断，都不意味着设备不存在，也不撤销已经保存的本地 Runtime 身份。停止进程只改变运行状态，设备及保存的身份仍然存在。

按最新[设备与虚拟 Runtime 决策](.octospec/tasks/device-virtual-runtime-boundary/brief.md)，一台设备可承载多个虚拟 Runtime，Extra 属于设备 Host。下文 `startAccount({ subject, tenants })` 和 profile 描述当前 SDK 实现，不能视为所有宿主都必须采用的身份模型；相关参数与存储迁移尚未实施。不得为适配此概念澄清而重置既有 Home、身份或配置。

HostApp 决定安装、启用哪些 Extra，以及授权范围和是否开放远程访问。Extra 负责与外部系统建立连接、业务认证和结果投递；AdapterHost 只提供共享执行能力。远程服务中的登记记录用于远程发现和访问，不决定本地设备是否存在；公开远程可见也不意味着所有人都有调用权限。

### 1.1 Extra 的外部接入方式

当前架构讨论包含以下两种连接方式：

| 连接方式 | 职责 | 状态与接入说明 |
| --- | --- | --- |
| IM Extra | 插件管理与外部 IM 的连接 | Octo 使用 `channel-gateway`，企业微信使用 `channel-wecom`；按第 2.6 节装配 |
| 独立 `agent-access` | 通过独立接入模块把 Runtime 公开为远程可见、可按授权访问的执行对象 | 尚未通过评审；最终职责、接口及实现需评审确定 |

HostApp 选择接入插件，插件决定其内部连接方式。接入以已有 RuntimeDevice 为基础；启用、停用或切换插件不删除本地身份。是否公开 Runtime 及访问范围受宿主与插件业务授权策略约束。

现有 `worker-access` 组合注册、Worker WS 与远程执行。其实现和旧 API 示例已迁到生态目录外独立仓库，当前产品不加载它。

Runtime 的设备与执行事实如下：

| 事实 | 含义与判断依据 |
| --- | --- |
| 设备存在／本地身份已保存 | 不依赖远程服务；初始化后的 Runtime ID 在本地保存 |
| 本地执行就绪 | 本地 IPC、Host 及所需 Provider 满足执行条件 |

设备存在不保证本地执行就绪；本地执行就绪不要求远程在线。远程调用还要求相应连接可用并通过权限校验。UI 和业务逻辑不得用单一 `online` 值决定设备是否存在，也不得因关闭远程可见或断线而移除本地设备身份。

这里的 RuntimeDevice 是设备职责说明，不新增同名 SDK 类或方法。外部登记、共享和连接状态由相应 Extra 定义和处理，不新增 Runtime 通用在线状态或连接管理接口。

### 1.2 配置来源与 SDK 契约

**配置从哪里读取、采用什么存储方式，以及配置更新的时机，完全由宿主开发者决定。** SDK 不要求宿主从某个固定目录读取特定配置文件，也不要求宿主采用 JSON 文件、SQLite 或某个配置平台。这是 SDK 的灵活性：宿主沿用自己的配置体系，通过同一套对象契约装配模块。

| 层次 | 责任与边界 |
| --- | --- |
| 宿主配置来源 | 宿主选择内存、JSON/YAML 文件、SQLite、其他数据库、自定义 store、远程配置平台或多个来源的组合 |
| 宿主配置管理 | 宿主负责读取、解析、保存、来源优先级及合并规则，并决定何时通过 SDK 应用配置；SDK 不自动订阅宿主的 store 或配置平台 |
| SDK／模块配置契约 | SDK 接收配置对象，SDK／模块按对应接口校验结构和字段语义；跨进程参数还须满足对应 IPC 的序列化要求 |
| SDK／模块内部运行状态 | SDK／模块按自己的约定管理 Home 内的 Runtime 身份、凭据及进程状态；这不规定宿主模块配置的来源 |

以 IM 接入为例，宿主读取配置并构造完整插件声明，通过 `loadExtra({ name, module, config: { bots } })` 加载。变更由宿主编排：等待 `unloadExtra(name)` 完成，修改并保存配置，再加载最新完整声明。同一插件内连接整体重建，其他 Extra 与共享 Host 不受影响。`config` 是对象参数，不是文件路径；完整示例见第 2.6 节。

**CLI 的默认文件加载行为不构成 SDK 接入要求。** [CLI 使用指南第 4 节](CLI_USAGE_GUIDE.md#4-接入-octo-im)通过统一的 `extraset` 将插件声明保存到 `<home>/extras/<name>/config.json`，由 CLI daemon 启动时加载；客户桌面 App 可以使用自己的 store，再通过 SDK 下发配置，无需创建或同步该文件。参考 Octo Work 把 IM 通道配置保存到应用自己的 SQLite，恢复时读取并通过 SDK 应用；SQLite 同样只是该 App 的选择，不是第三方宿主的必需依赖。

当前部分模块仍会在 Home/profile 下读写 `config.json`、Runtime 身份及设备凭据等内部文件。上述原则不表示 SDK 完全不访问磁盘，也不表示现有内部状态格式已经移除；它说明的是**宿主配置来源与模块执行能力分离**。宿主仍需满足所调用 API 的字段、认证、授权和生命周期要求。

## 2. SDK 原生接入步骤

独立 App 通过 daemon SDK 管理 Runtime 并本地调用 Agent，按需装配 Extra。Node.js 服务和桌面 App 均可使用；纯浏览器需要由具备 Node 能力的宿主或后端承接。远程调用必须由实际的业务插件提供，当前 SDK 不包含 Worker 接入。

| 开发需求                                | 接入入口                                     |
| --------------------------------------- | -------------------------------------------- |
| 按宿主策略启动本地 Runtime          | `createDaemonRuntime()` + `startAccount()` |
| 获取本地 Runtime ID 与插件生命周期状态 | `health()` / `onHealth()` / `extraStatus()` |
| 探测本机执行引擎                        | `listAdapters(runtimeId)`                    |
| 本机直接执行一轮 Agent | `invoke(input, { signal })` |
| 加载完整插件声明 | `loadExtra(descriptor)`；已加载时拒绝重复加载 |
| 卸载插件并等待清理 | `unloadExtra(name)` |
| 查询插件内部状态 | `extraStatus(name)`，返回插件自定义 JSON 对象，默认 `{}` |
| 取消和回复交互 | `cancelRun()` / `respondRun()` |

### 2.1 准备内部模块与接入配置

以下配置以对象参数交给 SDK，配置来源由宿主决定，详见第 1.2 节。Home 用于 SDK 的运行状态管理，不是要求宿主保存业务或 IM 模块配置的固定目录。

内部模块不从 npm 安装。维护者可构建后手动拷贝完整的 SDK 及生产依赖目录，也可将目标 App 与 octo-runtime 两个源码仓库相邻放置，构建 Runtime 后通过文件路径引用，例如 `../octo-runtime/packages/octo-runtime-daemon/dist/index.js`（实际相对路径取决于引用文件的位置）。文件引用不受对外根包 exports 限制；模块内部的依赖仍须由 Runtime workspace 或已拷贝的 node_modules 提供，不能只拷贝单个入口文件。若直接引用 TypeScript src，目标 App 必须显式配置跨仓库编译与依赖解析。

宿主需要提供：

| 配置                         | 用途                                      |
| ---------------------------- | ----------------------------------------- |
| `appId`                      | 稳定产品标识，用于生成 profile 名         |
| `home`                       | 产品专属的本地绝对目录，保存 Runtime 状态 |
| 用户 `uid`                   | 宿主业务的稳定 subject 身份；本地 SDK 不要求 Octo 登录 Token                |
| 宿主授权的完整 tenant 列表          | 每个 Space 建立独立 Runtime profile       |
| 可选模块配置 | 仅启用连接时提供服务地址与凭据；本地执行不要求 |

SDK 要求 Node.js 24+。桌面 App 在具有 Node 能力的宿主进程中使用 SDK，凭据不传给 renderer。真实执行还要求 HostApp 已决定安装相应 Provider 并完成认证；SDK 不会在执行时自行决定安装。

Home 使用 SDK 的 `resolveDaemonHome(appId)` 或产品指定路径，与 standalone CLI 的 Home 分开。Octo Work 指定自己的 `~/.octo-runtime-work`；第三方 App 不需要复用这个目录名。

### 2.2 本地启动与宿主发行物

#### Adapter 加载责任与直接导入

CLI 的默认清单是 `apps/cli/src/default_adapters.json`，构建到 CLI dist。SDK 不读取或复制它。客户产品在自己的独立 Host 入口直接 import 所需 Adapter，再把入口路径交给 SDK；支持 20 个不表示客户必须加载 20 个。仓库内 SDK 自带入口在代码中保留当前 12 个默认项，宿主需要不同集合时指定自己的入口。

宿主 App 自行管理生产依赖、依赖裁剪和安装包内容，并确保选中模块及其必要依赖在正式包中能够解析。Runtime 只负责按选择加载和校验，不管理客户依赖树，也不保证“加载 5 个”就意味着“包里只有 5 个”。加载 Adapter 与安装、认证 Provider 是不同操作；安装决策始终属于 HostApp。

下面两个文件构成一个完整的本地启动示例。内部包名在 Runtime workspace 或宿主准备的完整依赖目录中解析，不表示 SDK 独立发布；源码引用和部署方式见上一节。宿主需要将两个 TS 文件编译成相邻的 ESM JS，并携带选中模块的生产依赖。详细中文注释是后续修改时必须保留的验收要求，见 [装配方案与注释清单](.octospec/tasks/adapter-composition-ownership/brief.md)。

SDK 由宿主管理生命周期：通过 `startAccount()` 启动本地 daemon／Host 子进程，通过 `stop("quit")` 在应用退出时回收。接入方无需先执行 CLI 的 `daemon install` 或 `daemon start`，也无需传入 `--foreground`。宿主应将正常退出流程接到 SDK 的 `stop()`；子进程对宿主存活的监测用于异常退出后的回收。

`customer-adapter-host.ts`：

```ts
// 由客户产品维护自己的选择：此产品只需要 Codex 和 Claude Code。
// 新增框架支持不会自动加入这个集合；所选模块及依赖必须由宿主打包提供。
import { codexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { claudeCodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";

// 此文件只作为独立 Host 子进程入口执行，不能从 Electron main import。
// 这里创建并注册所选实例，向 daemon 提供 stdio RPC；实例/函数不跨进程序列化。
// 重复类型或协议不合法会在就绪前失败；缺模块由 Node 报解析错误，不能伪造 ready。
// [] 是有效的空集合；调用未注册类型会失败，不会临时补加载。
// 注册成功不代表 Provider 已安装或认证：安装决策与准备仍属于 HostApp。
serveAdapterHost([codexAdapter, claudeCodeAdapter]);
```

`customer-runtime.ts`：

```ts
import {
  createDaemonRuntime,
  resolveDaemonHome,
  type DaemonHealth
} from "@mininglamp-oss/octo-runtime-daemon";
import { fileURLToPath } from "node:url";

export const harness = createDaemonRuntime({
  appId: "customer-app",
  // 固定使用本产品 Home，停止和更新时保留身份、profile 与配置。
  home: resolveDaemonHome("customer-app"),
  distribution: {
    // 相对当前编译后 JS 定位，转为绝对路径，不依赖启动工作目录。
    // SDK 只传入口路径；daemon 启动子进程后，才执行该文件中的 import。
    // 不提供 manifestPath，不需要终端用户维护另一份 JSON。
    adapterHostEntrypoint: fileURLToPath(new URL("./customer-adapter-host.js", import.meta.url))
  }
});

export async function startRuntime(session: {
  uid: string;
  spaces: Array<{ spaceId: string; name?: string }>;
}): Promise<DaemonHealth> {
  // 启动过程等待 Host 握手；模块加载或入口错误由启动失败/health.problem 暴露。
  // Host 崩溃后仍使用同一入口恢复，不读取 CLI 清单、不重放中断的调用。
  // 更新选择需由宿主协调退出和重启，不能在活动调用中偷偷换集合。
  return harness.startAccount({
    subject: { type: "user", id: session.uid },
    tenants: session.spaces.map(space => ({ id: space.spaceId, name: space.name }))
  });
}

// 必须接入宿主退出流程，等待 daemon/Host 清理资源；不能只退出主进程。
export async function stopRuntime(): Promise<void> {
  await harness.stop("quit");
}
```

本地启动创建 Home、machine_id、隔离 profile 和稳定 Runtime ID，然后启动本地 IPC 与共享 Host。不申请 enrollment、不发送设备上报、不读取 Human Token，也不加载 worker-access。Eva2.0 可直接复用 daemon 包及其生产依赖，不需要拷贝 worker-access 或原 embedded 代码。

Worker 接入预研已迁到生态目录外的 `octo-runtime-worker-access` 独立仓库，仅作备份，不参与当前发行物。

IM 接入独立安装对应 Extra，通过 `extras` 初始声明或运行中的 `loadExtra` 装配，见第 2.6 节。不需要 Worker。渠道接入统一使用 Extra 声明，daemon/CLI 不提供渠道专用装配入口。

参考实现：[Octo Work DaemonRuntimeService](../octo-work-app/src/main/daemon-runtime-service.ts)。正式桌面宿主通过 `DaemonRuntimeOptions.distribution` 指定已安装的 Node、runner 和自己的 adapter-host 入口；SDK 不自动安装这些依赖。类型见 [SDK 类型](packages/octo-runtime-daemon/src/runtime/types.ts)。旧 `manifestPath` 显式覆盖暂时保留兼容：仅在主动指定时走 JSON loader，并非 SDK 默认来源。

桌面正式包应随发行物准备以下布局，具体路径由宿主决定：

```text
resources/runtime/
  node/bin/node                 # Windows 为 node.exe
  sdk/dist/runtime/runner.js
  customer-adapter-host.js       # 上面示例编译后的独立入口
  sdk/modules/extra-channel-gateway/dist/index.js
  sdk/modules/extra-channel-wecom/dist/index.js
```

将前三项绝对路径依次传给 `distribution.nodePath/runnerPath/adapterHostEntrypoint`，插件默认入口绝对路径传给 `descriptor.module`。自定义 Host 的 import 必须能从该文件所在位置解析，例如由宿主在 runtime/node_modules 放置完整依赖；不能只把入口丢到孤立目录。每个插件同样要携带生产依赖。参考 [Work App 打包脚本](../octo-work-app/scripts/prepare-embedded-runtime.mjs) 的独立 deploy 和固定 Node 准备。纯 Node 24 宿主可复用当前 Node；Electron 正式包不能依赖用户 PATH 中偶然存在的 Node。

例如，Electron main 进程可将第 2.2 节的 `harness` 初始化替换为以下代码。`resources/runtime` 必须由宿主打包流程实际准备，下面的路径与上面的布局对应：

```ts
import { join } from "node:path";

const runtimeRoot = join(process.resourcesPath, "runtime");
const sdkRoot = join(runtimeRoot, "sdk");
export const harness = createDaemonRuntime({
  appId: "customer-app",
  home: resolveDaemonHome("customer-app"),
  distribution: {
    nodePath: process.platform === "win32"
      ? join(runtimeRoot, "node", "node.exe")
      : join(runtimeRoot, "node", "bin", "node"),
    runnerPath: join(sdkRoot, "dist", "runtime", "runner.js"),
    // 本产品自己的直接 import 入口，必须连同依赖一起交付；不复用 CLI JSON。
    // 若明确采用仓库 SDK 的 12 项选择，可指向 sdk/dist/runtime/adapter-host.js。
    adapterHostEntrypoint: join(runtimeRoot, "customer-adapter-host.js")
  }
});
```

桌面插件入口同样使用实际资源路径，例如 `join(sdkRoot, "modules", "extra-channel-gateway", "dist", "index.js")`。上述目录是客户发行布局示例；Work App 的实际目录名为 `resources/embedded-runtime`，以其打包脚本为准。

### 2.3 获取 Runtime ID 和管理生命周期

SDK API 在宿主进程中使用；SDK 管理的 daemon 子进程使用 `detached: false`，监测宿主进程存活，宿主退出后执行回收。daemon 和 AdapterHost 在子进程中执行，生命周期由宿主管理。宿主不调用 CLI 的 `daemon start`，也不安装 CLI 原生服务。

```ts
export function currentRuntime(spaceId: string) {
  const health = harness.health();
  const profile = health.profiles.find(item => item.tenantId === spaceId);
  return {
    runtimeId: profile?.runtimeId,
    localReady: health.local.ready && health.local.adapterHostReady,
    extras: health.extras,
    phase: health.phase,
    problem: health.problem
  };
}

export function watchRuntime(publish: (health: DaemonHealth) => void) {
  return harness.onHealth(publish);
}
```

本地 Runtime ID 从 `health.profiles` 获取。`running` 表示本地就绪，`health.extras?.[name]?.phase` 仅表示插件加载生命周期，不描述插件业务。`extraStatus(name)` 原样转发插件自定义 JSON，框架不解释或汇总其中的业务状态。`onHealth()` 立即发送当前快照，返回取消订阅函数。

| App 行为 | 调用方式 |
| --- | --- |
| UI 切换当前 Space | 按 tenantId 选择本地 Runtime；授权集合未变时不重启 |
| 授权 Space 集合变化 | 先停止受影响连接，再 `reconcileTenants(完整新列表)`，以新授权范围重新应用插件配置 |
| 切换账号 | `stop("account-switch")`，然后为新账号 `startAccount()` |
| 退出登录 / App 退出 | `stop("logout")` / `stop("quit")` |
| 关闭一个插件 | `unloadExtra(name)`，保留设备身份和共享 Host |
| 更新插件完整声明 | 宿主等待 `unloadExtra(name)`，保存配置，再 `loadExtra(descriptor)` |
| 转发插件自定义状态 | `extraStatus(name)`；默认 `{}`，含义由插件定义 |

普通 stop 保留本地身份。聊天 reset 与本地 Runtime 生命周期独立；当前主项目不执行 Worker 重新 enrollment。

### 2.4 业务目标与执行配置

Runtime 是执行对象，Agent 是业务目标；`runtime_id`、`agent_id` 和 Provider 名称不可互换。

HostApp 的业务层负责 Agent 定义、目标选择、defaults／mandatory、工作区和本轮五元组。应用把处理完成的执行请求交给 SDK；本地执行不要求 Worker 中存在 Agent 记录，也不查询 Worker 默认 Agent、readiness 或 Context configuration 接口。

本地 SDK 不提供业务 Agent registry、默认 Agent 自动创建或业务配置合并。业务授权由业务方处理；执行边界仍校验调用者、Runtime、租户及必要资源权限。不能用传入 Agent ID 替代认证。

选择当前设备的本地 Runtime 时，使用本地 profile 和执行就绪状态，远程 online 不参与设备存在性判断。若业务需要访问远程设备，必须另行装配实际提供发现、授权和调用能力的插件；本指南不提供已归档 Worker 路径的操作步骤。

### 2.5 本地唤起 Agent：调用 SDK invoke

适合在 App 当前设备直接执行，调用链为 `App -> daemon SDK -> daemon -> Host -> Adapter`。以下示例与第 2.2 节放在同一个宿主模块，使用 codex 和已准备好的绝对工作目录。

```ts
import { randomUUID } from "node:crypto";
import {
  InvokeInput,
  type CanonicalEvent,
  type ProviderSession
} from "@mininglamp-oss/octo-runtime-protocol";

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
  const execution: InvokeInput & { protocol_mode: "canonical" } = {
    inputs: [{ type: "text", text: input.text }],
    protocol_mode: "canonical",
    invocationId: `invoke_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    sessionId: input.agentSessionId,
    agentSource: "provisioned",
    prompt: input.text,
    modelInput: input.text,
    controlInstructions: "",
    workdir: input.workdir,
    approvalMode: "ask",
    contexts: {
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
    ...(input.providerSession ? { providerSession: input.providerSession } : {})
  };
  InvokeInput.check(execution);

  let terminal = false;
  for await (const event of harness.invoke(execution, { signal: input.signal })) {
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
| `sessionId`              | 宿主保存的业务会话 ID；同一会话复用，每次新 Run 仍生成独立 ID    |
| `runId` / `invocationId` | 本轮执行与 Host 调用 ID，用于事件关联、取消和交互                |
| `runMetadata.runtimeId`  | 当前 Space 的 Runtime ID；多 Space App 必须显式选择              |
| `runMetadata.agentId`    | 本地业务关联信息；不会触发 SDK 自动读取云端 Agent 配置或执行授权 |
| `workdir`                | 宿主已准备的绝对本地工作目录                                     |
| `inputs`                 | 本轮有序 text/image 输入；本例只提交 text                        |
| `contexts`               | 本轮 Context v3，含执行配置及宿主选择的模型上下文                |
| `providerSession`        | 上一轮真实返回的 Provider 绑定；用于请求续聊                     |

上例直接构造公共 `InvokeInput`；`signal` 只通过 `invoke(input, { signal })` 的第二参数传递，不放入 JSON。`inputs` 与 `contexts` 必填，`contexts.items: []` 有效；只有执行配置时不要求额外提供业务背景。字段及默认值见 [InvokeInput 合同](.octospec/rules/invoke-input.md)。接入业务 Agent 时，先解析其 defaults/mandatory，并把模型、工作区、审批等配置同时映射为一致的 Context 和执行字段。参考 [Octo Work prepareLocalAgentRun](../octo-work-app/src/main/local-agent-run-access.ts)，需要工作区准备时可调用 SDK 公开导出的 `prepareRunContext()`。现有宿主若已生成内部 `InvokeRequest`，可用协议包的 `invocationInput()` 转为公共输入。

本地 `invoke()` 不会自动创建服务端业务 Event，也不会仅凭 `agentId` 自动授权。需要服务端调度、授权和调用记录时，由相应业务系统实现。

返回值与控制方法：

| SDK 方法或事件                                          | 说明                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `invoke({ ...input, protocol_mode: "canonical" }, { signal })` | 返回 `CanonicalEvent` 异步流，适合跨 Provider 展示 |
| `invoke({ ...input, protocol_mode: "native" }, { signal })` | 使用同一 `InvokeInput` 返回完整 `HostFrame` |
| `session.update`                                        | 保存 `payload.providerSession`，供后续续聊使用                                    |
| `interaction.requested`                                 | 显示审批/问答，再调用 `respondRun()`                                              |
| `respondRun(runId, { interactionId, outcome, value? })` | 回答 canonical 交互；outcome 为 `accepted`、`declined`、`answered` 或 `cancelled` |
| `cancelRun(runId)` / abort signal                       | 请求取消；最终状态以终态事件为准                                                  |
| `run.completed` / `run.failed` / `run.cancelled`        | 完成、失败、取消；流关闭本身不代表成功                                            |

默认 `invoke()` 为 native 模式，返回 `HostFrame`；上述示例显式选择 canonical。使用原生交互时对应 `respondNativeRun()`。缺失终态、流异常或主动结束消费，都应由 App 处理为明确的中断状态。

SDK 当前还保留 `invokeFrames(adapterType, request, options)`，其参数是内部 `InvokeRequest`，不是公共 `InvokeInput`；新接入使用上表的统一 `invoke()` 入口。

### 2.6 通过 SDK 装配可选 Extra

本节的 IM 配置仅演示具体 Extra 的用法。`bots`、连接状态和授权范围都是 IM Extra 的业务字段，不是 Runtime 通用概念；其他 Extra 可以使用完全不同的配置和状态结构。

Octo 使用 `octo-runtime-extra-channel-gateway`，企业微信使用 `octo-runtime-extra-channel-wecom`。由宿主选择需要的内部模块，从相邻源码仓库文件入口引用，或构建后手动拷贝完整生产依赖目录；这些模块不独立发布到 npm。下面的包名解析示例适用于宿主已准备好对应 node_modules 布局的情形，文件级接入时将模块入口改成实际文件 URL。

以下代码与前面的 harness 示例属于同一个宿主模块。宿主先完成 `startRuntime()`，再提交插件声明：

```ts
import { fileURLToPath } from "node:url";

export async function configureIm() {
  await harness.unloadExtra("channel-gateway");
  // 宿主在此保存自己的最新完整配置，再提交加载声明。
  return harness.loadExtra({
    name: "channel-gateway",
    module: fileURLToPath(import.meta.resolve("@mininglamp-oss/octo-runtime-extra-channel-gateway")),
    config: {
      authorized_space_ids: ["<AUTHORIZED_SPACE_ID>"],
      bots: [{
        api_url: "https://im-test.deepminer.com.cn/api",
        bot_id: "<BOT_ID>",
        bot_name: "本地助理",
        bf_token: "<BF_TOKEN>",
        adapter: { adapter_type: "codex", workdir: "/absolute/workspace", model: "gpt-6.1-sol", effort: "medium" }
      }]
    }
  });
}

export async function inspectIm() {
  const lifecycle = await harness.extraStatus();
  const pluginState = lifecycle["channel-gateway"]?.phase === "loaded"
    ? await harness.extraStatus("channel-gateway")
    : undefined;
  return { lifecycle, pluginState };
}

export async function stopIm() {
  await harness.unloadExtra("channel-gateway");
}
```

`import.meta.resolve` 在宿主安装位置解析为绝对入口，避免 runner 从自身目录找不到宿主依赖。桌面正式包应改用发行物中的绝对路径。若希望启动时自动加载，可将同一声明放入 `createDaemonRuntime({ appId, home, extras: [...] })`。

配置更新由宿主明确卸载、保存、重新加载；没有原地配置更新钩子或通用业务 RPC。同名插件仍加载时调用 `loadExtra` 返回 `EXTRA_ALREADY_LOADED`。卸载等待既有 `onDispose` 清理；清理失败不得继续加载。 加载过程中调用卸载会先传递停止信号，再等待初始化和清理结束；被取消的 SDK 加载返回 `EXTRA_LOAD_CANCELLED`。退出时清理失败仍继续回收进程，并将 `EXTRA_DISPOSE_FAILED` 返回给宿主。加载新配置会重建该插件内全部连接，不重启其他插件或共享 Host。保存成功、插件加载成功、Bot 连接成功分别反馈，加载失败不回滚宿主持久配置。

SDK 与 CLI 使用同一覆盖语义：最终配置由本次完整声明决定。单个 Bot 仍为长度 1 的数组；本次声明缺席的 Bot 或字段不从旧实例补齐。Bot 的 enabled 默认 true，false 时不连接，但仍出现在插件的 bots 状态数组中。

`authorized_space_ids` 是 IM 插件业务字段，由受信宿主提供，不是底层框架的通用租户字段。Octo 认证返回的 Space 必须在列表内；空数组不授权任何 Space。独立设备若不限定账号租户范围可省略该字段，但 Bot 自身认证仍执行。修改授权列表会重建该插件的连接以重新鉴权。WeCom 配置接受同一范围字段，但不据此伪造其没有的 Octo 租户身份。

SDK 保留成功加载的最新声明，用于同账号 reconfigure/runner 重启；load/unload 同步更新该 SDK 实例内的启用状态。它不替宿主持久化配置。logout/account-switch 清除动态声明并恢复构造时的初始声明；账号相关插件宜在登录后通过 loadExtra 提交，由宿主在新账号恢复自身配置。extraStatus() 返回生命周期；extraStatus(name) 调用插件同步 onStatus 回调，返回插件自定义 JSON 对象，默认 {}。框架不解释业务字段，状态回调不联网探测或修改配置。查询失败明确报错，不伪装为空对象。

Work App 从账号 SQLite 读取配置，使用本节的统一入口。它的显式 Bot 启用独立于历史 `connectionsEnabled` 设置；该字段不是 IM 总开关。单 Bot 关闭在 IM 配置中操作，卸载整个插件使用 unloadExtra。不要让同一连接同时走 modules 和 extras。

SQLite 是 Work App 的配置来源；每次加载重新读取保存的数据并在内存中生成完整 Extra config，不要求额外写入插件配置文件。App 不以某个 Bot 的执行引擎尚未安装或不可用为由阻断 Extra 加载。需要执行时，由执行层校验引擎并返回明确失败；认证和授权仍由插件在连接边界检查。

Octo Bot 的 `state` 为 stopped / connecting / online / retrying / failed，仅 online 对应 `connected: true`。首次连接失败返回 failed 和真实 `error`，不自动重试，补齐配置后由宿主显式重载。曾完整上线后的网络断线进入 retrying，按 5/10/20/30 秒恢复，后续保持 30 秒；完整重连成功自动清 error 和计数，下次断线从 5 秒开始。明确终端拒绝停止恢复；主动卸载取消等待与在途连接。框架仅转发状态，Extra loaded 不表示 Bot online；业务执行/投递诊断也不改变连接健康。WeCom 保持自身状态合同，详见 [Octo Bot 连接状态机](packages/octo-runtime-extra-channel-gateway/README.md#bot-连接状态机)。

### 2.7 会话和 Context 接入规则

当前 Context 固定为 `octo.context-envelope/v3`，Host 请求为 `protocolVersion=2`，远程内部 Run 为 `schema_version=7`，三者属于不同协议。

每轮模型上下文由 App 决定内容、顺序和发送时机。首次可发送背景，续聊无变化时可发送空列表，也可显式重复发送。底层不按 session ID 补齐、合并或去重模型上下文；adapter、runtime、workspace、model、limits、envs 和审批等执行项不注入模型文本。

本地续聊保存真实 `providerSession`，不从业务 sessionId 重建绑定。session 标识存在不保证 Provider resume 成功。reset、新建 Provider 会话或恢复失败后，由 App 决定并重新提供必要背景。

生命周期问题使用 `DaemonRuntimeError.code/scope/retryable` 或 health 的 `problem` 判断；执行流也可能抛出普通 Error。SDK 的本地流是有界内存窗口，不能当作永久历史存储。

### 2.8 Octo Work 参考代码

| 文件                                                                                        | 参考内容                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [DaemonRuntimeService](../octo-work-app/src/main/daemon-runtime-service.ts)     | 本地生命周期、独立可选连接、当前 Runtime 选择和健康投影 |
| [prepareLocalAgentRun](../octo-work-app/src/main/local-agent-run-access.ts)         | 解析 Agent 配置、选择 Adapter、准备工作区和构造 InvokeRequest            |
| [AgentConversationService](../octo-work-app/src/main/agent-conversation-service.ts) | 本地事件消费、Provider session 保存、交互、取消与历史存储                |
| [ImChannelService](../octo-work-app/src/main/im-channel-service.ts) | 宿主 SQLite 配置、逐 Bot 应用与恢复 |
| [ConversationRunTransport](../octo-work-app/src/main/conversation-run-transport.ts) | 已准备请求转换为统一 InvokeInput |
| [宿主 main 入口](../octo-work-app/src/main/index.ts)                                | `notifyAuthChange` 统一处理认证变化，再调用 SDK 更新运行状态             |

Octo Work 的业务服务和 SQLite 是宿主实现，不是 Runtime SDK 的接入要求。第三方 App 直接依赖公开 daemon SDK，沿用自身配置和历史存储。

更多字段见 [SDK 导出](packages/octo-runtime-daemon/src/runtime/index.ts)、[SDK 类型](packages/octo-runtime-daemon/src/runtime/types.ts)、[执行协议](packages/octo-runtime-protocol/src/index.ts)、[Extra 合同](.octospec/rules/extras.md)及 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)。

## 3. 预研归档

旧 Worker enrollment、CLI 远程注册及相关安装示例位于生态目录外的 `octo-runtime-worker-access/archive`，仅作历史参考，不保证可用。当前主项目不携带或加载该插件。
