# Octo Harness CLI

`octo-harness` 是当前 OS 用户的 Runtime 登录、服务生命周期和本地诊断入口。运行时要求 Node.js 24 或更高版本。

## 全局参数

```text
--home PATH       覆盖 Harness Home
--profile NAME    选择 profile，默认 default
```

macOS/Linux 默认 Home 是 `~/.octo-harness`，Windows 是 `%LOCALAPPDATA%\OctoHarness`。一个 Home 运行一个 daemon，并可包含多个 profile；每个 profile 独立保存 Runtime 身份、credential、WSS、outbox 与 channel context。不同 OS 用户或互不信任的身份仍必须使用不同 OS account。

## 登录

首次登录从 stdin 读取一次性 `octo_enroll_` grant：

```bash
printf '%s\n' 'octo_enroll_...' | octo-harness login \
  --server-url https://im-test.deepminer.com.cn \
  --enroll-token-stdin
```

`login` 只完成 Runtime 身份闭环：

1. Persist one Home-global `machine_id` in `machine.json`, shared by every profile.
2. Exchange an enrollment grant at `/v1/runtimes/enroll` with the selected `profile` for a server-assigned `runtime_id` and directly bound `octo_runtime_` credential; refresh capabilities at `/v1/runtime/register` with that same profile and save the returned identity.

`machine_id` is an untrusted installation grouping label, not a hardware proof or a unique Runtime key. New profiles get distinct Runtime IDs even within the same Space. Renewal uses the saved Runtime ID and credential, and cannot change the trusted server or Worker endpoint.

enrollment grant 和设备 credential 都不会进入 CLI argv、service definition 或输出。重复执行同一 profile 的 `login` 只对账身份，不重新 enrollment。服务安装与启动必须显式使用 `daemon install` 和 `daemon start`。常用开关：

```text
--agent-work-url URL    覆盖 Worker API 根地址；默认使用 SERVER_URL/agentworker/api
--runtime-name NAME     首次注册显示名
--channel stable|beta   记录安装 channel，默认 stable
```

安装器还专用以下更新模式，不建议人工日常调用：

```bash
octo-harness login --prepare-update --wait-drained
octo-harness login --recover-update --start
```

## Daemon 生命周期

```bash
octo-harness daemon install
octo-harness daemon uninstall
octo-harness daemon run
octo-harness daemon start
octo-harness daemon stop
octo-harness daemon restart
octo-harness daemon status
```

- `install` 把已完成 `login` 的 Harness Home 注册为当前用户的原生服务，也可重复执行以修复 definition drift；默认启用登录自启但不启动，可用 `--no-autostart` 禁用自启。
- `uninstall` 同步停止并从原生服务管理器中真实删除服务：systemd user unit、macOS LaunchAgent 或 Windows 当前用户计划任务。默认先 drain，`--force` 跳过 drain；身份、credential、SQLite/outbox 和日志全部保留。
- `run` 在前台运行并响应 `SIGINT`/`SIGTERM`；PID 文件保证一个 Home 只有一个 daemon。
- `run` 默认在 stderr 输出彩色、脱敏的生命周期状态；`--quiet` 关闭终端输出，`--verbose`
  显示详细 operational records 和完整启动异常堆栈。RPC/provider 敏感内容仍只进入受保护日志。
- `start` 只启动已安装且已启用的原生用户服务，不创建 detached 子进程；`--wait-online` 会继续等待所选 `runtime_id` 的 WSS Online。
- `stop`、`restart` 先通过 IPC 关闭新 Run 准入并等待活动 Run 完成，再操作原生服务；`--force` 跳过 drain。
- 生命周期命令作用于整个 Home。daemon 自动发现 Home 下包含合法 `config.json` 的 profile，并由一个 supervisor 管理各自的 credential、`runtime_id`、WSS 和 outbox。
- 锁屏不会结束已登录用户的服务；注销会结束 macOS LaunchAgent 和默认 Windows 用户任务。Linux 注销后是否继续取决于管理员是否启用 linger。

