# Octo Runtime installers

现行设计见 [Runtime 本地存在与按需在线合同](../docs/runtime-local-and-online-contract.md)。当前安装器是标品的显式云端接入流程，enrollment 和 wait-online 不构成客户本地 SDK 的启动条件。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

这里存放面向最终用户的一键安装入口：

| 源文件 | 发布路径 | 平台 |
|---|---|---|
| `posix/install.sh` | `/octo-runtime/install.sh` | macOS/Linux arm64/x64 |
| `windows/install.ps1` | `/octo-runtime/install.ps1` | Windows x64/arm64 |

两个脚本都是轻量 stage-0。默认发行方式不是把程序复制进 Runtime Home，也不维护 `versions/` 和 `current` 指针，而是使用机器上 Node.js 24+ 配套的 npm 全局安装：

```text
@mininglamp-oss/octo-runtime@latest  # stable
@mininglamp-oss/octo-runtime@beta    # beta
```

安装器完成 Node/npm 检查、`npm install --global`、CLI shim 与 PATH 检查，然后把一次性 enrollment token 通过 stdin 交给 TypeScript `octo-runtime login`。Runtime enrollment、凭证落盘、原生 service、启动和 readiness 状态机都留在 CLI 中。

## 程序与状态目录

| 对象 | macOS / Linux | Windows |
|---|---|---|
| npm package | `<npm prefix -g>/lib/node_modules/@mininglamp-oss/octo-runtime` | `<npm prefix -g>/node_modules/@mininglamp-oss/octo-runtime` |
| CLI shim | `<npm prefix -g>/bin/octo-runtime` | `<npm prefix -g>\octo-runtime.cmd` |
| Runtime Home | `~/.octo-runtime/` | `%LOCALAPPDATA%\OctoRuntime\` |

Runtime Home 保存一个 daemon 的 PID/socket/共享日志，以及多个 profile 各自的 `runtime_id`、设备凭证和 SQLite/outbox。它不是程序安装目录；npm 更新或卸载 package 不得顺带删除身份和状态。未来的显式 `octo-runtime uninstall --purge --yes` 才允许清理 Runtime Home；当前 CLI 尚未提供 purge 命令。

安装器使用 `npm prefix --global` 定位实际 shim。如果 shim 目录不在 PATH：

- macOS/Linux 会加入当前进程，并幂等写入当前 shell 的 `.zprofile`、`.bash_profile` 或 `.profile`；
- Windows 会加入当前进程，并写入当前用户级 PATH；
- 安装完成后，当前命令以及新开的终端都应能直接运行 `octo-runtime`。

原生 supervisor 不保证读取交互 shell 的 PATH。`login` 生成 LaunchAgent、systemd user unit 或 Windows Task Scheduler 定义时，记录 `process.execPath` 与 daemon JS entrypoint 的绝对路径，不能只写 `node`、`octo-runtime-daemon`，也不依赖 nvm 初始化。`doctor` 检查这些绝对路径是否仍存在；用户切换 Node/npm prefix 后重跑安装器/login 重写 service definition。

## npm 发布合同

根 package 必须满足：

- package 名为 `@mininglamp-oss/octo-runtime`，`engines.node` 为 `>=24`；
- 提供 `octo-runtime` 与内部 `octo-runtime-daemon` bin；
- 发布 tarball 包含已构建的 CLI、daemon、adapter host、生产资源和同版本 manual；
- workspace 依赖在发布时必须转换为可从目标 registry 安装的真实版本，不能残留 `workspace:*`；
- stable 发布更新 npm `latest` tag，预发布更新 `beta` tag；
- 安装后 `octo-runtime login --help` 可离线读取，并列出 `--enroll-token-stdin` 与 installer 专用的 `--prepare-update`、`--recover-update`；失败必须返回非零。

安装器沿用用户现有的 npm registry、代理和认证配置。企业镜像或测试可通过 `OCTO_RUNTIME_NPM_SPEC` 覆盖完整 package spec，例如 tarball 路径、内部 registry package 或固定版本；URL spec 不允许包含 userinfo、query 或 fragment，脚本也不会把自定义 spec 原样打印到日志。`OCTO_RUNTIME_CHANNEL` 只接受 `stable`、`beta`。

## Node.js 与提权边界

运行时统一要求 Node.js 24 及以上，不支持 Deno/Bun，也不为旧 Node 保留兼容分支。

- macOS 已有 Node.js 24+ 时直接复用；版本不足时，仅在已有 Homebrew 的前提下安装 `node@24`，不会替用户安装 Homebrew 或静默使用 `sudo`。
- Linux 已有 Node.js 24+ 时直接复用；版本不足时可复用已有 Linuxbrew。否则明确提示用户通过可信发行版或版本管理器安装，不自动 `sudo`，也不注入第三方 apt/rpm 仓库。
- Windows 版本不足时使用已有的 `winget` 安装当前 Node.js LTS；没有 `winget` 时明确失败并要求先安装 Node.js 24+。
- `npm install -g` 是否需要管理员权限由用户自己的 npm prefix 决定。推荐使用当前 OS 用户可写的 Node/npm 安装；脚本不会自行提权，也不会把 daemon 注册成 root、LocalSystem 或 Windows SCM 服务。

## 幂等与并发

stage-0 在改动全局 package 前，同时持有 Runtime Home installer lock 和 npm global prefix lock，避免同一用户并发执行安装。它先找 npm shim，shim 丢失时继续找当前 package 内的 CLI entrypoint；找到兼容 CLI 后调用 `login --prepare-update --wait-drained`，由旧版本对账当前 Home、drain 活跃 Run 并停止 service。这一步失败时不得执行 npm install。

如果 Home 已有 config/profile/DB/PID/socket 等 Runtime 标记，但当前 npm prefix 找不到可用 CLI，脚本必须 fail-closed，不能把“shim 丢失或 prefix 已迁移”误判为首次安装。早于 `--prepare-update` / `--recover-update` 合同的开发版或 `npm link` 不支持自动迁移：先人工停止其前台 daemon、移除旧 link，再重跑 installer。首个正式一键安装版本必须已经在 `login` 中实现这两个更新模式，此后版本才能自动更新。

package 更新完成后，新 CLI 再运行完整 `login`。CLI 以 Runtime Home 为粒度持有状态事务锁，并保证已有 `runtime_id` 不重新 enrollment、凭证和 durable outbox 不被覆盖、service spec 被幂等对账。已有 identity 的 profile 重跑 installer 时可以省略 token；首次安装或 enrollment 尚未完成时仍必须提供 token。同一 Home 可直接新增 profile，仍只安装一个 local daemon；不同人员或互不信任的身份必须使用独立 OS account，各 OS 用户也应使用自己可写的 npm prefix。

npm 的全局更新不是项目自维护的原子 A/B 版本切换。npm install 在 prepare-update 后失败时，stage-0 会尝试调用仍可用的 CLI 执行 `login --recover-update --start` 恢复 service；若 npm 已破坏 CLI，则明确提示先修复 package 再执行 recovery。新 package 安装成功但 login/readiness 失败时也会尝试恢复 service，但当前不会自动安装上一 npm 版本；固定版本回滚仍需按发布 runbook 人工执行。不能宣称存在尚未实现的 `versions/current` 或自动 package rollback。

## 安全边界

位置参数中的 token 会短暂出现在 shell/PowerShell 历史和安装脚本 argv。Web 生成复制命令时，只能使用短 TTL、`max_uses=1` 的 enrollment grant；更安全的方式是只传 server URL，让安装器从 TTY/SecureString 隐藏读取。token 不得进入 npm argv、CLI argv、环境变量、service definition 或日志。

`curl | sh` / `irm` 的 stage-0 仍依赖 HTTPS 下载入口；npm package 则依赖所配置 registry 的完整性校验和发布权限。公开生产前还应提供不可变版本安装器 URL、发布 provenance/SBOM、package owner 与 tag 变更审计，以及固定版本的应急回滚命令。

## 当前实现状态

安装脚本、全局 npm 布局、`login` credential store、用户级 service orchestration、drain/recovery 与 readiness 已落盘并由本地 Agent Worker/WSS 集成测试覆盖。尚未完成的是正式 npm 发布和目标环境的 installer/Agent Worker ingress 部署；在此之前公网一行命令仍会明确失败，不会把“package 已下载”冒充成“Runtime 已上线”。
