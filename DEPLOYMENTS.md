# Octo Runtime 部署

日期：2026-10-15。部署选择由 HostApp 决定。本地 Runtime 存在与云端登记独立，统一原则见 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)。

## 1. 客户 App 的最小部署

Eva2.0 等客户仅需要本地执行时，依赖 `@mininglamp-oss/octo-runtime-daemon` 及其本地生产依赖。无需携带 worker-access、channel-gateway、标品 Work App 代码或独立 embedded 包；不通过 apps/cli 承载 SDK。

源码构建与独立部署示例：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @mininglamp-oss/octo-runtime-daemon deploy --prod /absolute/staging/daemon
node scripts/verify-daemon-deployment.mjs /absolute/staging/daemon
```

验证脚本检查可选包缺席、本地实际执行和缺失模块失败隔离；它不是云端或所有 Provider 的端到端验收。

HostApp 提供固定版本的 Node 24+、SDK runner、adapter manifest、adapter-host 入口和所需 Provider。具体 `distribution` 参数见 [接入指南](INTEGRATION.md#2-作为-sdk-接入独立-app)。Runtime 与 Provider 缺失时返回状态，由 HostApp 决定安装；执行层不自动下载。

程序文件与 app-owned Home 分离。Home 保存本地身份、profile、IPC 运行状态和日志；仅云端模块启用后才需要注册凭据。同一产品账号／租户的稳定身份应保留，不因未注册或离线更换。

## 2. 可选接入的发行物

| 场景 | 额外部署 | 启动 |
| --- | --- | --- |
| Octo IM | extra-channel-gateway 及其生产依赖 | 显式提供 `channel-gateway` Extra 声明 |
| 企业微信 | extra-channel-wecom 及其生产依赖 | 显式提供 `channel-wecom` Extra 声明 |
| 仅本地 | 无接入包 | 仅启动本地账号 Runtime |

Extra 通过注入的共享 Host 执行，不复制本地执行器。安装包不代表已经启用；HostApp 显式提供初始 extras 声明或调用 configureExtra。Bot 配置与凭据由插件处理，停用插件不停止本地 Host。CLI 使用统一的 `<home>/extras/<name>/config.json`，SDK 宿主自行选择持久化来源。

Work App 的准备脚本分别部署 `sdk/`、`sdk/modules/extra-channel-gateway` 和 `sdk/modules/extra-channel-wecom`。详细布局见 [Work App 内置 Runtime](../octo-work-app/docs/embedded-runtime.md)。

worker-access 只在生态目录外的独立仓库作预研备份，不部署、不链接、不加载。

## 3. 独立 CLI 的 link 与发行

根 `@mininglamp-oss/octo-runtime` 包是标品运维 CLI 装配，携带可复用的 workspace packages。它不是客户仅本地 SDK 的最小依赖树。

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

发布时先发布运行依赖 packages，再发布根 CLI；pnpm pack／publish 将 workspace 依赖转换为版本范围。版本和 registry 可用性必须由发布方验证，源码存在不等于版本已发布。

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm pack --dry-run
```

当前 CLI 初始化本地 Home 并提供原生服务管理；Worker enrollment 和一键云端安装脚本已归档。操作见 [CLI](apps/cli/README.md)和[安装说明](installers/README.md)。

## 4. 真实联调与凭据

真实接口调试使用 `https://im-test.deepminer.com.cn/`，Worker API 根地址为 `https://im-test.deepminer.com.cn/agentworker/api`。本轮服务端操作范围仅 Worker；旧 Loop／Channel／MCP Access 目录不构成部署或数据库操作依据。

Human Token 用于明确的业务授权与注册 grant 请求；enrollment grant 用于注册；Runtime credential 用于已启用的 Worker 接入；IM Bot 与 Provider 凭据分别独立。凭据不进入 Git、公开日志、命令参数、service definition、renderer 或模型 Context。

验收分别检查本地 IPC、真实执行及已启用扩展的实际连接，不能用一个 online 状态代替全部证据。当前能力边界见 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)；包拆分后的发布验收需单独执行。
