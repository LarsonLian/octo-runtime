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

1. 生成并持久化稳定 `system_id`，调用 Agent Worker `/api/v1/devices/enroll` 换取设备 credential。
2. 使用设备 credential 调用 `/api/v1/runtime/register`，把返回的云端 `runtime_id` 原值写入本地 identity。

enrollment grant 和设备 credential 都不会进入 CLI argv、service definition 或输出。重复执行同一 profile 的 `login` 只对账身份，不重新 enrollment。服务安装与启动必须显式使用 `daemon install` 和 `daemon start`。常用开关：

```text
--agent-work-url URL    Worker 与 server origin 不同时显式指定
--runtime-name NAME     首次注册显示名
--channel stable|beta   记录安装 channel，默认 stable
```

`setup` 的普通模式暂时兼容 `login`。安装器还专用以下模式，不建议人工日常调用：

```bash
octo-harness setup --prepare-update --wait-drained
octo-harness setup --recover-update --start
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
octo-harness inspect url
octo-harness daemon run --inspect-host 127.0.0.1 --inspect-port 23456
octo-harness daemon install --inspect-host 127.0.0.1 --inspect-port 23456
octo-harness agent-session list
octo-harness agent-session get <agent-session-id>
octo-harness agent-run list
octo-harness agent-run get <agent-run-id>
octo-harness agent-run wait <agent-run-id>
octo-harness agent-run cancel <agent-run-id>
```

这些命令通过 Home 级 Unix socket 或 Windows named pipe 读取本地状态。`events` 默认输出约 6 MiB 有界内存中的当前快照并退出，只有 `--follow` 持续跟随；它不是完整 trajectory。`inspect` 由 daemon 懒启动，默认绑定 `127.0.0.1` 和 `20001–65535` 随机端口。Inspector 默认展示本机全量数据，页面内可按 profile 过滤 Runs、Events 与 Logs，并在浏览器 `localStorage` 中记住所选 profile。页面事件 DOM 上限为 2 MiB/1000 行，AgentRuns 上限为最近 100 个。生产创建、reset、权威状态、完整 trajectory 与 Human/Bot 授权仍由 Agent Worker / Octo Server API 或 `octo-cli harness` 负责。

`daemon run` 直接接收 `--inspect-host` / `--inspect-port`；原生服务在 `daemon install` 时把这两个可选参数固化到 systemd、launchd 或 Windows 服务定义和 Harness Home。非回环绑定需要部署方提供 TLS 和网络访问控制；代理日志不得记录 capability 的 `?token=...` query。

## 状态目录

```text
<home>/config.json
<home>/octo-daemon.pid
<home>/sockets/octo-harness-daemon.sock       # POSIX
<home>/<profile>/config.json
<home>/<profile>/identity/runtime.json
<home>/<profile>/credentials/runtime-token.json
<home>/<profile>/agent-work.db
<home>/<profile>/channel-context.db
<home>/logs/
```

一个 Harness Home 只允许一个 daemon 和一个 adapter-host。profile 目录无需在 Home 配置中注册或启用；每个合法 profile 都拥有独立 `system_id`、`runtime_id`、credential 和 Runtime WSS，共享机器级 provider 并发额度。

`octo-daemon.pid` 只保存十进制进程 PID；永久身份保存在 profile 级 `identity/runtime.json`。POSIX credential 文件以 `0600` 写入。npm package 的程序文件不放在 Harness Home。旧版 Home 根目录 identity/token/DB 会在停机后的下一次 `login/setup` 中迁入 `default/`，被覆盖的旧副本保存在 `run/profile-layout-v1-backup/`。

除帮助文本外，普通命令的正常结果输出 JSON；面向终端的 `events` 默认输出带来源标记的行（`--json` 输出原始 envelope），`inspect`/`inspect url` 输出可直接打开的 URL。错误输出到 stderr 并返回非零。`--help`、`login --help` 和 `daemon --help` 不依赖网络或已运行 daemon。
