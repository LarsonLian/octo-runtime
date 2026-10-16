---
type: Guide
title: Extra 配置与调用
description: 当前 CLI 路径、SDK 声明及本地 WebUI。
tags: ["extra"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# Extra 配置与调用

## 原始 JSON Schema 配置合同

三个内置 Extra 各自提供完整的 `config-schema.json`，约束对象是 CLI 保存的整个 `{ module, enabled?, config }` 声明，不只是内层 `config`。字段 `description` 说明用途、何时填写、必填条件、当前省略行为及运行时边界；`required`、`const`、`enum`、范围和条件分支提供机器可读约束。`module` 固定为对应内置包名，`model` 保留业务方选择的模型 ID 字符串。

| Extra | 仓库文件 | 单一 npm 发行包公开入口 |
| --- | --- | --- |
| Octo IM | [config-schema.json](../../packages/octo-runtime-extra-channel-gateway/config-schema.json) | `@mininglamp-oss/octo-runtime/extras/channel-gateway/config-schema.json` |
| 企业微信 | [config-schema.json](../../packages/octo-runtime-extra-channel-wecom/config-schema.json) | `@mininglamp-oss/octo-runtime/extras/channel-wecom/config-schema.json` |
| 本地 WebUI | [config-schema.json](../../packages/octo-runtime-webui-extra/config-schema.json) | `@mininglamp-oss/octo-runtime/extras/webui/config-schema.json` |

接入方可通过 `import.meta.resolve(公开入口)` 找到原始 JSON 文件，再自行参考、编译为校验器或生成类型。仓库内包也导出自己的 `/config-schema.json` 子路径；第三方使用上表公开入口，不要求单独安装私有 workspace 包。两个 Channel 的 `context` 为可选字段，配置后由 IM Channel 在执行 AgentRun 时固定附带；仅声明 `schema` 固定为 `octo.context-envelope/v3`、`items` 为对象数组，不展开 item 内部字段，也不内嵌或引用完整协议 schema。item 内容仍须遵循整个 octo-runtime 的 Context v3 协议，由现有运行时校验。

schema 的 Bot、Adapter、重试等字段全部直接内联，不使用 `$ref` 或 `definitions` 拆分，按实际配置层级从外向内阅读即可。schema 仅提供声明性合同，不给统一加载器增加强制校验、Zod 或配置编译步骤；`load(context, config: JsonObject)`、CLI 原始 JSON 与 SDK 对象入口保持现有合同。业务方决定如何构造配置、是否使用 schema 以及选用什么工具。若只校验 SDK 的内层配置，可直接取 schema 的 `properties.config` 对象；SDK 声明的 `name` 不属于此 CLI schema。

`default` 是插件现有省略行为的说明，不会自动写入或转换数据，也不要求其他宿主沿用同一业务策略。OpenClaw 的 `provider_agent_id` 仅选择预先存在的目标 Agent，省略用 `main`；不能用于其他引擎，也不创建 Agent。凭据可先省略以暂存配置，实际连接仍需有效凭据。schema 示例全部使用占位值，不能证明可建联。

宿主负责从 JSON、SQLite、Nacos 等来源取得配置并传入实际值；例如 Bot Token 通过 `bf_token` 传值，企业微信 Secret 通过 `app_secret` 传值。插件不提供 `bf_token_file` / `app_secret_file`，也不根据配置自动选择来源、读文件或连接配置中心。本次不提供旧凭据文件配置的兼容、迁移或回退。后续字段设计统一遵循[架构责任边界](../rules/architecture.md#配置来源归宿主sdk-消费配置值)。

普通 JSON Schema 不能证明凭据有效、路径可访问、Provider 或 Agent 已存在，也不能覆盖动态数值比较、Bot 组合判重及所有 `x-octo-*` Context 语义约束；这些继续由插件和现有协议校验器处理。`additionalProperties` 按各插件当前边界设置：顶层声明拒绝未知字段，WeCom Bot/Adapter 拒绝未知字段，Octo Bot/Adapter 与插件 config 保留未知扩展。不要把 `$schema` 写入 CLI 声明本身，外层当前不接受该字段。

同名字段不等于相同平台效果：Octo Gateway 的 `authorized_space_ids` 会核对 octo-auth 得到的 Space；当前企业微信没有解析并核对 Octo Space 身份，该字段只校验格式，不能当作已生效的 Space 准入。schema 与 WeCom 字段表明确记录此边界，不为补文档而改变连接逻辑。

## 没有 Runtime 源码时开发插件

客户工程局部安装发行包以解析类型，不能依赖全局 npm 安装的类型：

```sh
npm install @mininglamp-oss/octo-runtime
npm install -D typescript @types/node
```

工程使用 ESM（package.json 设置 `"type": "module"`），tsconfig 使用 `module/moduleResolution: NodeNext`，目标 ES2022 或以上。编译产物是普通 JS，Runtime 运行要求 Node 24 或以上。只使用类型时用 import type；需要检查外部请求时普通 import InvokeInput。

```ts
import {
  InvokeInput,
  isTerminal,
  type ExtraPlugin,
  type ExtraContext,
  type CanonicalEvent
} from "@mininglamp-oss/octo-runtime/extra";

export const name = "customer-service";

// 业务服务在收到已认证、已授权请求后调用；JSON 必须经过运行时检查。
export async function execute(ctx: ExtraContext, value: unknown) {
  const input = InvokeInput.check(value);
  const events = ctx.adapterHost.invoke(
    { ...input, protocol_mode: "canonical" },
    { signal: ctx.signal }
  );
  for await (const event of events) {
    const output: CanonicalEvent = event;
    // 在这里消费或回传业务结果；terminal 可能是完成、失败或取消。
    if (isTerminal(output)) return output;
  }
}

const load: ExtraPlugin = (ctx, config) => () => {
  ctx.onStatus(() => ({ enabled: true }));
  // 在此用 config 启动业务监听，并以 ctx.onDispose 登记关闭监听和等待任务退出。
};
export default load;
```

外层同步返回初始化函数，实际连接和清理登记放在内层。CLI 只读取 JSON，加载器以 `{}` 调用内层；旧 void/Promise 入口不再支持。需要宿主业务函数时，在同一 Node 进程使用公开 ExtraPlugins 的 `load(module, jsonConfig, dependencies)`；现有 `runtime.loadExtra(descriptor)` 仍为 JSON 声明接口，本轮不迁移 SDK 进程装配，不支持把函数放进 descriptor。

两个 Channel 内层接收可选 `ChannelDependencies.loadContexts`：`(botConfig, {signal}) => readonly ContextItem[] | Promise<readonly ContextItem[]>`。回调每个准入轮次执行一次，静态与动态同 namespace/name 整项替换并保留位置。业务函数须响应 signal，不缓存历史结果；JSON 的 `context_loading` 可指定 `timeout_ms`（默认 5000，1..30000）及 `max_in_flight`（默认 8，1..32）。超时未结束继续占名额；满额拒绝当前轮次。

三个 Extra 的新配置示例显式携带下列固定人设。Gateway/WeCom 放在 `config.bots[i].context`，WebUI 放在 `config.context`；不为已有省略或空列表自动填充：

```json
{"schema":"octo.context-envelope/v3","items":[{"namespace":"octo.control","name":"instructions","payload":{"entries":[{"text":"我是明略科技的Octo助理"}]}}]}
```

invoke 的 input 由业务构造，至少含 inputs 与 contexts；Context=v3，必要执行 adapter 独立选择，完整示例见 [InvokeInput 规则](../rules/invoke-input.md)。运行中的交互通过 `ctx.adapterHost.respondInteraction(invocationId, response)` 回复，取消通过 cancel 或调用环境的 AbortSignal；需要按请求取消时建立自己的 controller，并响应 Extra 的 signal。

公开类型还包括 ExtraAdapterHost、ExtraDescriptor、ExtraPluginModule、JsonObject/JsonValue、InvokeEnvironment、InputInvoke、HostFrame/HostRunReceipt/HostControl、ContextEnvelope/ContextItem、ModelInputPart、AgentConfig、ProviderSession、RuntimeLimits、McpServers、InteractionResponse、ApprovalRequest、FailureEnvelope 及完整协议类型。`/protocol` 可单独导入协议类型、InvokeInput.check、事件校验与终态工具，不需要私有包。

安装编译后的第三方包，使用 extraset 将 module 设为已安装入口的绝对路径，再重启同一 Home 的 daemon；不要假设全局 Runtime 能按包名找到项目局部安装的插件。当前 CLI 没有 extra load/unload/status 命令；单插件控制属于宿主 SDK。完整发布和验证要求见 [公开插件合同](../tasks/public-plugin-contracts/brief.md)。

本文描述宿主编排卸载、修改配置和重新加载的入口。状态能力必备且默认 `{}`，没有原地更新与通用业务 RPC。详见 [Extra 规则](../rules/extras.md)和[责任边界决策](../tasks/extra-responsibility-boundary/brief.md)。

CLI 是个人设备的 headless 运维入口。普通用户由 Desktop App 静默准备配置并启动 Runtime，无需使用 CLI，也无需让 App 调用 CLI。

```sh
octo-runtime extraset webui <<JSON
{
  "module": "@mininglamp-oss/octo-runtime-webui-extra",
  "enabled": true,
  "config": {
    "port": 13888,
    "sessionStorePath": "$HOME/.octo-runtime/extras/webui/sessions.json",
    "context": {
      "schema": "octo.context-envelope/v3",
      "items": [{
        "namespace": "octo.control",
        "name": "instructions",
        "payload": { "entries": [{ "text": "我是明略科技的Octo助理" }] }
      }]
    }
  }
}
JSON
```

命令接收完整对象，原子替换保存到：

```text
~/.octo-runtime/extras/webui/config.json
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

Octo 返回 `{ bots: [...] }`，每个 Bot 含 `enabled`、`state`、`connected` 和脱敏 `error`；停用项仍可见。WebUI 返回 `{ listening, host, port, activeRequests, errors }`；这些字段由各插件定义。`IM_BOT_TOKEN_INVALID` 表示凭据格式错误（例如仍是 `<BF_TOKEN>` 占位符），`IM_AUTH_HTTP_401` 表示服务拒绝鉴权。`api_url` 必须是纯 URL，不能填写 Markdown 链接。

```sh
# 在此通过 extraset webui 保存最新完整声明
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
    name: "webui",
    module: "/absolute/installed-extra/dist/index.js",
    config: {
      port: 13888,
      sessionStorePath: "/absolute/app-owned/runtime-home/extras/webui/sessions.json",
      context: {
        schema: "octo.context-envelope/v3",
        items: [{ namespace: "octo.control", name: "instructions",
          payload: { entries: [{ text: "我是明略科技的Octo助理" }] } }]
      }
    }
  }]
});
```

宿主按既有 SDK 合同启动账号。声明随受保护的 runner session 传入子进程；同账号重启恢复最新成功声明，Desktop App 下一次启动仍须从自己的存储构造配置。本次没有将 WebUI 默认启用到 Work App。

启动账号后调用 `runtime.loadExtra(descriptor)` 加载完整声明；更新由宿主先等待 `runtime.unloadExtra(name)`，修改并保存自己的配置，再加载最新声明。`extraStatus()` 查询生命周期，`extraStatus(name)` 查询插件同步回调返回的自定义 JSON 对象，默认 `{}`。没有通用业务请求接口，也不自动重载。SDK 不写 CLI 文件；加载失败不回滚宿主已保存配置。

IM 插件加载完整 bots，重载会重新建立该插件内连接；宿主传入 authorized_space_ids 约束 Octo 认证得到的租户。Work App 已使用统一 Extra，SQLite 只属于宿主，逐 Bot 界面操作转换为所属 Extra 的整体重载。完整的 Node 与桌面发行接入见 [接入指南](../../SDK_CHANNEL_GATEWAY_GUIDE.md#5-保存或重新加载-im-配置)。

已有 Node 宿主还可使用 `startDaemonServer({ extras })`，通过 `extraRegistration(descriptor)` 构造动态声明，或直接注入 `ExtraRegistration.load` 工厂。各方式都复用同一个 Host。

## 本地 WebUI 与 canonical SSE

[WebUI 包说明](../../packages/octo-runtime-webui-extra/README.md) 给出配置、SDK 及接口。打开 `http://127.0.0.1:13888/` 即可使用本地项目、会话与聊天页面；复用共享 Host，不以云端登录为前提。

