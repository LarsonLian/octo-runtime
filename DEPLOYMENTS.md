# Octo Runtime 部署

日期：2026-10-15。部署选择由 HostApp 决定。本地 Runtime 存在与云端登记独立，统一原则见 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)。

Electron、Tauri 2 桌面程序严禁使用 CLI 接入，必须采用 [SDK 原生接入](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md)。云端设备的 CLI 使用见 [CLI 使用指南](CLI_USAGE_GUIDE.md)。

## 1. 客户 App 的最小部署

宿主 App 自行管理 Adapter 的生产依赖、依赖裁剪及安装包内容，并确保 SDK 选择加载的模块及必要依赖可解析。Runtime 不替客户修改依赖树，不承诺最终包体只包含所选 Adapter。CLI 和 SDK 已分别管理加载集合，详见 [接入说明](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#16-准备正式包资源)与[实施方案](.octospec/tasks/adapter-composition-ownership/brief.md)。加载选择、实际携带的模块和 Provider 安装必须分别说明。

`packages/*` 全部是内部模块，不独立发布或供用户从 npm 引用。Eva2.0 等内部项目仅需要本地执行时，由维护者从源码构建 daemon 及其本地生产依赖，再手动拷贝发行目录并覆盖目标程序文件。这里的包名仅用于内部模块解析，不是独立 npm 产品。无需携带 worker-access、channel-gateway、标品 Work App 代码或独立 embedded 包；不通过 apps/cli 承载 SDK。

源码构建与拷贝前的目录准备示例：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @mininglamp-oss/octo-runtime-daemon deploy --prod /absolute/staging/daemon
node scripts/verify-daemon-deployment.mjs /absolute/staging/daemon
```

验证脚本检查可选包缺席、本地实际执行和缺失模块失败隔离；它不是云端或所有 Provider 的端到端验收。

HostApp 提供固定版本的 Node 24.x、SDK runner、直接 import 并注册所选 Adapter 的独立 Host 入口及其依赖和所需 Provider。CLI 专属默认清单为 `apps/cli/src/default_adapters.json`，SDK 不复制或读取；宿主自行管理依赖、裁剪和包体，加载较少不保证包体缩小。具体 `distribution` 参数及带中文注释的加载示例见 [接入指南](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#1-原生启动-octo-runtime)。Runtime 与 Provider 缺失时返回状态，由 HostApp 决定安装；执行层不自动下载。

程序文件与 app-owned Home 分离。Home 保存本地身份、profile、IPC 运行状态和日志；仅云端模块启用后才需要注册凭据。同一产品账号／租户的稳定身份应保留，不因未注册或离线更换。

手动覆盖必须以同次构建的完整程序目录为单位，避免混用旧依赖；停止相关进程后覆盖程序文件，再重启。不得覆盖或删除目标 Home、身份与配置。

## 2. 可选接入的发行物

| 场景     | 额外部署                           | 启动                                  |
| -------- | ---------------------------------- | ------------------------------------- |
| Octo IM  | extra-channel-gateway 及其生产依赖 | 显式提供 `channel-gateway` Extra 声明 |
| 企业微信 | extra-channel-wecom 及其生产依赖   | 显式提供 `channel-wecom` Extra 声明   |
| 仅本地   | 无接入包                           | 仅启动本地账号 Runtime                |

Extra 通过注入的共享 Host 执行，不复制本地执行器。安装包不代表已经启用；HostApp 显式提供初始 extras 声明或调用 configureExtra。Bot 配置与凭据由插件处理，停用插件不停止本地 Host。CLI 使用统一的 `<home>/extras/<name>/config.json`，SDK 宿主自行选择持久化来源。

Work App 的准备脚本分别部署 `sdk/`、`sdk/modules/extra-channel-gateway` 和 `sdk/modules/extra-channel-wecom`。详细布局见 [Work App 内置 Runtime](../octo-work-app/docs/embedded-runtime.md)。

worker-access 只在生态目录外的独立仓库作预研备份，不部署、不链接、不加载。

## 3. 独立 CLI 的 link 与发行

根 `@mininglamp-oss/octo-runtime` 包是标品运维 CLI 装配，默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力；安装包本身不代表已启用全部组件或已注册自启。它不是客户仅本地 SDK 的最小依赖树。

源码全局 link：

```bash
npm link --foreground-scripts
command -v octo-runtime
octo-runtime --help
```

prepare 会构建 workspace，CLI 指向编译后的 dist。修改源码后构建并重启受影响进程；全局链接不能替代正在运行应用的重启。

取消 link：

```bash
npm unlink --global @mininglamp-oss/octo-runtime
```

对外只发布 `@mininglamp-oss/octo-runtime`。内部 apps 与 packages 标记为 private，不独立发布；发行脚本将生产依赖实体化并随 CLI 打入一个 tarball。源码清单统一保持 `0.0.0` 非发行占位版本，正式版本唯一取自稳定版 annotated tag，并只写入生成的发行包。安装端不需要 pnpm 或构建工具，也不访问内部包 registry；根包只公开声明的 CLI、Extra 与协议入口。源码 SDK 集成仍按第 1 节由宿主自行构建部署。

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node scripts/pack-release.mjs --version 1.0.0
node scripts/verify-release.mjs ./dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz
```

本地命令只用于验证，不用于正式上传。正式发布在最新 `main` 提交上创建并推送 `vX.Y.Z` annotated tag；GitHub Actions 校验 tag、重新构建并验证 commit 后，先交付不可变 npm 版本和对应 GitHub Release，再把两端 latest 自动收敛到已完整交付的最高稳定版。唯一 npm registry 是 `https://registry.npmjs.org`，不发布到 GitHub Packages。并发 tag 或历史版本恢复不会回退 `@latest`，RC 等预发布不推进 `latest`。不要修改源码清单版本，也不要直接 npm publish 或 pnpm publish workspace 根目录。

版本命令和根帮助中的 `build:<UTC ISO 8601>` 表示产物构建时间，不是提交、安装或上次升级时间；旧产物没有有效时间时显示 `build:unknown`。打包及安装不重写 `apps/cli/dist/build-info.json`。

正式发布会捕获一次 UTC 构建会话时间，经 `OCTO_RUNTIME_BUILD_TIME` 传给所有平台及重复构建。恢复已发布版本时，流程先下载 npm 原始 archive，验证 SHA512、来源 commit 与 clean 状态，再复用其中的时间；最终仍要求重新打包的完整 integrity 与已发布版本完全一致，否则停止，不覆盖也不跳过完整性检查。旧版本没有时间字段时保持旧构建逻辑；尚未发布成功的版本可创建新构建会话时间。手工复验应保留原 archive；需要重建时，只能使用其中的原始构建时间，不能把 commit/tag 日期或任意时间当成构建时间。

使用者安装：

```bash
npm install -g @mininglamp-oss/octo-runtime
octo-runtime --help
```

项目内 `npm install @mininglamp-oss/octo-runtime` 后，通过 `npx octo-runtime` 调用。更新使用 `npm install -g @mininglamp-oss/octo-runtime@latest`，并重启受影响的 Runtime 进程。程序更新保留原 Home、身份与配置；安装包不会自动安装 Provider。

已安装系统服务且 Node 路径、npm 全局安装路径、Runtime Home 与服务定义均未变化时，升级不需要再次 `daemon install`：

```bash
npm install -g @mininglamp-oss/octo-runtime@latest
octo-runtime daemon restart
octo-runtime daemon status
```

系统服务保存 Node 与 daemon 入口的绝对路径。切换 nvm Node 版本、npm prefix、由源码 link 改成 npm 安装，或者更改 Home／服务定义时，需要重新执行 `octo-runtime daemon install` 更新注册，再重启。自定义 Home 的命令应始终带相同的 `--home PATH`。升级应安排在没有运行中任务的时段。

独立 CLI 的安装入口统一为 npm，不提供多系统安装脚本，也不在安装时执行云端登记或建立设备在线关系。本地 Home 初始化和原生用户服务管理由 CLI 提供；登录、登记和共享由按需启用的业务 Extra 负责。操作见 [CLI](apps/cli/README.md)。

## 4. 真实联调与凭据

真实接口调试使用 `https://im-test.deepminer.com.cn/`，Worker API 根地址为 `https://im-test.deepminer.com.cn/agentworker/api`。本轮服务端操作范围仅 Worker；旧 Loop／Channel／MCP Access 目录不构成部署或数据库操作依据。

Human Token 用于明确的业务授权与注册 grant 请求；enrollment grant 用于注册；Runtime credential 用于已启用的 Worker 接入；IM Bot 与 Provider 凭据分别独立。凭据不进入 Git、公开日志、命令参数、service definition、renderer 或模型 Context。

验收分别检查本地 IPC、真实执行及已启用扩展的实际连接，不能用一个 online 状态代替全部证据。当前能力边界见 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)；包拆分后的发布验收需单独执行。
