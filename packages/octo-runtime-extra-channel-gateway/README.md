# Octo Gateway Channel

`@mininglamp-oss/octo-runtime-extra-channel-gateway` 只负责 Octo IM 接入：Bot 认证、悟空长连接、消息与卡片、typing、Context v3 和结果回发。企业微信由独立的 `octo-runtime-extra-channel-wecom` 持有。

本包是 IM Event 发起方，决定本轮 Context 的内容、顺序和发送时机。允许空上下文或显式重复；Host 只校验、转发和固定渲染，不从历史补齐上下文。执行配置与模型上下文独立，Run=7、Context=v3。

## 结构

`transport/` 持有 Octo 协议和 REST API；`application/` 管理单 Bot 会话与调用；`lifecycle/` 管理配置和启停；`execution/`、`delivery/`、`presentation/` 负责本包的调用与输出。没有跨平台 connector registry，不依赖 WeCom channel。

## 初始化与动态 Context

入口为 `extra(context, jsonConfig)(dependencies)`：外层同步返回函数，内层异步启动。CLI 以 `{}` 初始化，使用各 Bot 显式配置的 context；下面的新配置示例均包含“我是明略科技的Octo助理”。省略 context 不会自动填充。instructions.entries 只接受 `{ text }`，旧 source 字段会被拒绝。

同进程宿主可经公开 `ExtraPlugins.load(module, jsonConfig, { loadContexts })` 注入业务函数：`loadContexts(botConfig, { signal })` 返回 ContextItem 数组或 Promise。每个已接纳轮次调用一次，同 namespace/name 动态整项替换静态项并保留位置，新项按动态顺序追加；重试复用本轮快照。函数不进入 JSON，插件内部 manager 不向宿主暴露。本轮未改 SDK HostApp 的函数装配，既有 runtime.loadExtra 仍只接收 JSON。

插件级 JSON 配置 `context_loading` 支持 `timeout_ms`（默认 5000，1..30000）和 `max_in_flight`（默认 8，1..32）。超时、异常或容量已满时本轮不调用模型；未结束的 IO 继续占名额，没有等待回调的队列或历史结果缓存。业务函数必须响应 signal；`/stop` 及卸载会取消加载。任意外部同步代码和自行建立的缓存不受框架内存预算约束。完整合同见[配置指南](../../.octospec/guides/extra-configuration.md)。

## CLI 配置多个 Bot

