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
        "app_secret": "<WECOM_APP_SECRET_1>",
        "adapter": { "adapter_type": "codex", "workdir": "/absolute/workspace/first", "model": "gpt-6.1-sol", "effort": "medium" }
      },
      {
        "bot_id": "<WECOM_BOT_ID_2>",
        "app_secret": "<WECOM_APP_SECRET_2>",
        "adapter": { "adapter_type": "codex", "workdir": "/absolute/workspace/second", "model": "gpt-6.1-sol", "effort": "medium" }
      }
    ]
  }
}
JSON
```

保存到 `<home>/extras/channel-wecom/config.json`，POSIX 权限为 `0600`。每次 `extraset` 替换完整声明，不追加或合并。多个 Bot 放在同一个 `config.bots` 数组中；修改时必须提交希望保留的全部 Bot，插件名固定为 `channel-wecom`。

单个 Bot 同样写为 `config.bots: [bot]`，没有单对象格式。上次为 `[botA, botB]`，本次为 `[botB]`，覆盖后只保留 botB；`[]` 表示没有 Bot。省略字段不从旧声明补齐。

保存后，已安装并启用后台服务时执行 `octo-runtime daemon restart`；前台运行使用 `octo-runtime daemon run`。`octo-runtime extra status` 查询插件生命周期，`loaded` 不保证每个 Bot 在线。

凭据可以内联为 `app_secret`，或用 `app_secret_file` 指定，二选一；文件建议使用绝对路径，POSIX 权限要求 `0600`。Bot 内 `enabled` 默认 `true`，控制单个 Bot，外层 `enabled` 控制整个插件。默认 WS 为 `wss://openws.work.weixin.qq.com`。Bot 字段由本插件校验；Octo 的 `bot_name` 不属于 WeCom 当前合同，不应混用。连接探针为 `scripts/probe-wecom.mjs`。

## SDK 装配

默认导出为 Extra 加载函数，稳定名称为 `channel-wecom`。宿主构造 `{ name: "channel-wecom", module, config: { bots } }`，通过初始 `extras` 声明或运行中的 `runtime.configureExtra(descriptor)` 装配。`module` 使用宿主已安装插件的绝对入口；SDK 不读写 CLI 配置文件。

动态更新提交完整数组，插件保留未变化连接、更新变化项并移除缺席项。通过 `runtime.requestExtra("channel-wecom", "status")` 查询 Bot 状态，`runtime.extraStatus()` 查询生命周期。完整示例见 [SDK 对接指南](../../INTEGRATION.md#26-通过-sdk-装配可选-extra)。

本包作为 Event 发起方提交本轮 Context，空输入与显式重复有效；不会按会话补齐上下文。执行配置独立校验，不进入模型文本。Run=7、Context=v3。会话与回执使用有界内存，不承诺跨重启恢复；真实企业微信客户端显示效果需平台验收。
