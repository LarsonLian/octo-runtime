---
type: Guide
title: Extra 配置与调用
description: 当前 CLI 路径、SDK 声明及 HTTP/SSE 演示。
tags: ["extra"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# Extra 配置与调用

本文描述宿主编排卸载、修改配置和重新加载的入口。状态能力必备且默认 `{}`，没有原地更新与通用业务 RPC。详见 [Extra 规则](../rules/extras.md)和[责任边界决策](../tasks/extra-responsibility-boundary/brief.md)。

CLI 是个人设备的 headless 运维入口。普通用户由 Desktop App 静默准备配置并启动 Runtime，无需使用 CLI，也无需让 App 调用 CLI。

```sh
octo-runtime extraset sse-demo <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-sse-demo",
  "enabled": true,
  "config": {
    "host": "127.0.0.1",
    "port": 3002,
    "token": "replace-with-your-local-demo-token"
  }
}
JSON
```

也可以使用 zsh/bash 的 here-string：

```sh
octo-runtime extraset sse-demo <<< '{"module":"@mininglamp-oss/octo-runtime-extra-sse-demo","config":{"port":3002,"token":"replace-with-your-local-demo-token"}}'
```

命令接收完整对象，原子替换保存到：

```text
~/.octo-runtime/extras/sse-demo/config.json
```

不用手工创建额外配置文件，也不用为每个平台新增 CLI 命令。`--home` 可选择另一 Runtime Home。配置入口固定使用该 Home 的 `extras`，不接受 `--profile`。CLI 输出文件位置和 `reload_required`，不回显配置。

同一 Home 下只有上述一个配置源；profile 不分区 Extra，CLI 不探测其他位置，不合并或回退。原因与计划见 [CLI 设备级目录决策](../tasks/device-extra-directory/brief.md)。

外层声明只有 `module`、可选 `enabled` 和 `config`。`module` 指向宿主已安装的包、绝对入口路径或 file URL；不下载包，不加载网络 URL。`enabled` 缺省为 true；false 时不 import 插件。`config` 必须是 JSON 对象，内部字段由插件解释。设置操作替换完整声明，不做字段合并。

Octo 与 WeCom 的多个 Bot 放在同一插件的 `config.bots` 数组中；添加或删除时必须提交希望保留的完整列表。外层 `enabled` 控制整个插件，Bot 内的 `enabled` 只控制单个连接。Octo 的可选 `bot_name` 由插件默认成 `bot_id`，不是框架通用字段。完整数组示例见 [Octo README](../../packages/octo-runtime-extra-channel-gateway/README.md) 与 [WeCom README](../../packages/octo-runtime-extra-channel-wecom/README.md)。

单个 Bot 仍使用长度为 1 的数组，不提供单对象格式。每次提交覆盖整个插件声明：`[botA, botB]` 被 `[botB]` 覆盖后只保留 botB，`[]` 表示没有 Bot；其他省略字段也不从旧声明补齐。

配置文件权限为 0600；读取适配器拒绝权限不符合要求的文件。stdin 和配置文件限制为 1 MiB。名称检查避免目录穿越；新包和 Runtime 的安装决策仍由 HostApp 作出。

写入不改变当前实例。初次启动 daemon 后加载，或重启读取启用声明：

```sh
octo-runtime daemon restart
octo-runtime status
```

没有安装后台服务时，可使用现有前台入口：

```sh
octo-runtime daemon run
```

每次 CLI daemon 启动会重新读取上述目录，自动加载启用声明。配置读取或插件初始化失败会在该插件状态中报告，本地 Host 保持可用。已经运行的 daemon 不自动发现刚写入的声明。

前台 `daemon run` 默认向 stderr 输出扫描目录、声明数量与名称、逐插件 loading 和启动结果；`--quiet` 关闭这些日志。日志不输出配置和凭据。缺少模块报告 `EXTRA_MODULE_NOT_FOUND`，配置权限错误报告 `EXTRA_CONFIG_PERMISSIONS_INVALID`。

CLI 通过 `status` 查看 daemon 状态；SDK 的 `extraStatus()` 查询插件生命周期，`extraStatus(name)` 查询内部状态。`loaded` 仅表示初始化返回，不代表外部连接在线。例如宿主中：

```ts
await runtime.extraStatus("channel-gateway");
```

Octo 返回 `{ bots: [...] }`，每个 Bot 含 `enabled`、`state`、`connected` 和脱敏 `error`；停用项仍可见。SSE 返回 `{ listening, host, port, activeRequests }`；这些字段由各插件定义，CLI 不统一解释。`IM_BOT_TOKEN_INVALID` 表示凭据格式错误（例如仍是 `<BF_TOKEN>` 占位符），`IM_AUTH_HTTP_401` 表示服务拒绝鉴权。`api_url` 必须是纯 URL，不能填写 Markdown 链接。

```sh
# 在此通过 extraset sse-demo 保存最新完整声明
octo-runtime daemon restart
```

重启读取最新持久化声明。持久停用通过 `extraset` 保存 `enabled: false` 后重启；这会重启整个 daemon。需要单插件生命周期控制的宿主使用 SDK。

## SDK 与 Desktop App

宿主直接传入 JSON 声明，不需要本地配置文件：

```ts
const runtime = createDaemonRuntime({
  appId: "my-app",
  home: "/absolute/app-owned/runtime-home",
  development: true,
  extras: [{
    name: "sse-demo",
    module: "/absolute/installed-extra/dist/index.js",
    config: { host: "127.0.0.1", port: 3002, token: "local-demo-token" }
  }]
});
```

宿主按既有 SDK 合同启动账号。声明随受保护的 runner session 传入子进程；同账号重启恢复最新成功声明，Desktop App 下一次启动仍须从自己的存储构造配置。本次没有将 demo 默认启用到 Work App。

启动账号后调用 `runtime.loadExtra(descriptor)` 加载完整声明；更新由宿主先等待 `runtime.unloadExtra(name)`，修改并保存自己的配置，再加载最新声明。`extraStatus()` 查询生命周期，`extraStatus(name)` 查询插件同步回调返回的自定义 JSON 对象，默认 `{}`。没有通用业务请求接口，也不自动重载。SDK 不写 CLI 文件；加载失败不回滚宿主已保存配置。

IM 插件加载完整 bots，重载会重新建立该插件内连接；宿主传入 authorized_space_ids 约束 Octo 认证得到的租户。Work App 已使用统一 Extra，SQLite 只属于宿主，逐 Bot 界面操作转换为所属 Extra 的整体重载。完整的 Node 与桌面发行接入见 [接入指南](../../INTEGRATION.md#26-通过-sdk-装配可选-extra)。

已有 Node 宿主还可使用 `startDaemonServer({ extras })`，通过 `extraRegistration(descriptor)` 构造动态声明，或直接注入 `ExtraRegistration.load` 工厂。各方式都复用同一个 Host。

## HTTP -> Host -> SSE 演示

[演示包说明](../../packages/octo-runtime-extra-sse-demo/README.md) 给出完整请求。此插件只做本地调用代理，不接 Octo 注册、IM server 或 Worker。

```text
POST http://127.0.0.1:3002（不按 URL 路径路由）
  -> Authorization: Bearer <config.token>
  -> 解析 InvokeInput JSON（与 CLI / SDK 相同）
  -> 校验统一协议，创建本地 AbortSignal
  -> ctx.adapterHost.invoke(input, {signal})
  -> 每个原始输出编码为 SSE data
```

native 是默认模式，返回 HostFrame；显式 canonical 返回 CanonicalEvent。插件不将原生输出改写成业务消息。断开请求或卸载插件会取消其在途调用；卸载关闭监听和已有 HTTP 连接，等待请求处理退出。

此接口只演示 invoke，没有提供审批响应、会话管理、远程授权或历史恢复接口。SSE 只是该插件的传输选择，不成为 IPC Host 的统一传输要求。HTTP 200 表示流已打开，执行结果必须观察真实事件；Host 流异常另发 `event: error`，不伪造成功终态。


当前行为依据 [extraset](../../apps/cli/src/extras.ts)、[daemon 装配](../../apps/daemon/src/index.ts) 及 [加载合同](../rules/extras.md)。示例中的 token 仅为占位；真实凭据使用受保护配置，不进入历史记录。
