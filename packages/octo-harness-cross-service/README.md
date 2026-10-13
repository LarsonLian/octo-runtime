# @mininglamp-oss/octo-harness-cross-service

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

Octo Harness 的跨平台、当前用户级原生服务管理器。运行时固定为 Node.js 24 或更高版本，不支持 Deno/Bun。包内直接实现三个后端，不包含 `cross-service` 源码，也不依赖在线运行时：

| 平台    | 原生管理器                               | 安装位置                                       | 自启动时机        |
| ------- | ---------------------------------------- | ---------------------------------------------- | ----------------- |
| macOS   | LaunchAgent / `launchctl`                | `~/Library/LaunchAgents/<label>.plist`         | 用户登录          |
| Linux   | systemd user / `systemctl --user`        | `~/.config/systemd/user/<unit>.service`        | user manager 启动 |
| Windows | 当前用户 Task Scheduler / `schtasks.exe` | `%LOCALAPPDATA%\OctoHarness\services\<id>.xml` | 指定用户登录      |

它只管理 `install`、`uninstall`、`enable`、`disable`、`start`、`stop`、`restart`、`inspect` 和 `probe`。应用日志、daemon IPC、凭证兑换、健康检查仍由 `octo-harness daemon` / `doctor` 负责。

## 使用

```ts
import { createServiceBackend } from "@mininglamp-oss/octo-harness-cross-service";

const service = createServiceBackend();
const spec = {
  id: "cn.mininglamp.octo-harness.daemon",
  description: "Octo Harness daemon",
  // login 从 process.execPath 与当前 npm package 解析这两个绝对路径。
  command: "/opt/homebrew/opt/node@24/bin/node",
  args: [
    "/opt/homebrew/lib/node_modules/@mininglamp-oss/octo-harness/apps/daemon/dist/launcher.js",
    "--home",
    "/Users/alice/.octo-harness"
  ],
  workingDirectory: "/Users/alice/.octo-harness",
  stdoutPath: "/Users/alice/.octo-harness/logs/service.stdout.log",
  stderrPath: "/Users/alice/.octo-harness/logs/service.stderr.log",
  enabled: true,
  restart: { policy: "on-failure", delaySeconds: 5, maxBurst: 5 }
} as const;

const capability = await service.probe();
if (!capability.supported) throw new Error(capability.detail);

await service.install(spec); // 幂等写入定义并配置开机/登录自启，不隐式启动
await service.start(spec);
console.log(await service.inspect(spec));
```

Windows 必须传 Windows 绝对路径，并且 Task Scheduler 不提供与 LaunchAgent/systemd 等价的环境变量和 stdout/stderr 配置。因此 Windows spec 不得设置 `environment`、`stdoutPath` 或 `stderrPath`；daemon 应自行写应用日志。Windows 的 `on-failure` 重启间隔最小为 60 秒，`always` 策略会明确返回 `UNSUPPORTED_SPEC`。

```ts
const service = createServiceBackend();
await service.install({
  id: "cn.mininglamp.octo-harness.daemon",
  command: "C:\\Program Files\\nodejs\\node.exe",
  args: [
    "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@mininglamp-oss\\octo-harness\\apps\\daemon\\dist\\launcher.js",
    "--home",
    "C:\\Users\\alice\\AppData\\Local\\OctoHarness"
  ],
  workingDirectory: "C:\\Users\\alice\\AppData\\Local\\OctoHarness",
  enabled: true,
  restart: { policy: "on-failure", delaySeconds: 60, maxBurst: 5 }
});
```

## 行为约定

这里的成功只表示原生服务管理器达到了目标状态。包本身不负责等待 daemon IPC、Runtime Online 或 provider 可用：

