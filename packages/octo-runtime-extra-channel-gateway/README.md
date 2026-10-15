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

保存路径为 `<home>/extras/channel-gateway/config.json`，POSIX 权限为 `0600`。每次 `extraset` 替换完整声明，不追加 Bot、不按 `bot_id` 合并。添加、修改或删除时，必须包含希望保留的完整 `config.bots` 数组。插件名称固定为 `channel-gateway`，多个 Bot 不使用多个插件名。

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
| `run_timeout_ms` | IM 本轮总运行时限，默认 `86400000`（一天），范围 `100..86400000`；包含所有尝试、恢复等待与交互等待 |
| `codex_retry` | 可选 Codex 恢复策略，字段及默认值见下文；不影响其他 Extra |
| `config.authorized_space_ids` | 可选租户授权列表；空数组不授权任何 Space |

本地引擎省略 `adapter.workdir` 时，插件使用并创建 `~/octo-runtime/channels/{bot_id}`。OpenClaw 不填 `workdir`，可选 `provider_agent_id` 默认 `main`；连接配置由宿主通过 Adapter 配置入口准备。未知扩展字段保留并忽略，不代表已经应用；已识别字段继续校验。

## 长任务与 Codex 重试

IM 默认总时限为一天，工具无输出时限也为一天；本轮 Context 的 `octo.execution/limits` 可以显式覆盖。Host 的首帧、模型空闲及工具独立 wall 时限仍按既有合同生效，任务总期限由 Extra 独立计时。重试只拿剩余时长，不会重新获得完整一天。

每个 Bot 可配置 `codex_retry`：

| 字段 | 默认值 | 有效范围 |
| --- | --- | --- |
| `enabled` | `true` | 布尔值；关闭 Extra 的自动恢复及恢复预算 |
| `max_consecutive_retries` | `5` | `0..100`；连续故障段内的重试次数，不含首次调用 |
| `max_total_retries` | `20` | `0..100`；本轮累计重试次数，不随恢复进度归零 |
| `recovery_timeout_ms` | `120000` | `100..3600000`；连续故障恢复时限，与一天任务总时限独立 |
| `initial_delay_ms` | `2000` | `100..60000`；指数退避起点 |
| `max_delay_ms` | `30000` | `100..300000`；必须不小于起点 |

原生 `run.notice/retry_scheduled` 和 Extra 新建尝试共用上述次数与恢复预算。通知表示 Provider 仍在同一次调用内恢复，Extra 此时不会再次 invoke。非空文本增量或工具完成结束连续故障段；心跳、usage、会话更新和重试通知不会刷新恢复时限。退避增加最多 20% 抖动并遵守统一失败中的 `retryAfterMs`；当前错误目录给暂态故障默认 30 秒提示，因此实际等待可能长于 2 秒。等待无法放入剩余预算时直接结束。

Extra 只对 Codex 结构化暂态限流或不可用失败（`OH-PRV-4005/4006` 且 `retryable`）创建新尝试，并等待上次流结束。首期限定在本轮未出现任何工具或交互之前；出现后仍允许 Provider 自身恢复，但不自动重放业务请求。认证、额度、配置、输入错误和未知结果不自动重跑。Extra 与 Host 断流时尽力取消并提示结果未知，不把卡片重试提示当作恢复成功。

一次业务请求维持一张进度卡和一个逻辑最终回复；各尝试保留独立身份及终态，不拼接失败尝试的半截答案。`/stop` 或卡片停止作用于当前尝试，也能停止退避；`/reset` 阻止旧任务继续自动尝试，保留正在执行的调用。任务在途保持去重，结束后重新开始既有的 120 秒终态去重窗口；卡片按钮在任务期间有效，结束后保留 30 分钟。状态 `tasks[].attempts` 提供运行中尝试，终态尝试有界保存在 occurrence 中，不承诺进程重启后恢复或副作用恰好一次。

## SDK 装配

默认导出为 Extra 加载函数，稳定名称为 `channel-gateway`。宿主构造 `{ name: "channel-gateway", module, config: { bots } }`，通过初始 `extras` 声明或运行中的 `runtime.loadExtra(descriptor)` 装配。`module` 使用宿主已安装插件的绝对入口；SDK 不读写 CLI 配置文件。

更新由宿主卸载本插件、保存完整配置、重新加载；插件内所有连接重新建立。CLI 同样使用 `extra unload channel-gateway`、`extraset channel-gateway`、`extra load channel-gateway`，load 读取最新文件，不重启共享 Host。

`runtime.extraStatus("channel-gateway")` 或 `extra status channel-gateway` 返回本插件定义的 `{ "bots": [...], "errors": [...] }`，`runtime.extraStatus()` 查询框架生命周期。每个有效 Bot 包含 `connection_key`、`type: "octo"`、`bot_name`、`enabled`、`connected`、`state`、脱敏 `error`、`deliveries` 和 `sessions`，已解析时包含 `botId` 等连接状态。停用 Bot 保留在数组，显示 `enabled: false`、`state: "stopped"`、`connected: false`。错误配置跳过连接，状态项返回从零开始的 `config_index`、`state: "config_error"` 和脱敏错误码，`errors` 同时记录位置及错误码；有效 Bot 继续初始化。列表或授权配置错误记录在 `errors`，不建立连接。读取内存状态，不发起联网探测；字段由本插件维护，宿主负责解释。完整 SDK 示例见 [对接指南](../../INTEGRATION.md#26-通过-sdk-装配可选-extra)。

凭据只用于连接，不进入模型输入或状态。会话和投递回执有界保存在内存中，不承诺跨进程恢复或 exactly-once。

卸载会取消正在建联、执行和投递的任务，并等待连接及任务清理结束。重复关闭等待同一次清理；任一资源清理失败仍尝试其他资源，最终向宿主返回 `EXTRA_DISPOSE_FAILED`，不能把它当作可忽略的配置错误后立即重载。
