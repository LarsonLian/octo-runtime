# Octo Runtime CLI 使用指南

## 背景与适用场景

CLI 是独立 Runtime 的完整发行物，面向云端设备的定制接入、部署和运维。**默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力。** 使用方通过命令启动 daemon 和共享 AdapterHost，配置 Extra 并管理设备上的运行过程。

“默认包含”描述发行范围，不表示安装 CLI 后全部 Extra 自动启用，也不表示系统自启已经注册。Extra 按配置加载；原生服务及自启由下文的 `daemon install` 等命令管理。Adapter 所依赖的 Provider 软件、认证及外部服务仍须按实际使用范围准备，不能把“包含 Adapter”理解为已安装并配置对应 Provider。

**基于 Electron 或 Tauri 2 的桌面程序，严禁通过 CLI 接入 Runtime，必须使用 [SDK 原生接入指南](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md)。** 不得把 CLI 可执行程序、命令输出解析或 CLI 原生服务包装成桌面业务接口。SDK 管理的 daemon、Host、Provider 子进程属于 SDK 接入的执行方式。

本指南只描述 CLI 使用；诊断命令和 `playboard` 用于开发验证。需要在客户应用中管理生命周期、持续会话和交互答复时，使用 SDK。

命令依据为 2026-10-16 当前工作区源码，服务地址、Token、ID 和路径均须替换为实际配置。npm 安装以对应版本已发布到可访问的 registry 为前提。身份及生命周期边界见 [Runtime 本地存在与接入边界](.octospec/rules/runtime-lifecycle.md)。

## 1. 安装

环境要求：

- Node.js 24.x。
- **整仓源码开发必须使用 pnpm 11 或更高版本**，具体版本以根目录 `package.json` 的 `packageManager` 为准。仓库内部依赖使用 `workspace:*`，构建脚本也依赖 pnpm；不支持用 npm 或 Yarn 替代整仓依赖安装和构建。
- 安装已发布的 Runtime 发行包和工具包可以使用 npm；源码完成 pnpm 安装和构建后，也可以使用 `npm link` 创建全局命令。

安装已发布的工具包（建议安装，优化体验）：

```bash
npm install -g @mininglamp-oss/octo-cli
```

安装 Runtime 发行包，提供后续使用的 `octo-runtime` 命令：

```bash
npm install -g @mininglamp-oss/octo-runtime
octo-runtime --help
```

从源码运行时，在 `octo-runtime` 根目录先安装依赖并构建，再使用编译后的入口：

```bash
pnpm install
pnpm build
node apps/cli/dist/index.js --help

# 使用 npm link到全局
npm link
octo-runtime --help

# 使用取消全局链接
npm unlink -g @mininglamp-oss/octo-runtime


```

后续示例统一使用 `octo-runtime`，源码环境可替换为 `node apps/cli/dist/index.js`。

## 2. 可选配置目录：Home 和 profile

| 参数             | 说明                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `--home PATH`    | 可选，指定 daemon／channel 配置所在的 Home 目录；省略时 macOS/Linux 为 `~/.octo-runtime`，Windows 为 `%LOCALAPPDATA%\OctoRuntime` |
| `--profile NAME` | Runtime 配置名称，默认为 `default`                                                               |

`--home` 选择 CLI 配置与运行状态目录，不是 Provider 执行工作区，也不是必填参数。一个 Home 运行一个 daemon 和共享 AdapterHost，可以包含多个 profile，每个 profile 有独立 `runtime_id`。Extra 属于 Host；`<home>/extras` 是 CLI 唯一配置目录，`extraset` 和 `extraget` 不接受 `--profile`，不探测其他位置，不合并或回退。daemon 启停作用于整个 Home。SDK 宿主自行提供声明；目录选择原因见 [CLI 决策](.octospec/tasks/device-extra-directory/brief.md)。

下文需要显式选择目录或 profile 的 Bash/zsh 示例使用以下变量；使用默认目录时可省略整个 `--home` 参数：

```bash
HARNESS_HOME="$HOME/.octo-runtime"
HARNESS_PROFILE="default"
```