## Doctor

```bash
octo-harness doctor
octo-harness --home /path/to/work-home --profile work doctor
```

`doctor` 是服务诊断入口，当前检查 Node.js 版本、profile/identity/credential 文件、POSIX credential mode、service program 绝对路径、原生 manager、definition drift、本地 IPC 和所选 Runtime 的云端连接。所有检查通过返回 0，否则返回 1，并为失败项输出 remediation。`logs` 用于看执行数据，不替代 doctor。

## 本地数据与 Run 诊断

```bash
octo-harness status
octo-harness adapter list
octo-harness adapter probe codex
octo-harness logs path
octo-harness logs query <agent-run-id>
octo-harness events --run-id <agent-run-id>
octo-harness events --follow
octo-harness inspect
octo-harness daemon run --inspect-host 127.0.0.1 --inspect-port 23456
octo-harness daemon install --inspect-host 127.0.0.1 --inspect-port 23456
octo-harness agent-session list
octo-harness agent-session get <agent-session-id>
octo-harness agent-run list
octo-harness agent-run get <agent-run-id>
octo-harness agent-run wait <agent-run-id>
octo-harness agent-run cancel <agent-run-id>
```

这些命令通过 Home 级 Unix socket 或 Windows named pipe 读取本地状态。`events` 默认输出约 6 MiB 有界内存中的当前快照并退出，只有 `--follow` 持续跟随；它不是完整 trajectory。Inspect HTTP/WS 端口随 daemon 启动并持续监听，默认绑定 `127.0.0.1` 和 `20001–65535` 随机端口；没有浏览器时不会创建 WS 订阅者。`inspect` 只输出 IP、端口与 Capability token 地址。Inspector 使用 React SPA 和虚拟列表，浏览器按最新优先保留最多 6000 条或约 6 MiB 事件；QL 和列筛选只操作现有列表与后续实时事件，不会重建 WS。暂停接收、滚离顶部或展开事件会关闭当前 WS 并固定视图；恢复时从 daemon ring 当前尾部继续，不补回暂停期间的事件。生产创建、reset、权威状态、完整 trajectory 与 Human/Bot 授权仍由 Agent Worker / Octo Server API 或 `octo-cli harness` 负责。

`daemon run` 直接接收 `--inspect-host` / `--inspect-port`；原生服务在 `daemon install` 时把这两个可选参数固化到 systemd、launchd 或 Windows 服务定义和 Harness Home。非回环绑定需要部署方提供 TLS 和网络访问控制；代理日志不得记录 capability 的 `?token=...` query。

## 状态目录

```text
<home>/config.json
<home>/machine.json                         # shared installation grouping label
<home>/octo-daemon.pid
<home>/sockets/octo-harness-daemon.sock       # POSIX
<home>/<profile>/config.json
<home>/<profile>/identity/runtime.json
<home>/<profile>/credentials/runtime-token.json
<home>/<profile>/agent-work.db
<home>/<profile>/channel-context.db
<home>/logs/
```

One Harness Home runs one daemon and adapter-host. Each discovered profile has its own server-assigned `runtime_id`, credential, and WSS connection, while sharing the Home-global `machine_id` and provider concurrency limits. Profile names allow 1-128 characters. The identity file must include the exact bound profile; identities without it are unsupported and require fresh enrollment after the Worker database reset.

`octo-daemon.pid` contains only a process PID. Profile identity is stored in `identity/runtime.json`; POSIX credentials use mode `0600`. Existing `system_id`/`device_id` identities are unsupported after this breaking reset: freshly enroll profiles against the recreated Worker database. Program files do not live inside Harness Home.

除帮助文本外，普通命令的正常结果输出 JSON；面向终端的 `events` 默认输出带来源标记的行（`--json` 输出原始 envelope），`inspect` 输出可直接打开的 URL。错误输出到 stderr 并返回非零。`--help` 和 `login --help` 不依赖网络或已运行 daemon。
