# Extra 插件：设计原理、目标与使用场景

## 目标

Extra 是本地 Runtime 上可装配的业务入口。Runtime、IPC Host 和 Provider Adapter 在本地独立存在；加载 Extra 不要求云端注册。Extra 通过宿主注入的执行能力提交请求，自己实现触发、连接、认证、业务状态和结果投递。

本次提供统一加载器、CLI JSON 配置入口和 `octo-runtime-extra-sse-demo` 示例。现有 channel-im、worker-access 仍使用原来的模块合同；本次没有声称完成它们的拆包或最终远程链路评审。

## 插件是什么

插件包导出一个稳定名称和一个默认 lambda：

```ts
import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";

export const name = "example";

export default async function load(ctx: ExtraContext, config: JsonObject): Promise<void> {
  const service = createBusinessService(config);
  ctx.onDispose(() => service.close());
  await service.start(ctx.signal);
}
```

`createBusinessService` 是业务代码示意。插件内部可以使用类、状态机、多条 WS 和重连管理器。公共层不规定内部实现，也不提供每个平台专属的加载方法。

一个 daemon 中，同名插件只加载一次。多个机器人、账号或 WS 属于插件内部配置和管理范围，不拆成多个框架实例。卸载后允许再次加载；重复加载尚未卸载的实例返回 `EXTRA_ALREADY_LOADED`。

`name` 只能使用小写字母开头、后续小写字母/数字/连字符，最长 64 字符。配置目录名称必须与模块导出的 `name` 相同；不匹配返回 `EXTRA_NAME_MISMATCH`。例如包名 `@mininglamp-oss/octo-runtime-extra-sse-demo` 声明名称 `sse-demo`。

## Context 与配置分别承担什么

```ts
type ExtraPlugin = (ctx: ExtraContext, config: JsonObject) => void | Promise<void>;

interface ExtraContext {
  adapterHost: Pick<HostRunService, "invoke">;
  signal: AbortSignal;
  onDispose(dispose: () => void | Promise<void>): void;
}
```

`ctx` 是插件运行环境，提供共享 Host 的 `invoke`、实例停止信号及清理登记。它不是发给模型的 Context v3，不能整体序列化为模型输入。

`config` 是宿主构造的插件专属 JSON 对象。框架没有通用业务 Config，也不要求插件导出 `validateConfig()`。每个插件在 lambda 内理解必要字段，配置不足时拒绝初始化。

CLI 默认从 JSON 文件读取；Desktop App 可以从 SQLite 或其他来源读取，再构造对象。插件无需知道配置来源。SDK 不扫描配置目录，宿主明确提供声明；CLI daemon 的启动装配明确选择目录读取适配器。

业务发起方决定每轮 `Actor + Trigger + Target + Input + Context`，处理业务 defaults/mandatory。Extra 若只是原始请求代理，则不追加或重建模型 Context。执行边界继续校验协议、身份、权限与必要执行配置；空模型 Context 与不同 Event 中显式重复的 item 都保持原语义。

## Load 与 dispose

```text
宿主选择插件与 JSON 对象
  -> loader 创建独立 context / signal / 清理列表
  -> import 已安装包
  -> 核对声明名称
  -> load(ctx, config)
  -> 初始化完成，状态 loaded

卸载 / daemon 退出 / 初始化失败
  -> 通知 signal.abort()
  -> 等待初始化退出
  -> 逆序执行登记的 disposer
  -> 等待异步清理完成
```

lambda 返回或 Promise 完成表示初始化完成，不表示插件卸载。长期连接、监听器与任务仍由插件持有。

每创建一个资源，应立即登记清理动作，再继续后续初始化。清理逆序执行，同一实例每个 disposer 只执行一次。单个 disposer 失败时仍继续其他清理，最终报告 `EXTRA_DISPOSE_FAILED`。初始化中途失败会回收已登记资源，其他插件和本地 Host 可以继续运行。

插件必须让初始化和内部任务响应停止信号，自己的 disposer 等待内部任务退出。加载器不强行终止同进程 JavaScript，也不是插件沙箱。业务重连和是否重试外部副作用由插件处理；loader 不在失败时自动重新 invoke 或自动重启插件。

公开状态只报告生命周期和脱敏错误码，不公开配置、Token 或第三方异常原文。`loaded` 不证明云端已登记或 WS 正常，业务连接健康需要插件自己的证据。本次最小 context 没有新增通用业务状态 API。