## 3. 首先启动 daemon 和 Host

按生命周期归属选择启动入口：

| 使用场景 | 启动入口 | 生命周期归属 |
| --- | --- | --- |
| CLI 前台运行 | `octo-runtime daemon run` | 当前命令持续运行，Ctrl+C 停止 |
| CLI 后台原生服务 | `octo-runtime daemon install` 后 `octo-runtime daemon start` | 系统服务管理器负责运行，使用 `daemon stop` 停止 |

当前 CLI 的前台入口是 `daemon run`，没有 `daemon start --foreground` 参数。桌面宿主的启动与回收方式见 [SDK 生命周期管理](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#15-在主进程启动和退出)。

先使用默认配置目录启动前台 daemon，由 daemon 管理共享 Host：

```bash
octo-runtime daemon run
```

需要指定配置目录时使用 `octo-runtime --home "$HARNESS_HOME" daemon run`。Ctrl+C 退出前台进程；`--quiet` 关闭终端状态输出，`--verbose` 输出更详细的运行诊断。

需要原生服务运维时使用以下命令：

```bash
# 注册为当前用户的原生服务 用于开机自启，
# 开机自启由 @cross-service使用, 仅该包的cli使用
# 宿主APP接入需要基于packages原生接入，daemon的生命周期由 宿主APP来原生接管
octo-runtime daemon install

# 通过系统服务管理器后台启动本地服务,常驻后台启动
octo-runtime daemon start

# 查询、重启、停止
octo-runtime daemon status
octo-runtime daemon restart

# 通过系统服务管理器后台启动本地服务,停止后台服务
octo-runtime daemon stop

# 停止并移除原生服务定义，保留 Home 内的数据和凭据
octo-runtime daemon uninstall
```

原生服务对应 macOS LaunchAgent、Linux systemd user service、Windows 当前用户 Task Scheduler。`daemon install` 默认启用登录自启；`daemon start` 要求服务已经安装且启用。

`stop`、`restart` 和 `uninstall` 直接停止本地服务，不等待活动 Run 完成。




## 4. 接入 Octo IM

### 4.1 Codex / Claude Code（CC）类型

以 Codex 为例，替换 Bot ID、Token、服务地址和工作目录后执行：

```bash
octo-runtime extraset channel-gateway <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-gateway",
  "config": {
    "bots": [
      {
        "api_url": "https://im-test.deepminer.com.cn/api",
        "bot_id": "<BOT_ID>",
        "bot_name": "本地助理",
        "bf_token": "<BF_TOKEN>",
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/srv/octo/workspaces/dev",
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
                    "text": "我是明略科技的OctoClaw助理"
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

使用 Claude Code（CC）时，将 `adapter_type` 改为 `claude-code`，省略示例中的 Codex `model` 和 `effort`，使用 Claude Code 默认值。

### 4.2 OpenClaw 类型

已有 OpenClaw Agent 时，替换 Bot ID、Token 和服务地址后执行：

```bash
octo-runtime extraset channel-gateway <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-gateway",
  "config": {
    "bots": [
      {
        "api_url": "https://im-test.deepminer.com.cn/api",
        "bot_id": "<OPENCLAW_BOT_ID>",
        "bot_name": "OpenClaw 助理",
        "bf_token": "<OPENCLAW_BOT_BF_TOKEN>",
        "adapter": {
          "adapter_type": "openclaw",
          "provider_agent_id": "main"
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
                    "text": "我是明略科技的OctoClaw助理"
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

### 4.3 启动并查看状态

群/话题中未 @ Bot的讨论不会启动模型任务。再次被 @ 时，Gateway在模型调用前按真实消息位置固定通过现有API层补齐缺口，不依赖模型调用`octo-cli`或判断“总结”等关键词。已知小缺口按跨度、大缺口及未知基线最多最近15条，正文最多1500 Unicode码点；冷启动与缺口共用一次读取，不翻页，10秒超时，失败如实标记但继续当前任务。范围、去重、条数和文本上限由代码执行；同代次重试复用快照。`octo-cli`仍用于模型工具循环中的额外业务操作，与此固定准备流程分离；本地实现与线上验收边界见[Issue #32记录](.octospec/tasks/channel-context-gap/implementation.md)。

配置保存后，前台运行：

```bash
octo-runtime daemon run
```

已有前台进程时先 Ctrl+C 停止再启动。使用系统后台服务时，首次安装并启动：

```bash
octo-runtime daemon install
octo-runtime daemon start
```

后台服务已安装并启用时，修改配置后重启，再查看状态：

```bash
octo-runtime daemon restart
octo-runtime status
```

### 4.4 配置说明与多个 Bot

Bot 内的群配置分别表达入口启停和范围，CLI 与 SDK 完全相同：

| 字段和值 | 群/话题效果 | 私聊效果 |
| --- | --- | --- |
| groups_enabled 省略或 true | 开启入口，继续检查范围、授权和真实 @ | 不受此字段影响 |
| groups_enabled: false | 关闭全部群/话题，即使名单包含该群也拒绝 | 不受此字段影响 |
| group_ids 省略、null 或 [] | 不增加群范围限制 | 不受此字段影响 |
| group_ids: ["G1"] | 仅 G1 和其话题可继续检查其他条件 | 不受此字段影响 |

例如 owner 在 G1 中 @Bot：默认配置、group_ids: null 或 [] 均可触发；["G2"] 或 groups_enabled: false 拒绝群消息。话题按父群判断，回复仍发回原话题。groups_enabled 只接受布尔值，null 非法；group_ids 只接受 null 或非空字符串数组。

这些字段不放开发送者权限：allowed_sender_ids 省略仅允许服务端认证所得 owner；显式名单替代 owner，[] 拒绝所有发送者，null 非法。群消息仍需真实 @Bot，自身消息及错误 Space 仍拒绝。不保留旧 group_ids: [] 禁用群的语义，需要禁用时明确填写 groups_enabled: false。详见[准入合同与事故修复](.octospec/tasks/channel-group-admission/plan.md)。

`adapter.workdir` 可省略，默认使用并创建 `~/octo-runtime/channels/{bot_id}`，同一 Agent 后续执行复用此目录；显式填写时必须是绝对路径。该默认路径不随 CLI `--home` 改变。

`model`、`effort` 可省略，使用引擎默认值；`effort` 是思考强度。

`provider_agent_id` 是 OpenClaw 内部的 Agent ID，默认 `main`；不填写 `workdir`。建议显式填写 `bot_name`，使用该 Agent 的 `IDENTITY.md` 中的名称，方便管理员在本地运行状态中识别机器人。此字段不自动读取 `IDENTITY.md`，也不修改远端机器人名称。

OpenClaw 自动发现由 CLI 启动编排负责，默认读取 `~/.openclaw/openclaw.json`，首次可通过 `OPENCLAW_HOME` 指定目录。CLI 保存来源，每次 daemon 启动重新读取 URL/token 并保存连接快照，再认证探测；端口/token 轮换后重启即可。Adapter 的 probe/invoke 只读取快照，不自动发现或写文件。SDK 由宿主显式调用 `configureOpenClawConnection(profileRoot, {url, token})` 初始化连接与设备身份，或通过 `providerOptions` 传入 URL/token 及设备身份；详见 [OpenClaw 合同](.octospec/rules/openclaw.md)。工作区由 OpenClaw Agent 管理。

以上两个示例是同名插件的替代配置，依次执行时后者会覆盖前者。若两个 Bot 要同时启用，将两个 Bot 对象放进同一个 `config.bots` 数组，一次提交完整配置。配置只保存在对应插件的 `extras/<name>/config.json`，不提供渠道专用配置文件。

本节描述 CLI 的文件配置入口；通过 SDK 接入的 App 使用 [SDK 对象配置契约](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#22-加载和重载-extra)，不需要遵循这里的文件保存与加载约定。

使用 `octo-runtime extraset <name>`，从 stdin 提交完整的 `{ module, enabled?, config }` JSON 对象。Octo IM 使用 `channel-gateway` 插件，其配置为 `config.bots` 数组，可包含多个 Bot；插件级和 Bot 级的 `enabled` 均默认 `true`。

三个内置 Extra 均采用两阶段入口，CLI 传空函数依赖。上面的 Octo IM 示例在每个 Bot 的 `context` 中显式配置默认人设“我是明略科技的OctoClaw助理”，使用 `octo.context-envelope/v3` 的 `octo.control/instructions` 和仅含 `text` 的 entries 列表。Gateway/WeCom 的静态 Context 位于 `config.bots[i].context`，WebUI 位于 `config.context`；省略或空列表不自动填充，旧 source 字段不再接受。企业微信和 WebUI 的完整 JSON 分别见[WeCom 配置](packages/octo-runtime-extra-channel-wecom/README.md)与[WebUI 配置](packages/octo-runtime-extra-webui/README.md)。业务动态函数不能通过 CLI JSON 传递；需要逐轮读取宿主数据时，使用 [SDK 的函数装配入口](SDK_CHANNEL_GATEWAY_GUIDE.md#7-逐轮加载-agent-系统提示词与业务-context)。

CLI 将完整对象保存到 `<home>/extras/<name>/config.json`，POSIX 文件权限为 `0600`，不回显配置或凭据。**每次保存整体替换同名插件配置，不按 `bot_id` 合并。** 增删或修改 Bot 时，提交需要保留的完整 `config.bots` 数组。不同名称的 Extra 配置互不覆盖。

单个与多个 Bot 使用相同格式：一个 Bot 为 `config.bots: [botA]`，多个为 `config.bots: [botA, botB]`。若上次保存 `[botA, botB]`，本次提交 `[botB]`，最终配置只保留 botB；提交 `[]` 表示不保留任何 Bot。整个声明中的其他字段也随本次提交覆盖，不从上次配置补齐。

`module` 指向宿主已安装的插件包或绝对入口路径；`extraset` 只保存配置，不安装插件、不建立连接。通用入口校验声明格式，插件在加载时校验自己的 `config`。业务配置错误由插件跳过受影响项并在内部状态中报告，有效项继续初始化；不把某个 Bot 的配置错误扩大为整个 Extra 加载失败。CLI 前台启动和显式加载会输出插件状态，SDK 宿主通过 `extraStatus(name)` 自行展示。

标准 npm CLI 已随包携带 Octo IM 插件，无需单独安装。内部宿主从源码构建并手动拷贝所需插件及其生产依赖，或使用相邻源码仓库的编译入口；需确保插件对 daemon 的模块解析位置可见，也可将 `module` 填为已部署插件的绝对入口路径。内部插件不独立发布到 npm。

名称必须等于插件导出的稳定 `name`，否则加载返回 `EXTRA_NAME_MISMATCH`；第二个 Bot 应放进同一 `bots` 数组，不能改名为 `channel-gateway-2`。保存成功不表示插件加载或连接成功；CLI 通过 `octo-runtime status` 查询状态，前台运行时也会输出插件状态；SDK 的逐插件查询见 [Extra 装配](SDK_CHANNEL_GATEWAY_GUIDE.md#5-保存或重新加载-im-配置)。`loaded` 只表示初始化完成，不证明每个 Bot 已在线。插件加载失败会报告脱敏错误码，本地 Host 可继续使用。不要同时通过对象模块和 Extra 装配同名连接；daemon 会拒绝名称冲突。

修改配置通过 `extraset <name>` 保存完整声明，再执行 `daemon restart` 应用。持久停用保存顶层 `enabled: false` 后重启。CLI 不再提供 extra status/load/unload；SDK 宿主继续管理单插件生命周期。

## 5. 查询状态和执行记录 <测试开发用>

> 可在 `octo-runtime` 后、子命令前添加 `--home PATH` 和 `--profile NAME`，分别隔离配置目录和 Runtime 配置。

```bash
octo-runtime status
octo-runtime doctor
octo-runtime adapter list
octo-runtime adapter probe codex
```

`doctor` 检查 Node、Home 配置、原生服务程序/管理器/定义和本地 IPC，并提供失败项的修复建议。全部通过退出码为 0，否则为 1。它不验证 Bot 凭据、逐 Bot 连接或云端在线状态；前台运行未安装原生服务时，服务定义检查仍可能失败。

`agent-run get/cancel` 仅针对当前进程中的在途或有界保留 Run；不提供会话列表、永久历史或跨重启等待。历史记录由消费应用保存。

普通命令的 stdout 为 JSON，可能跨多行；错误输出到 stderr 并返回非零。接入程序应先检查退出码，再解析完整 stdout。`daemon run` 是长期运行进程，不使用一次性 JSON 请求的等待方式。

## 6. 本地唤起 Agent：playboard <测试开发用>

`playboard` 用于本地开发和调试：从 stdin 读取一个完整 JSON 对象，通过统一启动编排拉起临时 daemon，经本地 socket 执行一轮后退出并回收本次进程和状态。无需登录或预先启动 daemon，Provider 必须预先安装并完成认证。临时执行不加载已配置 Extra，不停止常驻实例，不销毁既有 Home/profile 或身份。

```bash
octo-runtime playboard <<'JSON'
{
  "inputs": [{ "type": "text", "text": "回复 OK，不使用工具。" }],
  "contexts": {
    "schema": "octo.context-envelope/v3",
    "items": [
      {
        "namespace": "octo.control",
        "name": "instructions",
        "payload": { "entries": [{ "text": "我是明略科技的Octo助理" }] }
      },
      {
        "namespace": "octo.execution",
        "name": "adapter",
        "payload": { "type": "codex" }
      }
    ]
  },
  "sessionId": "local-trial",
  "protocol_mode": "canonical"
}
JSON
```

| 字段              | 说明                                                 |
| ----------------- | ---------------------------------------------------- |
| `inputs`          | 必填，非空的模型输入列表                             |
| `contexts`        | 必填 Context v3；`items: []` 有效                    |
| `sessionId`       | 可选业务会话标识；重复此值不会自动恢复 Provider 历史 |
| `protocol_mode`   | `native` 为默认值；`canonical` 输出标准事件          |
| `providerSession` | 可选，使用实际返回的 Provider 绑定请求续聊           |
| `continuityMode`  | 有绑定时默认 `continue`，否则默认 `fresh`            |

默认执行配置为 codex、当前工作目录、审批 `ask`、超时 120000 毫秒。可在 `contexts.items` 中增加 workspace：

```json
{
  "namespace": "octo.execution",
  "name": "workspace",
  "payload": { "mode": "fixed", "path": "/absolute/workspace" }
}
```

stdout 为 NDJSON，native 模式每行一个 `HostFrame`，canonical 模式每行一个 `CanonicalEvent`。诊断写 stderr。退出码：0 完成，1 校验/启动/Provider/交互失败，130 取消或 Ctrl+C，143 SIGTERM。输入上限为 32 MiB，按包含图片和 Context 的完整 UTF-8 JSON 计算。

出现审批或问答时，playboard 输出交互 frame 后以 `PLAYBOARD_INTERACTION_REQUIRED` 失败，不继续接收答复。独立 App 的持续会话和交互使用 SDK。

OpenClaw 可先配置 profile 的连接，再通过 Context 指定已有 Agent：

```bash
# daemon 启动前设置 OPENCLAW_HOME，或由 SDK 宿主显式配置连接
octo-runtime --home "$HARNESS_HOME" --profile "$HARNESS_PROFILE" adapter probe openclaw
```

adapter payload 使用 `{ "type": "openclaw", "provider_agent_id": "main" }`。playboard 支持 `--home` / `--profile` 选择连接来源，由临时 daemon 的统一启动编排装配连接，playboard 不另做 OpenClaw 配置解析。启动 Octo daemon 不表示自动启动 OpenClaw Gateway；Gateway 必须已可访问。

完整命令参见 [CLI 使用说明](apps/cli/README.md)。