| 调用              | 调用成功后的可观察效果                                       | 明确不保证                                            |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `probe()`         | 已确认当前 OS 用户能够访问对应的原生管理器                   | 不检查服务是否安装，也不写任何配置                    |
| `inspect(spec)`   | 返回原生定义、enable、进程状态、PID/退出码和配置漂移快照     | 不修复漂移，不检查 IPC 和云端状态                     |
| `install(spec)`   | 原生定义和自启动设置与 `spec` 一致；重复执行得到相同目标状态 | 首次安装不会启动进程；原本 stopped 的服务仍为 stopped |
| `enable(spec)`    | 下次用户登录或 user manager 激活时允许自动启动               | 不启动当前进程                                        |
| `disable(spec)`   | 后续不再自动启动                                             | 不停止已经运行的进程                                  |
| `start(spec)`     | 原生管理器已接受启动请求；已运行时为成功 no-op               | 不代表 daemon socket 已创建或 Runtime 已 Online       |
| `stop(spec)`      | 当前实例已停止，服务定义和 enable 状态仍保留                 | 不删除凭证、数据库、outbox 或日志                     |
| `restart(spec)`   | 已停止旧实例并启动替换进程；原本 stopped 时等价于 start      | 不等待替换进程完成 IPC/云端就绪                       |
| `uninstall(spec)` | 当前实例停止，原生注册和管理定义被删除                       | 不清理 Harness Home 内的凭证和业务数据                |

更新一个正在运行的定义时，后端会在写入新定义后替换进程，让新 command/args/策略真正生效；更新一个已经停止的定义时不会顺便启动它。`start` / `restart` 要求服务已安装且已 enable，错误分别使用 `NOT_INSTALLED` 与 `SERVICE_DISABLED`。

`inspect().state === "running"` 只表示服务管理器看到进程运行。上层 CLI 必须继续等待 daemon IPC ready，并通过 `doctor` 分别确认本地 Runtime 和云端连接状态。

CLI 是否能在终端中直接执行与 service 如何启动是两个合同：installer 负责把 npm global bin 加入用户 PATH；service 不读取该 PATH，使用 login 当次解析出的绝对 Node 与 daemon entrypoint。Node/npm prefix 被移动或删除后，`doctor` 报告路径失效，重跑 installer/login 更新定义。

- Linux 后端不会自动调用 `loginctl enable-linger`。无人登录时也要运行 user service，必须由管理员明确配置 linger，或改用 system service。
- Windows 后端使用 `InteractiveToken` 与 `LeastPrivilege`，只在指定的当前用户登录时启动，不创建 `LocalSystem` 服务。
- 锁屏不会结束用户登录会话，Windows task、macOS LaunchAgent 与 Linux user service 会继续运行；注销、关机或重启则会结束当前实例。Windows 必须等该用户再次登录，Linux 是否允许注销后继续运行取决于 linger 配置。

## 安全边界

服务定义会长期保存在磁盘，且通常能被当前用户读取，因此禁止把 enrollment token、access token、密码、cookie、私钥等放进 args 或 environment。安装流程应先把一次性 enrollment token 兑换为本地凭证，再让 daemon 通过自己的 `0600`/用户 ACL 凭证文件加载；`ServiceSpec` 只传绝对 Node 路径、daemon launcher 和非敏感的 `--home` 路径。daemon 再从 Home 加载唯一 enabled profile。

所有命令都用 `spawn(executable, argv, { shell: false })` 执行。包不会解析 shell 字符串，也不会生成 `.sh`、`.bat` 或 PowerShell wrapper。

## API

```ts
interface ServiceBackend {
  probe(): Promise<ServiceProbe>;
  inspect(spec: ServiceSpec): Promise<ServiceStatus>;
  install(spec: ServiceSpec): Promise<void>;
  uninstall(spec: ServiceSpec): Promise<void>;
  enable(spec: ServiceSpec): Promise<void>;
  disable(spec: ServiceSpec): Promise<void>;
  start(spec: ServiceSpec): Promise<void>;
  stop(spec: ServiceSpec): Promise<void>;
  restart(spec: ServiceSpec): Promise<void>;
}
```

`ServiceStatus.drift` 报告本地定义内容变化；Windows 还会比较 Task Scheduler 当前注册的 command、arguments、working directory、principal、trigger user 与 enable 状态。`pid` 仅在原生管理器能稳定提供时返回。

测试可以注入 `CommandRunner`，无需在 CI 中实际注册系统服务：

```ts
const backend = createServiceBackend({
  platform: "linux",
  runner: fakeRunner,
  homeDirectory: "/tmp/test-home"
});
```

## 模块责任边界

- 负责：管理 launchd/systemd/Windows 用户服务的生命周期。
- 不负责：AgentRun 执行、WS 连接、IM 业务。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
