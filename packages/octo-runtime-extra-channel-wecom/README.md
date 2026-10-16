# WeCom Channel

`@mininglamp-oss/octo-runtime-extra-channel-wecom` 独立持有企业微信 Bot WebSocket 鉴权、心跳、消息映射、stream 回复、ACK 顺序和连接替换处理。它不依赖 Octo Gateway Channel，不使用 Octo REST、悟空连接或卡片协议。

目录与 gateway 类似：`transport/`、`application/`、`lifecycle/`、`execution/`、`delivery/`、`presentation/`。每个 channel 独立演进，没有跨平台 connector registry 或按 type 分发的底层工厂。

## CLI 配置多个 Bot

宿主安装本包后提交完整声明：

```bash
octo-runtime extraset channel-wecom <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-wecom",
  "enabled": true,
  "config": {
    "bots": [
      {
        "bot_id": "<WECOM_BOT_ID_1>",
        "bot_name": "本地助理",
        "app_secret": "<WECOM_APP_SECRET_1>",
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/absolute/workspace/first",
          "model": "gpt-6.1-sol",
          "effort": "medium"
        }
      },
      {
        "bot_id": "<WECOM_BOT_ID_2>",
        "bot_name": "项目助理",
        "app_secret": "<WECOM_APP_SECRET_2>",
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/absolute/workspace/second",
          "model": "gpt-6.1-sol",
          "effort": "medium"
        }
      }
    ]
  }
}
JSON
```

保存到 `<home>/extras/channel-wecom/config.json`，POSIX 权限为 `0600`。每次 `extraset` 替换完整声明，不追加或合并。多个 Bot 放在同一个 `config.bots` 数组中；修改时必须提交希望保留的全部 Bot，插件名固定为 `channel-wecom`。

单个 Bot 同样写为 `config.bots: [bot]`，没有单对象格式。上次为 `[botA, botB]`，本次为 `[botB]`，覆盖后只保留 botB；`[]` 表示没有 Bot。省略字段不从旧声明补齐。

保存后，已安装并启用后台服务时执行 `octo-runtime daemon restart`；前台运行使用 `octo-runtime daemon run`。`octo-runtime extra status` 查询插件生命周期，`loaded` 不保证每个 Bot 在线。

凭据可以内联为 `app_secret`，或用 `app_secret_file` 指定，二选一；文件建议使用绝对路径，POSIX 权限要求 `0600`。Bot 内 `enabled` 默认 `true`，控制单个 Bot，外层 `enabled` 控制整个插件。默认 WS 为 `wss://openws.work.weixin.qq.com`。Bot 字段由本插件校验。连接探针为 `scripts/probe-wecom.mjs`。

## 插件字段

下表除 `config.*` 外均为 `config.bots[]` 内的字段。“连接必选”表示允许先保存空凭据配置，但实际建联必须提供。

| 字段 | 必选 / 可选 | 默认值与约束 |
| --- | --- | --- |
| `config.bots` | 可选；接入 Bot 时必选 | 省略为 `[]`；最多 16 项，相同 WS 地址与 `bot_id` 不得重复 |
| `bot_id` | 必选 | 非空企业微信 Bot ID |
| `bot_name` | 可选，建议填写 | 自定义本地展示名称，便于直接区分 Bot，避免通过 `bot_id` 反查；省略时展示 `bot_id`。填写时必须为非空字符串，不参与身份匹配、不修改企业微信上的名称 |
| `app_secret` / `app_secret_file` | 连接必选，二选一 | Secret 或凭据文件；文件建议使用绝对路径，POSIX 权限要求 `0600` |
| `ws_url` | 可选 | 默认 `wss://openws.work.weixin.qq.com` |
| `enabled` | 可选 | 默认 `true`，控制单个 Bot；外层 `enabled` 控制整个插件 |
| `adapter` | 必选 | 执行设置对象；子字段要求见下表 |
| `context` | 可选 | 提供时必须符合 `octo.context-envelope/v3`；允许空 `items` |
| `approval_mode` | 可选 | 默认 `full_access`；支持范围按所选 Adapter 合同 |
| `allowed_sender_ids` | 可选 | 发送者 ID 白名单；省略不按此项限制，`[]` 不允许任何发送者 |
| `run_timeout_ms` | 可选 | 默认 `120000`，范围 `1..600000`，单位毫秒 |
| `config.authorized_space_ids` | 可选 | 租户授权列表；省略不按此项限制，`[]` 不授权任何 Space |

