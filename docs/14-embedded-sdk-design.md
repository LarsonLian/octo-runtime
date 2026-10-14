# Octo Runtime Embedded SDK 初始版方案

> 历史方案，2026-10-14 起不作为当前接入合同：embedded 独立包已删除，本地 API 合入 [daemon 包](../packages/octo-runtime-daemon/README.md)，enrollment 移入可选 worker-access。当前本地启动不注册、不要求 Human Token；以 [接入说明](../INTEGRATION.md#2-作为-sdk-接入独立-app) 为准。本文保留原设计记录。

> 2026-10-13 全局 Context 约束：每轮模型上下文由业务发起方决定，selection 等业务项可不发送；可传空、只传当轮需要的项或显式重复。必要的 adapter 等执行配置独立校验且不注入 LLM。底层只转发并渲染本轮快照，不按 sessionId 缓存、补齐、合并、去重或省略；reset、新建 Provider 会话或 resume 失败后，由业务方重新提供必要背景。详见 [Event Context IPD-SE 0.3](../../docs/event-context-rendering-ipd-se.md)。本文原有 Compiler/Pipeline、材料预取、场景自动追加与此约束冲突的内容仅保留历史背景；旧链路退出尚未完成。

> 状态：Draft
>
> 目标包：`@mininglamp-oss/octo-runtime-embedded`
>
> 适用场景：Octo Work、Runtime Register Demo、FDE/甲方桌面端、IDE 宿主及其他需要随应用内置 Runtime Runtime 的 Node.js 宿主。

## 1. 决策摘要

初始版提供一个与 Electron 无关的 Node.js Embedded SDK，把 Runtime Home、Runtime enrollment、
daemon/adapter-host 生命周期、跨平台 IPC、健康状态和异常回收统一封装。宿主只提供产品标识、
Home 根目录、当前账号可访问的租户集合和 Human Token。SDK使用每个租户的 Space ID 自行完成
`Token + X-Space-ID` 授权、一次性 enrollment grant、Runtime enroll/register 与凭据修复。

包名确定为 **`@mininglamp-oss/octo-runtime-embedded`**，不使用 `daemon-kit`：对宿主而言它是完整的
可嵌入 Runtime SDK，daemon 只是其内部复用的一层；`kit` 容易让人误以为这是工具函数集合，
`embedded` 能直接表达生命周期和发行方式。

运行模型固定为：

```text
一个宿主应用
└── 一个 app-owned Embedded Home
    ├── machine.json                         # 安装级，全局唯一且跨账号稳定
    ├── run/  sockets/  octo-daemon.pid      # 当前活动账号的瞬态生命周期
    └── accounts/
        ├── <subject-key-A>/
        │   ├── config.json                  # 账号级 default_profile
        │   ├── logs/
        │   ├── <app>-<tenant-1>/             # profile -> runtime-1
        │   └── <app>-<tenant-2>/             # profile -> runtime-2
        └── <subject-key-B>/
            ├── config.json
            ├── logs/
            └── <app>-<tenant-3>/             # 非当前账号时不加载
```

- **账号内多租户常驻**：当前账号所有已授权租户各有独立 profile、Runtime identity、credential、
  执行目录和有界内存回放窗口；共享一个 daemon、adapter-host 和安装级全局 `machine_id`。
- **切租户不影响 Runtime**：切换产品当前租户只是宿主 UI/请求上下文变化，不停止 daemon，
  不断开其他租户 WSS，也不改变 `default_profile`。
- **切账号完全隔离**：切账号必须先等待旧账号 `stop()` 完成；旧 daemon、adapter-host、定时器、
  内存授权、health session 和活动 profile allowlist 全部销毁后，才能在同一 Home 中启动新账号的
  profile 集合。账号切换不重建或改写 `machine.json`。
- **不扫描并启动历史账号**：SDK 只启动宿主本次传入且服务端仍授权的租户 profile，绝不以
  “磁盘上存在”为授权依据。
- **跨平台由 SDK 负责**：macOS/Linux 使用 Home 内 Unix socket；Windows 使用由绝对 Home
  路径哈希生成的 named pipe，不让宿主拼接 `.sock` 路径。

## 2. 目标与非目标

### 2.1 初始版目标

1. 宿主运行时代码用两个高层调用完成 SDK 创建与账号启动。
2. 同一账号的多个已授权租户可同时在线，切换当前租户不触发 daemon 重启。
3. 切换账号时提供可等待、可验证、fail-closed 的完整停止边界。
4. 提供同步 health 快照和订阅通道，宿主无需轮询或解析 daemon 原始响应。
5. 保持 Runtime machine/profile 文件 schema，Embedded SDK统一增加账号目录定位层；凭据不进入
   renderer、argv、环境变量或日志。
6. 支持 macOS、Windows；Linux 保留同构实现和自动化测试。
7. 用同一实现替换 Octo Work、Runtime Register Demo 中重复的 Home/enrollment/supervisor 逻辑；
   与 CLI 共用底层 profile schema、enrollment wire client 和 daemon runtime core。

### 2.2 初始版非目标

- 不提供 UI、React Provider、Electron IPC 或 preload bridge。
- 不接管宿主登录、SSO、租户选择和账号持久化。
- 不把甲方 JWT/OIDC token 直接当作 Runtime credential。
- 不支持两个账号在同一个 SDK 实例中同时在线。
- 不在初始版实现 daemon 运行中的 profile 热增删；授权租户集合变化允许受控重启。
- 不改变 Agent Worker 的 Runtime、profile、Space 和 owner 授权模型。
- 不让互不信任的宿主应用共享同一个 Home 或 daemon。

## 3. 两句话接入

宿主的目标调用面如下：

```ts
const harness = createEmbeddedHarness({ appId: 'customer-fde', home: resolveEmbeddedHome('customer-fde') })
await harness.startAccount({ subject: { type: 'user', id: user.id }, tenants, getHumanToken: () => auth.token })
```

甲方已有自己的应用数据目录时可直接传绝对路径：

```ts
const harness = createEmbeddedHarness({ appId: 'customer-fde', home: join(appDataPath, 'octo-runtime') })
await harness.startAccount({ subject, tenants, getHumanToken: () => auth.token })
```

`createEmbeddedHarness()` 不读取 Electron API。Electron 宿主可以把 `app.getPath('userData')` 传入；
普通 Node.js 宿主使用 `resolveEmbeddedHome(appId)`：

| 平台 | 默认 Home 根 |
| --- | --- |
| macOS | `~/Library/Application Support/<appId>/octo-runtime` |
| Windows | `%LOCALAPPDATA%\<appId>\OctoRuntime` |
| Linux | `$XDG_STATE_HOME/<appId>/octo-runtime`，未设置时回退 `~/.local/state/<appId>/octo-runtime` |

传入的 `home` 必须是绝对路径。SDK 不接受 `~`、相对路径、未展开环境变量或系统根目录，
并拒绝与 standalone `~/.octo-runtime` 相同的路径。

## 4. 公共 API 草案

```ts
export interface EmbeddedHarnessOptions {
  appId: string
  /** app-owned Embedded Home；machine.json 在这里全局共享。 */
  home: string
  /** 默认由包内发行物解析器提供；测试和私有制品可覆盖。 */
  distribution?: EmbeddedDistribution
  /** 默认 process.platform；只允许测试覆盖。 */
  platform?: NodeJS.Platform
}

export interface AccountSubject {
  type: 'user'
  /** 服务端稳定用户 ID，不是昵称、邮箱或租户内成员 ID。 */
  id: string
}

export interface AuthorizedTenant {
  /** Agent Worker 的 Space/租户 ID。 */
  id: string
  /** 仅用于 Runtime 展示，不参与授权。 */
  name?: string
  serverUrl: string
  agentWorkUrl: string
}

export interface StartAccountOptions {
  subject: AccountSubject
  /** 宿主从当前登录态获得的完整授权集合。 */
  tenants: readonly AuthorizedTenant[]
  /**
   * 当前账号的 Human Token。SDK只在内存中按需读取，用于
   * `POST /v1/runtime_enrollments`，不会持久化或传给 daemon。
   */
  getHumanToken(): string | Promise<string>
}

export interface EmbeddedHarness {
  startAccount(options: StartAccountOptions): Promise<EmbeddedHealth>
  /** 授权集合改变时对账；普通 UI 租户切换不调用此方法。 */
  reconcileTenants(tenants: readonly AuthorizedTenant[]): Promise<EmbeddedHealth>
  /** 可重入；完成前不得 start 另一个账号。 */
  stop(reason?: 'logout' | 'account-switch' | 'quit' | 'reconfigure'): Promise<void>
  health(): EmbeddedHealth
  onHealth(listener: (health: EmbeddedHealth) => void): () => void
}
```

初始版的标准授权链路固定为：

```text
宿主应用登录并得到 Human Token + 已授权 Space 列表
  -> SDK 对每个 Space 调用 POST /v1/runtime_enrollments
       Header: Token: <Human Token>
       Header: X-Space-ID: <tenant.id>
  -> Worker 验证 Human 身份、Space 成员关系并返回一次性 octo_enroll_ grant
  -> SDK 调用 /v1/runtimes/enroll 和 /v1/runtime/register
```

因此 Octo Work 不负责 grant 或 Runtime enrollment，只提供稳定 uid、Human Token 和完整 Space 集合；
切换当前 Space 时这些输入均未变化，不触发 SDK 重启。FDE 若能从甲方登录体系换到同一 Human Token，
接入也只需要这两个高层调用；如果甲方完全不签发兼容的 Human Token，则需要服务端增加 token exchange，
这不应通过复制客户端 enrollment 代码解决。

Human Token、甲方 JWT 和密码不进入 SDK 持久化层。SDK从 token provider 读取 Human Token，申请并
消费一次性 grant，仅将最终 `octo_runtime_` credential 写入当前账号对应的受保护 profile 文件；
`stop()` 时必须释放 token provider 和所有尚未完成的授权请求。

### 4.1 与 apps/daemon 的复用边界

`apps/daemon` 不直接使用完整 Embedded SDK，也不重写 daemon。两种运行方式共享同一个公共启动内核：

```text
@mininglamp-oss/octo-runtime-daemon       # 公共 daemon/runtime 内核
  ├── apps/daemon                         # standalone 进程壳
  │     参数解析 + 系统服务 + signal/console
  └── @mininglamp-oss/octo-runtime-embedded
        账号/租户编排 + Human Token enrollment + app-owned supervisor + health
```

具体复用规则：

- `startDaemonServer()`、Agent Work 多 Runtime supervisor、adapter-host、drain/close 只保留
  在 `packages/octo-runtime-daemon` 一份，standalone 与 embedded 都调用它。
- standalone 的 `apps/daemon` 继续读取普通 Home 一级 profile，并由 LaunchAgent/systemd/Task Scheduler
  管理；它不知道 Human Token、账号切换或 `accounts/`。
- embedded runner 从当前账号根和显式 allowlist 解析 profiles，把结果作为 `agentWorks` 传给同一个
  `startDaemonServer()`；它不 fork 或复制 daemon 实现。
- CLI 与 embedded 共用 runtime enroll/register/verify 的 wire client；只有 embedded 额外负责
  `Token + X-Space-ID` 的 Human grant 和账号会话编排。
- 不让 `apps/daemon` 依赖 embedded，避免 standalone 被迫携带宿主登录语义；依赖方向始终由两个上层
  入口指向公共 daemon/runtime 内核。

## 5. Home、账号和 profile

### 5.1 安装级全局 Home 与 machine identity

宿主传入的 `home` 是唯一 Embedded Home。`machine.json` 固定在 Home 根目录，首次创建后
在应用安装生命周期内保持不变；账号登录、退出、切换以及租户增删都不得重建或迁移它：

```text
<home>/machine.json
```

因此同一应用安装中的所有账号和租户 profile 共享一个 `machine_id`。这符合 Runtime 既有合同：
`machine_id` 只是安装分组标签，不是认证主键；每个 profile 的 `runtime_id` 和 Runtime credential
才是独立身份。

```text
同一机器 + 同一 app-owned Home
  用户 A / 租户 1 -> runtime_id=A1 ┐
  用户 A / 租户 2 -> runtime_id=A2 ├─ machine_id=同一个稳定值
  用户 B / 租户 3 -> runtime_id=B3 ┘
```

`machine_id` 的生命周期只跟 Home 绑定：切换账号、退出登录、切换租户和应用升级都不改变它；
只有用户明确清除整个 app-owned Home 后，下一次初始化才生成新的 `machine_id`。Worker不得用
`machine_id` 判断当前账号、Space 权限或 Runtime 所有权。

账号隔离通过“账号目录 + 当前会话显式 allowlist + 切账号 stop barrier”实现。SDK使用：

```text
subject-key = base32(sha256(subject.type + "\0" + subject.id))[0..20]
```

账号根固定为 `<home>/accounts/<subject-key>/`。该账号的 `config.json`、日志和所有
profile 都在这个目录内；profile identity 和 credential 使用既有 JSON 文件 schema。执行状态和事件回放不落盘。PID、socket/named pipe、owner lock 和 supervisor state 位于 Home 全局瞬态目录，因为任一时刻
只允许一个账号的 daemon 运行。切换账号时这些瞬态资源必须完全回收后才能复用。

这里的“完全隔离”指 SDK 保证不同账号不会同时运行，不共享 Runtime credential、profile 数据、
进程内执行状态、网络连接或状态投影，并阻止新账号 SDK 加载旧账号 profile；全局 `machine_id` 是唯一
明确共享项。它不是同一操作系统用户内的恶意代码安全边界：运行在同一 OS 账号下的其他进程仍受
该账号文件权限支配。互不信任的本机用户必须使用不同 OS 账号。

### 5.2 账号内多租户

每个租户使用一个确定性 profile：

```text
account-root = <home>/accounts/<subject-key>
profile = <normalized-app-id>-<tenant-hash>
profile-root = <account-root>/<profile>
tenant-hash = base32(sha256(tenant.id))[0..20]
```

账号键已由父目录隔离，因此 profile 不再重复携带账号哈希。profile 不包含明文用户 ID 或任意长度的
租户 ID，始终满足 1-128 ASCII 字符限制。
profile 是客户端标签，不是授权依据；真正的 Space 和 owner 由 Worker 根据 grant/Runtime credential
绑定和校验。SDK不在 Runtime profile config 中新增 `owner_subject_*` 权威字段。

SDK启动 daemon 时生成仅本次账号会话有效的 profile allowlist。daemon/runner只加载 allowlist 中、
同时存在完整 identity/credential 的 profile；历史账号目录、其他账号 profile 和未授权租户都不会被
扫描启动。当前账号 `config.json` 的 `default_profile` 使用授权 profile 排序后的稳定首项；只有该
profile 被撤销时才更新，宿主 UI 切换当前租户不会改写它。

当前 daemon 的 `loadManagedAgentWorks(home)` 只发现 Home 一级 profile，不能直接用于此布局。Embedded
包必须提供账号感知的 resolver，例如：

```ts
loadEmbeddedAccountProfiles({
  home,
  accountKey,
  profiles: activeProfileAllowlist,
}): AgentWorkRuntimeOptions[]
```

resolver 只解析 `<home>/accounts/<accountKey>/<profile>`，并把明确结果作为 `agentWorks` 传给
`startDaemonServer()`；不得把嵌套目录支持实现成递归扫描整个 `accounts/`。CLI 与 standalone 的一级
profile 布局保持不变，Embedded SDK负责新的账号目录定位层。

### 5.3 租户切换与授权集合变化

需要区分两个动作：

- **切换当前租户**：只是宿主产品状态变化。所有授权 profile 已常驻，不调用 SDK，不重启 daemon，
  PID、socket、WSS 和进行中的 Run 均保持不变。
- **租户授权集合变化**：宿主重新获取权威租户列表并调用 `reconcileTenants()`。初始版先 enrollment
  新增 profile、停止被移除 profile，然后对 daemon 做一次 drain/restart。后续可在 daemon 支持
  profile 热重载后消除这次重启。

`reconcileTenants()` 的输入必须是完整集合而不是增量，避免漏处理被撤销租户。

## 6. 账号切换协议

禁止在旧账号停止过程中直接覆盖当前 subject 或 profile allowlist。账号切换固定执行：

```text
running(account A)
  -> stopping(account-switch)
  -> 阻止新 Run 接入并 beginDrain
  -> 等待有界 drain
  -> 关闭全部 Runtime WSS
  -> 请求 runner 协作退出（Unix signal / Windows shutdown control）
  -> 超时后按已验证的进程归属做平台级进程树回收
  -> 删除瞬态 allowlist/supervisor 文件
  -> 清空 grant、AbortController、timer、health session
  -> stopped
  -> startAccount(account B)
```

强制约束：

1. `stop()` 返回前，旧账号不能再产生网络重连、health 更新或 enrollment 请求。
2. `startAccount(B)` 与尚未完成的 `stop(A)` 并发时必须排队，不能交错执行。
3. 每次账号会话使用递增 generation；旧 generation 的异步结果即使晚到也必须丢弃。
4. stop 开始时立即 abort 所有 grant/enrollment 请求。
5. stop 完成后探测旧 PID、socket/named pipe 和 adapter-host，任一仍存活则返回明确失败，
   不允许继续启动账号 B。
6. 普通 logout 与 account-switch 都不删除磁盘 credential；再次登录同一账号应复用原 Runtime identity。
7. 清除账号磁盘数据是独立、显式、二次确认的 `purgeAccount()` 能力，不属于初始版 `stop()`。

## 7. Health 状态通道

宿主通过 `health()` 读取当前快照，通过 `onHealth()` 获取去重后的状态变化。SDK内部可以轮询 daemon，
但对宿主暴露的是事件通道，不要求宿主解析 socket JSON-RPC。

```ts
export type EmbeddedPhase =
  | 'idle'
  | 'preparing-home'
  | 'enrolling'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'error'

export interface EmbeddedHealth {
  phase: EmbeddedPhase
  generation: number
  accountKey?: string
  home?: string
  local: {
    ready: boolean
    pid?: number
    adapterHostReady: boolean
    socketReachable: boolean
  }
  cloud: {
    totalProfiles: number
    connectedProfiles: number
    allConnected: boolean
  }
  profiles: readonly ProfileHealth[]
  problem?: EmbeddedProblem
  observedAt: number
}

export interface ProfileHealth {
  tenantId: string
  profile: string
  runtimeId?: string
  state: 'pending' | 'enrolling' | 'connecting' | 'online' | 'offline' | 'unauthorized' | 'error'
  reasonCode?: string
  observedAt: number
}

export interface EmbeddedProblem {
  code: string
  scope: 'distribution' | 'home' | 'enrollment' | 'daemon' | 'profile' | 'shutdown'
  retryable: boolean
  profile?: string
  message: string
}
```

health 语义：

- `running`：本地 daemon/adapter-host ready，全部授权 profile 在线。
- `degraded`：本地可执行，但至少一个授权 profile 离线、待修复或 enrollment 失败。
- 单个租户失败不阻止已有健康租户运行；失败 profile 在 `profiles[]` 中单独呈现并有界重试。
- `allConnected` 只表示本次账号 allowlist 全部在线，不包含历史 profile。
- `onHealth()` 注册后立即收到一次当前快照；相同语义状态不重复推送，仅更新时间不会制造事件风暴。
- listener 异常不能影响 SDK；取消订阅后不得再收到事件。
- health 不包含 Runtime token、grant、Human token 或 provider credential。

Electron 宿主只需在 main 中订阅，再通过自己已有的单一 preload bridge 投影给 renderer；SDK自身
不创建任何 `window.*` 全局或 IPC channel。

## 8. 跨平台进程与 IPC

SDK统一解析 IPC 地址：

```text
macOS/Linux: <home>/sockets/octo-runtime-daemon.sock
Windows:     \\.\pipe\octo-runtime-embedded-<sha256(home)[0..16]>
```

- named pipe 只由规范化后的绝对全局 Home 派生，避免 Windows AF_UNIX 路径长度限制；账号切换时地址稳定，
  但旧 daemon 必须完全退出后新账号才能复用。
- Home、PID、socket、日志、adapter manifest 和 Node 入口均由 SDK结构化传参，不拼 shell 命令。
- 发布包使用固定 Node.js 24 runtime；开发态允许显式 distribution/Node 覆盖。
- SDK提供 parent watcher，并要求 runner 自身也观察宿主 PID；宿主崩溃后双层回收 daemon 树。
- 正常退出固定先走 socket `lifecycle.drain`，再由平台 supervisor 请求 runner 退出，超时后才做进程树
  回收；Unix 可以使用 signal，Windows 使用 shutdown control + 已验证归属的进程树回收。不调用
  standalone `daemon install`，也不创建 LaunchAgent/systemd/Task Scheduler 服务。
- SDK只管理当前全局 Home 中由本次 generation 启动或明确采纳的进程，不停止 standalone Runtime，
  不扫描系统中的其他 daemon。

### 8.1 Windows 运行时合同

Windows 不能套用 Unix 的路径、signal 和文件权限假设。初始版必须同时满足下列约束：

#### Home 与路径

- 默认 Home 使用 `%LOCALAPPDATA%\<appId>\OctoRuntime`，不写 `%PROGRAMFILES%`、安装目录、当前工作目录
  或系统临时目录；同一 Windows OS 用户下不同登录账号继续共享根 `machine.json`。
- 接受宿主传入的带空格、中文和长路径绝对路径，但拒绝相对路径、驱动器相对路径（如 `C:foo`）、
  设备路径、系统盘根目录以及 UNC/网络盘。owner lock 和原子替换不承诺在网络文件系统上可靠。
- 账号和 profile 目录只使用 SDK生成的 ASCII 哈希段，禁止保留设备名（`CON`、`NUL`、`COM1` 等）、
  尾随点/空格、冒号/ADS、反斜杠和大小写归一化碰撞进入路径。
- 所有子进程均使用结构化 `spawn(executable, argv, { shell: false })`；不得拼接命令行字符串，路径含空格
  时不依赖手工引号或 `cmd.exe` 转义。

#### IPC 与单实例锁

- daemon 控制面固定使用 named pipe：
  `\\.\pipe\octo-runtime-embedded-<sha256(normalized-home)[0..16]>`。哈希输入使用规范化绝对路径并按
  Windows 大小写不敏感规则统一，账号切换时 pipe 名不变。
- Windows 不创建、探测或删除 `.sock` 文件；named pipe 断开即释放，不以“删除旧 socket”判断是否退出。
- owner lock 使用 `run/embedded-owner.lock` 的排他创建、owner PID、随机 session nonce 和创建时间。遇到
  存量锁时先探测 named pipe 与 owner 进程；只有能证明 owner 已死才清理 stale lock，不能仅凭文件年龄
  抢锁。PID 已复用或归属不确定时 fail closed。
- daemon PID、runner PID、adapter-host PID 和 session nonce 写入 supervisor state。任何强制终止前都要
  重新核对 nonce、父子关系和当前 generation，禁止仅凭旧 PID 文件杀进程。

#### 启动与退出

- Windows 启动参数使用 `windowsHide: true`，不弹出控制台窗口；显式传递 Node `.exe` 路径，不依赖文件
  关联。最小环境需要保留 `SystemRoot`、`SystemDrive`、`COMSPEC`、`PATHEXT`、`TEMP`、`TMP`、
  `USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 和 `PATH`，环境变量键按大小写不敏感方式去重。
- 正常退出先通过 named pipe 调用 `lifecycle.drain`，再发送 SDK自有的 runner shutdown 控制；等待 daemon
  主动关闭 Runtime WSS、adapter-host 和 pipe。Windows 不把 `SIGTERM` 当作可靠的主退出机制。
- 协作退出超时后，只能对上述已验证归属的 runner 根 PID 执行进程树回收（等价于
  `taskkill /PID <pid> /T /F`）；回收后必须再次验证所有记录 PID 和 named pipe 均不可达，才允许启动
  新账号。无法证明回收完整时返回 `SHUTDOWN_INCOMPLETE`。
- 宿主被 Task Manager 或崩溃终止时，runner 通过 parent PID + session nonce watchdog 自行关闭；若要达到
  严格的“宿主退出即整树退出”，发行物阶段应增加 Windows Job Object 包装器并设置
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。初始版验收不能只验证正常 `app.quit()`。

#### 文件、凭据与发行物

- 普通 JSON 与 credential 都采用同目录临时文件、flush、rename 的写入流程；处理 Windows Defender/
  索引器短暂占用导致的 `EPERM`/`EBUSY` 时只做有界退避重试，不能无限循环，也不能留下半写目标文件。
- `0600` 在 Windows 上不构成 ACL 保证。默认 Home 必须位于当前用户的 `%LOCALAPPDATA%` 并继承其 ACL；
  自定义 Home 启动前要拒绝明显的网络/共享位置。后续如支持机器上多个 OS 用户共享安装目录，需使用
  DPAPI 或显式 DACL，而不是依赖 POSIX mode。
- Windows 发行物必须按 `win32-x64`、`win32-arm64` 分别冻结 Node 24、daemon、adapter-host、adapter
  manifest 和所有 JS 依赖，并在启动前校验架构与 manifest/hash；不能回退到用户 PATH 中版本未知的 Node。
- 打包验收必须从安装后路径运行，覆盖包含空格、中文和超过 100 字符的 `%LOCALAPPDATA%` 路径；只在源码
  checkout 中运行不算 Windows 兼容。

## 9. 包与发行物边界

新增公开包：

```text
packages/octo-runtime-embedded/
├── src/index.ts             # createEmbeddedHarness / resolveEmbeddedHome
├── src/home.ts              # 全局 Home/machine、accounts/<subject>/<profile>、原子写入、owner lock
├── src/enrollment.ts        # enroll/register/verify/repair
├── src/supervisor.ts        # spawn/probe/drain/stop/watchdog
├── src/health.ts            # health 聚合、去重和订阅
├── src/errors.ts            # 稳定 reason code
├── runner/embedded-runner.mjs
└── package.json
```

包要求：

- `private: false`，发布编译后的 `dist`，不导出仓库内 TypeScript 源路径。
- Node.js `>=24`，不依赖 Electron、React 或任一宿主应用。
- 依赖固定兼容范围的 `octo-runtime-daemon`、`adapter-host`、protocol 包。
- 高层 API 是唯一推荐入口；低层 Home/enrollment/supervisor 模块不在初始版承诺稳定。
- 包版本与冻结的 daemon/adapter 版本写入 runtime manifest；宿主构建不得隐式使用相邻仓库 HEAD。

另提供构建期命令，例如：

```bash
octo-runtime-embedded prepare \
  --target win32-x64 \
  --output resources/octo-runtime-runtime
```

它负责冻结 daemon、adapter-host、adapters、manifest 和校验过的 Node runtime。宿主的打包工具只需把
输出目录作为资源收进安装包。运行时 `createEmbeddedHarness()` 默认从该标准目录解析发行物。

## 10. 安全不变式

1. grant 只存在于单次函数调用内，使用后释放，不落盘。
2. Runtime credential 只写当前账号 profile 的 mode `0600` 文件；Windows 依赖当前用户目录 ACL。
3. credential、grant、Human token 不进入 argv、环境变量、日志、health、异常 message 或 renderer。
4. SDK不信任 profile 名、磁盘目录或宿主当前租户作为授权证明；启动集合来自本次账号的完整授权租户输入，
   enrollment 最终由 Worker 校验 subject/Space。
5. `appId`、subject ID 和 tenant ID 都经过长度、字符与路径穿越校验；账号/profile 路径段使用哈希派生。
6. 全局 Home 同时只允许一个 SDK owner 和一个活动账号；锁冲突 fail closed，不抢占活进程。
7. 切账号 stop 失败时保持 `error`，禁止自动启动新账号。
8. 宿主只能看到非敏感 health 投影；原始 daemon status  不默认暴露。
9. profile allowlist 和账号级数据目录防止 SDK 误加载，不替代 OS 账号权限；互不信任的本机用户必须
   使用不同 OS 账号。

## 11. 状态机

```text
idle
  -> preparing-home
  -> enrolling (0..N profiles)
  -> starting
  -> running | degraded

running/degraded
  -> reconcile authorized tenant set
  -> stopping
  -> starting
  -> running | degraded

任意活动状态
  -> stopping (logout/account-switch/quit)
  -> stopped

任意阶段不可恢复错误
  -> error
  -> stop/retry
```

所有公开变更方法进入同一条串行队列。`startAccount()`、`reconcileTenants()` 和 `stop()` 不允许并发修改
Home、allowlist 或进程句柄。每个网络请求和等待循环都绑定当前 generation 的 `AbortSignal`。

## 12. 验收标准

### 12.1 接入与复用

- Runtime Register Demo 删除自身 Home/onboarding/supervisor/runner 实现，改为 SDK高层 API。
- Octo Work 完成同样迁移，不再维护第二份 enrollment 和 parent-watch 源码。
- CLI 与 SDK至少共用 machine/profile 文件 schema、profile 校验和 enrollment client；目录 resolver
  分别支持 standalone 一级 profile 与 Embedded `accounts/<subject>/<profile>`，不保留第三份 wire parser。
- 一个最小 FDE fixture 只提供稳定 uid、Human Token、授权 Space 列表和 health 投影即可启动 Runtime。

### 12.2 多租户

- 同一账号输入三个租户时生成三个独立 profile/runtime，并由一个 daemon 同时连接。
- 宿主连续切换当前租户 100 次，daemon PID 不变、WSS 不重连、活动 Run 不被 drain。
- 一个 profile 离线时整体为 `degraded`，其他 profile 仍可运行。
- 租户授权撤销后调用 `reconcileTenants()`，被撤销 profile 不再连接，磁盘 credential 暂时保留但不会加载。

### 12.3 账号隔离

- A -> B 切换必须观察到 A 的 daemon、adapter-host 和所有 WSS 已关闭后才启动 B。
- A、B 共享同一个全局 Home、`machine.json` 和稳定 `machine_id`，这是安装级身份的明确合同。
- A、B 的 profile 分别位于 `accounts/<subject-key-A>/` 和 `accounts/<subject-key-B>/`，并使用不同
  Runtime identity、credential、daemon store 和账号日志；任一时刻只运行一个账号。
- socket/named pipe 地址可以稳定复用，但必须先证明 A 的旧监听和进程均已退出。
- B 的 daemon 无法发现或加载 A 的 profile；切回 A 复用 A 原有 runtime ID。
- stop 期间故意延迟 enrollment/health 响应，旧 generation 的结果不得污染 B 的状态。
- 无法回收 A 进程时返回 `SHUTDOWN_INCOMPLETE`，B 不启动。

### 12.4 跨平台与异常回收

- macOS、Windows x64/arm64 完成空 Home 首启、重启复用、账号切换、宿主强杀、二次启动验证。
- Windows 全程使用 named pipe，不创建 `.sock`；安装路径和 `%LOCALAPPDATA%` 分别覆盖空格、中文、
  长用户名及超过 100 字符的路径，启动过程不弹出控制台窗口。
- Windows x64/arm64 安装包只能启动随包冻结且架构匹配的 Node 24，不得静默回退 PATH Node；错误架构
  或校验失败必须在 spawn 前返回稳定错误码。
- Windows 正常退出先验证协作 drain；模拟 daemon 卡死时验证只回收当前 session nonce 对应的整棵进程树，
  stale/reused PID 不得被误杀。
- 强杀宿主后 8 秒内 runner、daemon、adapter-host 退出；下次启动能安全处理 stale lock/PID，且无
  stale socket/named pipe 阻塞。
- Windows Defender 风格的短暂 `EPERM`/`EBUSY`、Task Manager 强杀、锁文件遗留、named pipe 已占用、
  PATH 缺失和环境变量键大小写混用均有自动化或安装机验证。
- standalone `~/.octo-runtime` 同时运行时互不停止、互不复用 identity。

### 12.5 凭据与可观测性

- 自动化扫描 argv、environment、日志、health 和异常，确认不存在 grant/Runtime/Human token。
- health 订阅覆盖启动、部分失败、恢复、停止；无重复事件风暴，取消订阅有效。
- 每个错误都有稳定 `code`、`scope`、`retryable`，宿主不依赖中文异常文本判断流程。

## 13. 分阶段实施

### M1：公共合同与纯逻辑

- 建立公开包、API 类型、错误码和 health 模型。
- 抽取 Home/profile/enrollment/credential repair，并让 CLI 复用。
- 完成全局 Home/machine、`accounts/<subject>/<profile>` resolver、路径安全和 Windows named pipe 单测。

### M2：生命周期与发行物

- 抽取 runner、parent watcher、探活、drain、强制回收。
- 实现标准 runtime manifest 和 `prepare` 构建命令。
- 实现 Windows shutdown control、归属校验进程树回收和 Job Object 包装器。
- 完成 macOS/Windows 进程树、Task Manager 强杀与崩溃恢复测试。

### M3：多租户与账号隔离

- runner按显式 allowlist 启动当前账号的全部授权 profile。
- 实现 health 聚合、部分失败和 `reconcileTenants()`。
- 验证切租户 PID/WSS 不变、切账号 stop barrier 和 generation 隔离。

### M4：迁移消费者

- 先迁移 Runtime Register Demo，作为 SDK参考实现和 FDE fixture。
- 再迁移 Octo Work，保留产品级 auth、IPC、UI 与 local-required 绑定策略。
- 删除两个消费者中复制的 Home/onboarding/supervisor/runner/build 代码。

## 14. 待确认项

初始实现前只剩两个产品决策需要冻结：

1. `stop()` 的默认 drain 上限。建议正常账号切换 30 秒，App 退出 5 秒后进入强制回收。
2. 授权租户集合变化时，初始版是否允许立即重启 daemon。本文建议允许；“切租户不影响”特指
   当前租户 UI 切换，不包括用户新增/退出组织这类授权集合变化。
