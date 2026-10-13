# `@mininglamp-oss/octo-harness-embedded`

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

Embed one app-owned Octo Harness runtime in a Node.js or Electron host. The SDK owns Human-token enrollment, Harness Home layout, the daemon process, multi-Space profiles, shutdown, and health reporting. Host applications do not copy Harness onboarding or supervisor code.

## Install

```bash
pnpm add @mininglamp-oss/octo-harness-embedded
```

The package requires Node.js 24 or newer. Electron hosts call it from the main process, never from a renderer or preload script.

## Minimal setup

```ts
import { createEmbeddedHarness, resolveEmbeddedHome } from "@mininglamp-oss/octo-harness-embedded";

const harness = createEmbeddedHarness({
  appId: "customer-fde",
  home: resolveEmbeddedHome("customer-fde")
});

await harness.startAccount({
  subject: { type: "user", id: session.uid },
  tenants: session.spaces.map((space) => ({
    id: space.spaceId,
    name: space.name,
    serverUrl: "https://octo.example.com",
    agentWorkUrl: "https://octo.example.com/agentworker/api"
  })),
  getHumanToken: () => session.token
});
```

`getHumanToken()` returns the logged-in user's Human Token. For each authorized Space, the SDK calls `POST /v1/runtime_enrollments` with `Token` and `X-Space-ID`, exchanges the one-time grant, registers the Runtime, and persists only the resulting Runtime credential. Human tokens and grants are never written to disk, argv, environment variables, logs, or health events.

## Account and tenant behavior

The Home layout is deliberately split between one installation identity and isolated account data:

```text
<home>/
├── machine.json                         # stable for this app installation
├── run/ sockets/ octo-daemon.pid        # active account only
└── accounts/
    ├── <subject-key-A>/
    │   ├── config.json
    │   ├── state.db logs/
    │   ├── <app>-<tenant-hash-1>/
    │   └── <app>-<tenant-hash-2>/
    └── <subject-key-B>/
        └── ...
```

- Every account and tenant on the same app Home shares the same stable `machine_id`.
- Every tenant has its own profile, `runtime_id`, Runtime credential, WSS connection, and bounded in-memory replay window.
- All authorized tenants for the current account stay connected through one daemon and adapter-host.
- Switching the UI's current tenant does not call the SDK and does not restart the daemon.
- Switching accounts calls `stop('account-switch')` first. The new account cannot start until the old process tree and connections are gone.
- Profiles present on disk are not authority. Only the current `startAccount()` tenant allowlist is loaded.

## Health

```ts
const unsubscribe = harness.onHealth((health) => {
  console.log(health.phase, health.cloud.connectedProfiles);
});

const snapshot = harness.health();
```

`running` means the local daemon is ready and every authorized profile is online. `degraded` means the local runtime is usable but one or more profiles are offline or failed. Health values never contain credentials.

## Logout, account switch, and quit

```ts
await harness.stop("logout");
await harness.stop("account-switch");
await harness.stop("quit");
```

Calls are serialized. A stop aborts pending enrollment, drains active work, closes Runtime connections, then shuts down the owned process tree. A failed shutdown blocks a subsequent account start rather than mixing two account sessions.

## Windows

- The default Home is `%LOCALAPPDATA%\<appId>\OctoHarness`.
- Control IPC uses a Home-derived named pipe; no Unix `.sock` path is created.
- Child processes use `shell: false` and `windowsHide: true`, so paths with spaces or non-ASCII characters do not require command quoting and no console window appears.
- Packaged applications must ship the matching Windows x64 or arm64 Node.js 24 runtime. Production does not silently fall back to an unknown PATH Node.
- Normal shutdown is cooperative. A timed-out process is terminated only through the process handle created for the current SDK session; stale PID files are not trusted as ownership proof.
- Runtime credential files rely on the current user's `%LOCALAPPDATA%` ACL. UNC/network Homes are rejected because SQLite locking and atomic replacement are not reliable there.

## Relationship to `apps/daemon`

The standalone daemon application and this SDK are sibling entry points:

```text
@mininglamp-oss/octo-harness-daemon
  ├── apps/daemon
  └── @mininglamp-oss/octo-harness-embedded
```

Both reuse the same `startDaemonServer`, Agent Work supervisor, adapter-host, stores, and close protocol. `apps/daemon` remains responsible for CLI arguments and OS services. The embedded package adds host-account enrollment, nested account profiles, an app-owned process supervisor, and health aggregation. `apps/daemon` therefore does not depend on the embedded package and does not need a second daemon implementation.

## Scope

The package does not own login UI, SSO, tenant selection, Electron IPC, or renderer state. Hosts provide a stable user ID, a Human Token provider, and the complete authorized Space list. See [`docs/14-embedded-sdk-design.md`](../../docs/14-embedded-sdk-design.md) for the full design and acceptance criteria.

## 模块责任边界

- 负责：为 Node/Electron 宿主提供运行时生命周期、账户隔离和本地 IPC 接入。
- 不负责：在 renderer 存放凭据、IM 消息处理、绕过 Host 的 provider 执行。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