```text
GET http://127.0.0.1:13888/
  -> 页面 HttpOnly / SameSite cookie
POST /api/invoke（同源 Origin + 页面 token）
  -> 解析 InvokeInput JSON（与 CLI / SDK 相同）
  -> 校验统一协议，创建本地 AbortSignal
  -> ctx.adapterHost.invoke(input, {signal})
  -> 每个原始输出编码为 SSE data
```

WebUI 显式要求 canonical，后端完整传递 CanonicalEvent；前端移植 Work App 的投影、reducer 和 Transcript。断开请求或卸载插件会取消其在途调用；卸载关闭监听和已有 HTTP 连接，等待请求处理退出。

WebUI 提供取消、审批响应、目录选择及会话 JSON 管理。最多保存 100 个会话及完整 Provider binding，超限淘汰旧的非活动记录；单条/全部清理不删除 Provider 原生会话或项目文件。SSE 只是该插件的传输选择，不成为 IPC Host 的统一传输要求。HTTP 200 表示流已打开，执行结果必须观察真实事件；Host 流异常另发 `event: error`，不伪造成功终态。


当前行为依据 [extraset](../../apps/cli/src/extras.ts)、[daemon 装配](../../apps/daemon/src/index.ts) 及 [加载合同](../rules/extras.md)。旧 demo 包已移除，已有声明不会自动删除；按宿主决定停用旧声明并显式启用 WebUI，不能沿用旧包名。
