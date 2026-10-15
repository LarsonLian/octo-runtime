# Octo Gateway Channel

`@mininglamp-oss/octo-runtime-extra-channel-gateway` 只负责 Octo IM 接入：Bot 认证、悟空长连接、消息与卡片、typing、Context v3 和结果回发。企业微信由独立的 `octo-runtime-extra-channel-wecom` 持有。

本包是 IM Event 发起方，决定本轮 Context 的内容、顺序和发送时机。允许空上下文或显式重复；Host 只校验、转发和固定渲染，不从历史补齐上下文。执行配置与模型上下文独立，Run=7、Context=v3。

## 结构

`transport/` 持有 Octo 协议和 REST API；`application/` 管理单 Bot 会话与调用；`lifecycle/` 管理配置和启停；`execution/`、`delivery/`、`presentation/` 负责本包的调用与输出。没有跨平台 connector registry，不依赖 WeCom channel。

## CLI 配置多个 Bot

宿主先安装本包及所需 Provider，再提交完整声明：

```bash
octo-runtime extraset channel-gateway <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-gateway",
  "enabled": true,
  "config": {
    "bots": [
      {
        "api_url": "https://im-test.deepminer.com.cn/api",
        "bot_id": "<BOT_ID_1>",
        "bot_name": "本地助理",
        "bf_token": "<BOT_TOKEN_1>",
        "adapter": { "adapter_type": "codex", "workdir": "/absolute/workspace/first", "model": "gpt-6.1-sol", "effort": "medium" }
      },
      {
        "api_url": "https://im-test.deepminer.com.cn/api",
        "bot_id": "<BOT_ID_2>",
        "bf_token": "<BOT_TOKEN_2>",
        "adapter": { "adapter_type": "codex", "workdir": "/absolute/workspace/second", "model": "gpt-6.1-sol", "effort": "medium" }
      }
    ]
  }
}
JSON
```

保存路径为 `<home>/default/extra/channel-gateway/config.json`，POSIX 权限为 `0600`。每次 `extraset` 替换完整声明，不追加 Bot、不按 `bot_id` 合并。添加、修改或删除时，必须包含希望保留的完整 `config.bots` 数组。插件名称固定为 `channel-gateway`，多个 Bot 不使用多个插件名。

单个 Bot 也使用 `config.bots: [bot]`，没有单对象格式。上次为 `[botA, botB]`，本次为 `[botB]`，覆盖后只保留 botB；`[]` 表示没有 Bot。声明内省略的字段不会从旧配置补齐。

保存后，已安装并启用后台服务的设备执行 `octo-runtime daemon restart`；前台运行使用 `octo-runtime daemon run`。`octo-runtime extra status` 查询生命周期，`loaded` 不表示所有 Bot 在线。配置写入不安装包、不立即连接，也不修改运行中的配置。

## 插件字段

框架只校验声明和 JSON 结构，Bot 字段由本插件解释。

| 字段 | 含义 |
| --- | --- |
| `config.bots` | 最多 16 项；相同 API 地址与 `bot_id` 不得重复 |
| `bot_name` | 可选本地展示名称，省略时运行状态使用 `bot_id`；不参与身份匹配、不修改远端名称；`name` 不是别名 |
| Bot 内的 `enabled` | 默认 `true`，控制单个 Bot；外层 `enabled` 控制整个插件 |
| `bf_token` / `bf_token_file` | 凭据来源二选一；文件建议使用绝对路径，POSIX 权限要求 `0600` |
| `adapter` | 执行设置对象，可配置引擎、模型、思考强度和绝对工作目录 |
| `config.authorized_space_ids` | 可选租户授权列表；空数组不授权任何 Space |

本地引擎省略 `adapter.workdir` 时，插件使用并创建 `~/octo-runtime/channels/{bot_id}`。OpenClaw 不填 `workdir`，可选 `provider_agent_id` 默认 `main`；连接配置由宿主通过 Adapter 配置入口准备。未知扩展字段保留并忽略，不代表已经应用；已识别字段继续校验。

## SDK 装配

默认导出为 Extra 加载函数，稳定名称为 `channel-gateway`。宿主构造 `{ name: "channel-gateway", module, config: { bots } }`，通过初始 `extras` 声明或运行中的 `runtime.configureExtra(descriptor)` 装配。`module` 使用宿主已安装插件的绝对入口；SDK 不读写 CLI 配置文件。

动态更新同样提交完整数组。本插件移除缺席的 Bot，只更新变化项，保留未变化连接。`runtime.requestExtra("channel-gateway", "status")` 查询 Bot 状态，`runtime.extraStatus()` 查询生命周期。完整 SDK 示例见 [对接指南](../../INTEGRATION.md#26-通过-sdk-装配可选-extra)。

凭据只用于连接，不进入模型输入或状态。会话和投递回执有界保存在内存中，不承诺跨进程恢复或 exactly-once。
