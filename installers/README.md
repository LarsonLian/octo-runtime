# Octo Harness installers

这里存放面向最终用户的一键安装入口：

| 源文件 | 发布路径 | 平台 |
|---|---|---|
| `macos/install.sh` | `/octo-harness/install.sh` | macOS arm64/x64 |
| `windows/install.ps1` | `/octo-harness/install.ps1` | Windows x64/arm64 |

两个脚本都是轻量 stage-0。默认发行方式不是把程序复制进 Harness Home，也不维护 `versions/` 和 `current` 指针，而是使用机器上 Node.js 24+ 配套的 npm 全局安装：

```text
@mininglamp-oss/octo-harness@latest  # stable
@mininglamp-oss/octo-harness@beta    # beta
```

安装器完成 Node/npm 检查、`npm install --global`、CLI shim 与 PATH 检查，然后把一次性 enrollment token 通过 stdin 交给 TypeScript `octo-harness setup`。Runtime enrollment、凭证落盘、原生 service、启动和 readiness 状态机都必须留在 CLI 中。

## 程序与状态目录

| 对象 | macOS | Windows |
|---|---|---|
| npm package | `<npm prefix -g>/lib/node_modules/@mininglamp-oss/octo-harness` | `<npm prefix -g>/node_modules/@mininglamp-oss/octo-harness` |
| CLI shim | `<npm prefix -g>/bin/octo-harness` | `<npm prefix -g>\octo-harness.cmd` |
| Harness Home | `~/.octo-harness/` | `%LOCALAPPDATA%\OctoHarness\` |

Harness Home 只保存 profile、`runtime_id`、设备凭证、SQLite/outbox、PID/socket 和日志。它不是程序安装目录；npm 更新或卸载 package 不得顺带删除身份和状态。只有显式 `octo-harness uninstall --purge --yes` 才允许清理 Harness Home。

安装器使用 `npm prefix --global` 定位实际 shim。如果 shim 目录不在 PATH：

- macOS 会加入当前进程，并幂等写入当前 shell 的 `.zprofile`、`.bash_profile` 或 `.profile`；
- Windows 会加入当前进程，并写入当前用户级 PATH；
- 安装完成后，当前命令以及新开的终端都应能直接运行 `octo-harness`。

原生 supervisor 不保证读取交互 shell 的 PATH。`setup` 生成 LaunchAgent、systemd user unit 或 Windows Task Scheduler 定义时，必须记录 `process.execPath` 与 daemon JS entrypoint 的绝对路径，不能只写 `node`、`octo-harness-daemon`，也不能依赖 nvm 初始化。`doctor` 应检查这些绝对路径是否仍存在；用户切换 Node/npm prefix 后，重跑安装器或 `setup --repair` 负责重写 service definition。

## npm 发布合同

根 package 必须满足：

- package 名为 `@mininglamp-oss/octo-harness`，`engines.node` 为 `>=24`；
- 提供 `octo-harness` 与内部 `octo-harness-daemon` bin；
- 发布 tarball 包含已构建的 CLI、daemon、adapter host、生产资源和同版本 manual；
- workspace 依赖在发布时必须转换为可从目标 registry 安装的真实版本，不能残留 `workspace:*`；
- stable 发布更新 npm `latest` tag，预发布更新 `beta` tag；
- 安装后 `octo-harness setup --help` 可离线读取，并明确列出 `--enroll-token-stdin`、`--prepare-update`、`--recover-update`；`setup` 失败必须返回非零。

安装器沿用用户现有的 npm registry、代理和认证配置。企业镜像或测试可通过 `OCTO_HARNESS_NPM_SPEC` 覆盖完整 package spec，例如 tarball 路径、内部 registry package 或固定版本；URL spec 不允许包含 userinfo、query 或 fragment，脚本也不会把自定义 spec 原样打印到日志。`OCTO_HARNESS_CHANNEL` 只接受 `stable`、`beta`。

## Node.js 与提权边界

运行时统一要求 Node.js 24 及以上，不支持 Deno/Bun，也不为旧 Node 保留兼容分支。

- macOS 已有 Node.js 24+ 时直接复用；版本不足时，仅在已有 Homebrew 的前提下安装 `node@24`，不会替用户安装 Homebrew 或静默使用 `sudo`。
- Windows 版本不足时使用已有的 `winget` 安装当前 Node.js LTS；没有 `winget` 时明确失败并要求先安装 Node.js 24+。
- `npm install -g` 是否需要管理员权限由用户自己的 npm prefix 决定。推荐使用当前 OS 用户可写的 Node/npm 安装；脚本不会自行提权，也不会把 daemon 注册成 root、LocalSystem 或 Windows SCM 服务。

## 幂等与并发

stage-0 在改动全局 package 前，同时持有 Harness Home installer lock 和 npm global prefix lock，避免同一用户并发执行安装。它先找 npm shim，shim 丢失时继续找当前 package 内的 CLI entrypoint；找到兼容 CLI 后调用 `setup --prepare-update --wait-drained`，由旧版本对账当前 Home、drain 活跃 Run 并停止 service。这一步失败时不得执行 npm install。

如果 Home 已有 config/profile/DB/PID/socket 等 Runtime 标记，但当前 npm prefix 找不到可用 CLI，脚本必须 fail-closed，不能把“shim 丢失或 prefix 已迁移”误判为首次安装。早于 `--prepare-update` / `--recover-update` 合同的开发版或 `npm link` 不支持自动迁移：先人工停止其前台 daemon、移除旧 link，再重跑 installer。首个正式一键安装版本必须已经实现这两个 setup 模式，此后版本才能自动更新。

package 更新完成后，新 CLI 再运行完整 `setup`。setup 自己还要以 Harness Home 为粒度持有状态事务锁，并通过 journal 保证：已有 `runtime_id` 不重新 enrollment、凭证和 durable outbox 不被覆盖、service spec 只在内容变化时更新。不同 OS 用户应使用各自可写的 npm prefix；同一 OS 用户不支持用多个 Harness Home 运行多套不可信 daemon。

npm 的全局更新不是项目自维护的原子 A/B 版本切换。npm install 在 prepare-update 后失败时，stage-0 会尝试调用仍可用的 CLI 执行 `setup --recover-update --start` 恢复旧 service；若 npm 已破坏旧 CLI，则明确提示先修复 package 再执行 recovery。新 package 安装成功但自检/readiness 失败时，通过安装已知的上一版本显式回滚。不能继续宣称存在尚未实现的 `versions/current` 自动回滚能力。

## 安全边界

位置参数中的 token 会短暂出现在 shell/PowerShell 历史和安装脚本 argv。Web 生成复制命令时，只能使用短 TTL、`max_uses=1` 的 enrollment grant；更安全的方式是只传 server URL，让安装器从 TTY/SecureString 隐藏读取。token 不得进入 npm argv、CLI argv、环境变量、service definition 或日志。

`curl | sh` / `irm` 的 stage-0 仍依赖 HTTPS 下载入口；npm package 则依赖所配置 registry 的完整性校验和发布权限。公开生产前还应提供不可变版本安装器 URL、发布 provenance/SBOM、package owner 与 tag 变更审计，以及固定版本的应急回滚命令。

## 当前实现状态

安装脚本和 npm 全局布局已经落盘，但当前 `apps/cli` 尚未实现真正的 `setup`、credential store 和 service orchestration，package 也尚未完成正式发布。因此现在的脚本会在 setup 执行失败时明确返回非零，不会把“npm package 已下载”冒充成“Runtime 已上线”。