完整配置合同见 [config-schema.json](config-schema.json)，包含外层 `module`、`enabled`、`config` 及全部嵌套字段的用途、必填关系、限制和占位示例。包括 Codex 重试预算和 OpenClaw 条件字段；`provider_agent_id` 是 Provider 已有 Agent 的 ID，不是 Octo Bot ID。schema 的使用及单一发行包公开入口见 [配置指南](../../.octospec/guides/extra-configuration.md#原始-json-schema-配置合同)。

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
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/absolute/workspace/first",
          "model": "gpt-6.1-sol",
          "effort": "medium"
        },
        "context": {
          "schema": "octo.context-envelope/v3",
          "items": [
            {
              "namespace": "octo.control",
              "name": "instructions",
              "payload": {
                "entries": [
                  {
                    "text": "我是明略科技的Octo助理"
                  }
                ]
              }
            }
          ]
        }
      },
      {
        "api_url": "https://im-test.deepminer.com.cn/api",
        "bot_id": "<BOT_ID_2>",
        "bf_token": "<BOT_TOKEN_2>",
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/absolute/workspace/second",
          "model": "gpt-6.1-sol",
          "effort": "medium"
        },
        "context": {
          "schema": "octo.context-envelope/v3",
          "items": [
            {
              "namespace": "octo.control",
              "name": "instructions",
              "payload": {
                "entries": [
                  {
                    "text": "我是明略科技的Octo助理"
                  }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
JSON
```

保存路径为 `<home>/extras/channel-gateway/config.json`，POSIX 权限为 `0600`。每次 `extraset` 替换完整声明，不追加 Bot、不按 `bot_id` 合并。添加、修改或删除时，必须包含希望保留的完整 `config.bots` 数组。插件名称固定为 `channel-gateway`，多个 Bot 不使用多个插件名。

单个 Bot 也使用 `config.bots: [bot]`，没有单对象格式。上次为 `[botA, botB]`，本次为 `[botB]`，覆盖后只保留 botB；`[]` 表示没有 Bot。声明内省略的字段不会从旧配置补齐。

保存后，已安装并启用后台服务的设备执行 `octo-runtime daemon restart`；前台运行使用 `octo-runtime daemon run`。`octo-runtime status` 查询生命周期，`loaded` 不表示所有 Bot 在线。配置写入不安装包、不立即连接，也不修改运行中的配置。

## 插件字段

框架只校验声明和 JSON 结构，Bot 字段由本插件解释。下表除 `config.*` 外均为 `config.bots[]` 内的字段。“连接必选”表示允许先保存空凭据配置，但实际建联必须提供。

| 字段 | 必选 / 可选 | 默认值与约束 |
| --- | --- | --- |
| `config.bots` | 可选；接入 Bot 时必选 | 省略为 `[]`；最多 64 项，相同 API 地址与 `bot_id` 不得重复。管理操作最多 64 个在途，单份配置最多 256 KiB |
| `api_url` | 必选 | Octo API 地址，如 `https://im-test.deepminer.com.cn/api` |
| `bot_id` | 必选 | 非空 Bot ID |
| `bot_name` | 可选，建议填写 | 自定义本地展示名称，便于直接区分 Bot，避免通过 `bot_id` 反查；省略时展示 `bot_id`。不参与身份匹配、不修改远端名称；`name` 不是别名 |
| `enabled` | 可选 | 默认 `true`，控制单个 Bot；外层 `enabled` 控制整个插件 |
| `bf_token` | 连接必选 | 宿主解析配置来源后传入的 Bot Token 值；插件不读取凭据文件或配置中心 |
| `adapter` | 必选 | 执行设置对象；子字段要求见下表 |
| `context` | 可选 | 提供时必须符合 `octo.context-envelope/v3`；允许空 `items` |
| `approval_mode` | 可选 | 默认 `full_access`；支持范围按所选 Adapter 合同 |
| `allowed_sender_ids` | 可选 | 发送者 ID 白名单；省略不按此项限制，`[]` 不允许任何发送者 |
| `run_timeout_ms` | 可选 | 默认 `86400000`（一天），范围 `100..86400000`；包含所有尝试、恢复等待与交互等待 |
| `codex_retry` | 可选 | Codex 恢复策略；各子字段均可选，默认值见下文；不影响其他 Extra |
| `config.authorized_space_ids` | 可选 | 租户授权列表；省略不按此项限制，`[]` 不授权任何 Space |

| `adapter` 子字段 | 必选 / 可选 | 默认值与约束 |
| --- | --- | --- |
| `adapter_type` | 可选 | 默认 `codex`，如需 OpenClaw 必须显式填 `openclaw` |
| `workdir` | 本地引擎可选；OpenClaw 禁止 | 本地引擎省略时使用下述固定目录；填写时必须为绝对路径 |
| `model` | 可选 | 对应 Provider 可用的模型 ID；省略时使用 Provider 默认值 |
| `effort` | 可选 | `low / medium / high / xhigh`；省略不传强度参数，实际应用及降档按 Adapter 合同 |
| `provider_agent_id` | OpenClaw 可选；其他引擎禁止 | 默认 `main`；目标 Agent 必须已存在 |

本地引擎省略 `adapter.workdir` 时，插件使用并创建 `~/octo-runtime/channels/{bot_id}`。OpenClaw 不填 `workdir`，可选 `provider_agent_id` 默认 `main`；连接配置由宿主通过 Adapter 配置入口准备。未知扩展字段保留并忽略，不代表已经应用；已识别字段继续校验。

### OpenClaw 配置示例

```bash
octo-runtime extraset channel-gateway <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-gateway",
  "enabled": true,
  "config": {
    "bots": [
      {
        "api_url": "https://im-test.deepminer.com.cn/api",
        "bot_id": "<BOT_ID>",
        "bf_token": "<BOT_TOKEN>",
        "adapter": {
          "adapter_type": "openclaw",
          "provider_agent_id": "main",
          "model": "<OPENCLAW_MODEL_ID>",
          "effort": "high"
        },
        "context": {
          "schema": "octo.context-envelope/v3",
          "items": [
            {
              "namespace": "octo.control",
              "name": "instructions",
              "payload": {
                "entries": [
                  {
                    "text": "我是明略科技的Octo助理"
                  }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
JSON

octo-runtime daemon restart
```

`model` 替换为目标 Gateway 已配置且可用的模型 ID，也可删除以使用 Provider 默认值。`effort` 可选 `low / medium / high / xhigh`，实际应用及降档见[思考强度](../../.octospec/rules/reasoning.md)。目标 Agent 必须已存在，OpenClaw 不填 `workdir`；Gateway 连接由宿主预先准备，见 [OpenClaw 合同](../../.octospec/rules/openclaw.md)。此命令整体替换插件声明，多个 Bot 须在同一次提交的 `bots` 数组中保留。使用自定义 `--home` 时保存和重启使用同一个 Home；前台运行使用 `daemon run`。

IM Agent 使用固定工作目录，任务 Context 的 workspace 不得覆盖；reset 只切换会话和 Provider binding。新会话首次普通输入自动尝试一次读取当前 DM/群/话题此前最多 15 条消息，裁剪为最多 1500 Unicode 字符的纯文本背景。失败或空结果继续当前任务，同一会话后续不再自动拉取；reset 后下一条普通消息重新获得一次资格，也可以包含 reset 前历史。不提供旧 `history_limit` 模式，不新增上下文或 binding 持久化。

群/话题须通过发送者及范围准入，并在本条消息中真实点名当前 Bot UID，或提供纯 `mention.ais=1` 的 @所有AI。all/humans 置位时抑制单独 ais 路径，直接 UID 点名仍有效。正文名称、Markdown 示例及前一条消息的 @ 不构成触发，不提供免 @ 开关。

独立图片消息（type=2）仅接入 Codex，每条一张，无需说明文字；群/话题图片自身仍须满足上述 mention 门槛。支持 PNG/JPEG/WebP，单图最多 2 MiB，先准入再下载，原字节经 `inputs` 传递。下载逐跳校验地址，仅向原 API 同源发送 Bot 凭据；不下载历史、富文本或转发中的图片，不写图片文件。其他引擎明确返回不支持，不静默转成文本执行。

新收到的富文本（type=14）及合并转发（type=11）支持文本阅读，正文统一放入本轮 Context v3 的 `extra.im/message-content`；保留段落、转发来源及顺序，不展开频道历史。内部 mention、`/reset`、`/stop` 不参与准入或命令；图片/附件仅标明未读取。文本预算为 12000 Unicode 码点、转发条目与富文本块合计 128 个、访问深度 0..3，超量明确标记，完全没有有效支持文本则不执行。

普通回复不自动 @ 发起者。用户明确要求通知真人时，模型可按首次 `extra.im/mention-instructions` 指引查询 UID，在成功的最终回答普通正文中输出 `@[uid:displayName]`；Channel 按当前群成员校验，转换成可读正文和原生 mention，一并通过原连接发送。代码块、行内代码、引用和进度不转换。查不到或无法确认真人时退为普通 @名字，正文继续发送；不另发 CLI 消息、不开放模型出站 Bot 点名或广播。历史只自动尝试一次；尚无 Provider binding 时，Channel 在下一次调用中显式重提短指引。

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

更新由宿主卸载本插件、保存完整配置、重新加载；插件内所有连接重新建立。CLI 使用 `extraset channel-gateway` 保存完整声明，再用 `daemon restart` 读取最新文件；前台未安装服务时停止并重新运行 `daemon run`。单插件装卸通过宿主接口完成。

`runtime.extraStatus("channel-gateway")` 返回本插件定义的 `{ "bots": [...], "errors": [...] }`，`runtime.extraStatus()` 查询框架生命周期；CLI 使用 `octo-runtime status`。每个有效 Bot 包含 `connection_key`、`type: "octo"`、`bot_name`、`enabled`、`connected`、`state`、脱敏 `error`、`deliveries` 和 `sessions`，已解析时包含 `botId` 等连接状态。停用 Bot 保留在数组，显示 `enabled: false`、`state: "stopped"`、`connected: false`。错误配置跳过连接，状态项返回从零开始的 `config_index`、`state: "config_error"` 和脱敏错误码，`errors` 同时记录位置及错误码；有效 Bot 继续初始化。列表或授权配置错误记录在 `errors`，不建立连接。读取内存状态，不发起联网探测；字段由本插件维护，宿主负责解释。完整 SDK 示例见 [对接指南](../../SDK_CHANNEL_GATEWAY_GUIDE.md#5-保存或重新加载-im-配置)。

## Bot 连接状态机

| state | 含义 | connected / error |
| --- | --- | --- |
| stopped | 未启动、禁用或主动停止 | false / null |
| connecting | 本次启动的首次连接尝试 | false / null |
| online | 身份校验、注册、WS 握手全部成功 | true / null |
| retrying | 曾上线后断线，等待或正在恢复连接 | false / 最近连接错误码 |
| failed | 首次连接失败，或恢复遇到终端错误 | false / 真实连接错误码 |

只有 online 表示连接健康。首次尝试任一步失败均结束本次启动，不后台重试；缺凭据也不会定时轮询。宿主补齐配置后显式卸载/重载 Extra，CLI 使用上节的卸载、保存、加载流程。一个 Bot 失败不影响其他 Bot，也不把 Extra 的 loaded 变为 Bot 已上线的证明。

本次启动曾完整上线后，网络异常断线按 5、10、20、30、30 秒等待恢复。每次等待从上次失败和资源回收完成后开始；恢复请求进行中仍为 retrying。每次完整成功自动清连接错误和计数，下一次断线重新从 5 秒开始。只有注册成功不算恢复；已识别 429 的 Retry-After 可延长当次等待。停止或卸载取消定时器和在途建联，不再恢复。

鉴权/权限错误、身份不匹配、服务端明确握手或断开拒绝、未知协议错误停止恢复。HTTP 状态保留为 IM_AUTH_HTTP_* / IM_REGISTER_HTTP_*，WS 拒绝保留数字原因 IM_CONNECT_REJECTED_* / IM_SERVER_DISCONNECTED_*；没有已确认的业务错误合同就不将任意 HTTP 409 或 reason 猜测成 Bot 占用。Provider、卡片、投递诊断走独立诊断通道，不污染连接 state/error，连接恢复也不代表旧任务已完成或旧回复已送达。

2026-10-16 的 im-test 专用 Bot 实测中，第二次注册和握手成功，旧连接收到 reason=12 并进入 failed / IM_SERVER_DISCONNECTED_12。该环境采用替换旧连接的行为，并非拒绝第二连接；插件不会为此自动反抢，不承诺跨机器排他锁。此样本不把 reason=12 的所有来源都解释为重复登录，详见[验收记录](../../.octospec/journal/shared/2026-10-16-channel-connection-state-machine-delivery.md)。

断线状态在传输层检测到异常后更新；心跳每 25 秒发送，90 秒无包后在心跳检查时终止连接。物理断网与状态变更之间可能存在检测延迟，合盖期间不承诺 JavaScript 定时器持续运行。状态机及测试矩阵见[开发计划](../../.octospec/tasks/channel-connection-state-machine/brief.md)。

凭据只用于连接，不进入模型输入或状态。会话和投递回执有界保存在内存中，不承诺跨进程恢复或 exactly-once。

卸载会取消正在建联、执行和投递的任务，并等待连接及任务清理结束。重复关闭等待同一次清理；任一资源清理失败仍尝试其他资源，最终向宿主返回 `EXTRA_DISPOSE_FAILED`，不能把它当作可忽略的配置错误后立即重载。