## CLI 的统一配置入口

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
~/.octo-runtime/default/extra/sse-demo/config.json
```

不用手工创建额外配置文件，也不用为每个平台新增 CLI 命令。`--home` 可选择另一 Runtime Home。此次配置入口固定使用该 Home 的 `default/extra`，不接受 `--profile`。CLI 输出文件位置和 `restart_required`，不回显配置。

外层声明只有 `module`、可选 `enabled` 和 `config`。`module` 指向宿主已安装的包、绝对入口路径或 file URL；不下载包，不加载网络 URL。`enabled` 缺省为 true；false 时不 import 插件。`config` 必须是 JSON 对象，内部字段由插件解释。设置操作替换完整声明，不做字段合并。

配置文件权限为 0600；读取适配器拒绝权限不符合要求的文件。stdin 和配置文件限制为 1 MiB。名称检查避免目录穿越；新包和 Runtime 的安装决策仍由 HostApp 作出。

写入不改变当前实例，重启应用配置：

```sh
octo-runtime daemon restart
octo-runtime extra status
```

没有安装后台服务时，可使用现有前台入口：

```sh
octo-runtime daemon run
```

每次 CLI daemon 启动会重新读取上述目录，自动加载启用声明。配置读取或插件初始化失败会在该插件状态中报告，本地 Host 保持可用。已经运行的 daemon 不自动发现刚写入的声明。

```sh
octo-runtime extra unload sse-demo
octo-runtime extra load sse-demo
```

这两个操作只控制当前启动时读到的声明，不改持久化配置。重新 load 使用本次启动的配置快照；修改配置后必须重启。持久停用通过 `extraset` 写入 `enabled: false` 并重启。

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

宿主按既有 SDK 合同启动账号。声明随受保护的 runner session 传入子进程；runner 重新启动时按宿主传入的声明加载。Desktop App 必须在自己的下一次启动前重新构造所需配置。本次没有将 demo 默认启用到 Work App。

已有 Node 宿主还可使用 `startDaemonServer({ extras })`，通过 `extraRegistration(descriptor)` 构造动态声明，或直接注入 `ExtraRegistration.load` 工厂。各方式都复用同一个 Host。

## HTTP -> Host -> SSE 演示

[演示包说明](../packages/octo-runtime-extra-sse-demo/README.md) 给出完整请求。此插件只做本地调用代理，不接 Octo 注册、IM server 或 Worker。

```text
POST http://127.0.0.1:3002（不按 URL 路径路由）
  -> Authorization: Bearer <config.token>
  -> 解析 { adapterType, request, options? }
  -> 校验现有 InvokeRequest，补本地 AbortSignal
  -> ctx.adapterHost.invoke(adapterType, request, options)
  -> 每个原始输出编码为 SSE data
```

native 是默认模式，返回 HostFrame；显式 canonical 返回 CanonicalEvent。插件不将原生输出改写成业务消息。断开请求或卸载插件会取消其在途调用；卸载关闭监听和已有 HTTP 连接，等待请求处理退出。

此接口只演示 invoke，没有提供审批响应、会话管理、远程授权或历史恢复接口。SSE 只是该插件的传输选择，不成为 IPC Host 的统一传输要求。HTTP 200 表示流已打开，执行结果必须观察真实事件；Host 流异常另发 `event: error`，不伪造成功终态。

## 适用场景与边界

| 场景 | 插件内部负责 |
| --- | --- |
| Octo Channel | Octo 认证、多个 WS、消息转换、卡片与结果投递 |
| WeCom Channel | 企微认证、连接与消息协议 |
| CI / 自建系统 | 触发、可信业务身份、请求构造和回传 |
| 本地目录监听 / 定时任务 | 本地事件、调度与结果处理 |
| HTTP SSE 示例 | HTTP、Bearer、请求转交与流编码 |

Provider Adapter 是执行的被调用实现，不属于这些业务入口。宿主自身业务可以直接调用 `invoke()`，不必包装成 Extra。Extra 的价值是独立装配与生命周期，不是强制所有内部调用绕一层插件。

验证应分别覆盖配置保存、重启加载、鉴权、真实 Host 事件流、初始化失败回收和卸载端口释放。Run=7 与 Context=v3 本次没有变化；示例 HTTP 接口不替代其他 Run 身份、权限、租约合同。

本次自动测试和 im-test 真实桌面/Codex 执行范围见 [验证记录](validation/extra-sse-demo.md)。