## Adapter 配置与 OpenClaw 示例

`adapter` 与 `channel-gateway` 使用相同的执行字段：

| 字段 | 必选 / 可选 | 默认值与约束 |
| --- | --- | --- |
| `adapter_type` | 可选 | 默认 `codex`，可填 `claude-code`、`codebuddy`、`openclaw` 等；宿主须已安装并配置对应 Provider |
| `workdir` | 本地引擎必选；OpenClaw 禁止 | 本地引擎要求绝对路径，不同于 gateway 可省略目录的默认策略；OpenClaw 工作区由目标 Agent 管理 |
| `model` | 可选 | 对应 Provider 已配置且可用的模型 ID；省略时使用 Provider 默认值 |
| `effort` | 可选 | `low / medium / high / xhigh`；省略不传强度参数，实际应用及降档按 Adapter 合同，见[思考强度](../../.octospec/rules/reasoning.md) |
| `provider_agent_id` | OpenClaw 可选；其他引擎禁止 | 默认 `main`；目标必须已存在，不存在时执行失败，不自动创建或改选 |

以下为单 Bot 使用 OpenClaw 的完整声明。将模型占位符替换为目标 Gateway 可用的模型 ID；也可删除 `model` 使用 Provider 默认值。

```bash
octo-runtime extraset channel-wecom <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-wecom",
  "enabled": true,
  "config": {
    "bots": [
      {
        "bot_id": "<WECOM_BOT_ID>",
        "bot_name": "OpenClaw 助理",
        "app_secret": "<WECOM_APP_SECRET>",
        "adapter": {
          "adapter_type": "openclaw",
          "provider_agent_id": "main",
          "model": "<OPENCLAW_MODEL_ID>",
          "effort": "high"
        }
      }
    ]
  }
}
JSON

octo-runtime daemon restart
```

此命令整体替换 WeCom 插件配置；同时接入 Codex 和 OpenClaw 时，将两个不同 Bot 的配置放进同一次提交的 `bots` 数组。OpenClaw Gateway 连接由宿主预先准备，不能将 Gateway URL/token 填入 Bot 的 `adapter`；`ws_url` 是企业微信连接地址。连接准备见 [OpenClaw 合同](../../.octospec/rules/openclaw.md)。使用自定义 `--home` 时，保存和重启使用同一个 Home；未运行后台服务时使用 `daemon run`。

## SDK 装配

默认导出为 Extra 加载函数，稳定名称为 `channel-wecom`。宿主构造 `{ name: "channel-wecom", module, config: { bots } }`，通过初始 `extras` 声明或运行中的 `runtime.loadExtra(descriptor)` 装配。`module` 使用宿主已安装插件的绝对入口；SDK 不读写 CLI 配置文件。

宿主卸载本插件、保存完整配置并重新加载，插件内连接整体重建。CLI 使用 `extra unload channel-wecom`、`extraset channel-wecom`、`extra load channel-wecom`，load 读取最新文件。

`runtime.extraStatus("channel-wecom")` 或 `extra status channel-wecom` 返回本插件自己的 `{ "bots": [...], "errors": [...] }`。有效项包含 `connection_key`、`type: "wecom"`、`enabled`、`connected`、`state`、脱敏 `error`、`deliveries`、`sessions`，可包含已解析的 `botId`。停用项仍可见，`enabled: false`、`state: "stopped"`、`connected: false`。错误配置跳过连接，状态项返回从零开始的 `config_index`、`state: "config_error"` 和脱敏错误码，`errors` 同时记录位置及错误码；有效 Bot 继续初始化。列表或授权配置错误记录在 `errors`，不建立连接。状态同步读取内存，由宿主解释，不依赖 Octo 状态模型。`runtime.extraStatus()` 查询生命周期。完整示例见 [SDK 对接指南](../../INTEGRATION.md#26-通过-sdk-装配可选-extra)。

本包作为 Event 发起方提交本轮 Context，空输入与显式重复有效；不会按会话补齐上下文。执行配置独立校验，不进入模型文本。Run=7、Context=v3。会话与回执使用有界内存，不承诺跨重启恢复；真实企业微信客户端显示效果需平台验收。

卸载会取消正在建联、执行和投递的任务，并等待连接及任务清理结束。重复关闭等待同一次清理；任一资源清理失败仍尝试其他资源，最终向宿主返回 `EXTRA_DISPOSE_FAILED`，不能把它当作可忽略的配置错误后立即重载。
