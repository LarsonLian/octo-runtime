---
type: Task
title: Channel Gateway 的 Octo CLI 执行环境
description: 为 IM 触发的 Agent 执行提供当前 Bot 的 Octo CLI 身份与 API 地址。
tags: [channel, extra, envs, invoke]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与状态

本任务仅解决 channel-gateway 收到 IM WS 消息后，Agent 调用 `octo-cli` 使用哪个 Bot 身份及 API 地址的问题。已实现普通 Adapter 的独立执行覆盖、Host RPC 传递及 CLI OpenClaw dotenv 同步；下文保留设计与验收要求，实际验证结果见 [记录](../../journal/shared/2026-10-15-channel-octo-cli-design.md)。

gateway 已有 Bot 凭据与 `api_url`，无需 WS 发送者额外提供。普通子进程 Adapter 每轮使用所属连接的配置，覆盖设备上可能残留的 OCTO 环境变量；OpenClaw 通过 CLI 预先写入实例全局 `.env`，由人工重启 Gateway 后加载。依据 [octo-cli README](https://github.com/Mininglamp-OSS/octo-cli#quick-start)，工具读取 `OCTO_BOT_TOKEN` 与 `OCTO_API_BASE_URL`；测试环境的后者为 `https://im-test.deepminer.com.cn`，不带 `/api`。

桌面应用通过内部 IPC 调用时，Token 或委托身份由桌面业务决定，使用 Context `envs` 合理。本任务不修改桌面实现，不把渠道策略推广到其他 Extra。

## 改造前代码与变更范围

| 位置 | 改造前行为 | 改造要求 |
| --- | --- | --- |
| `transport/channel.ts` | credentials source 解析 Token，验证 Bot 与 Space，绑定 WS 回调 | 在已验证连接闭包内绑定工具环境，不重新从消息字段或全局环境取值 |
| `application/im-channel.ts` | 构造请求并调用共享 Host；记忆业务请求快照 | 在发起执行时独立传入工具环境，不存入 occurrence snapshot |
| `execution/dispatcher.ts` | 解析 Context 与执行默认值 | 保持现有 Context 行为，不把渠道凭据拼入 envs |
| Core、Host RPC 与 Adapter SDK | InvokeEnvironment 仅有 signal；Adapter 从 Context envs 合成环境 | 补齐按调用传递的内部覆盖路径，并在 Provider 环境构造处应用 |
| CLI 的 OpenClaw 来源解析与启动编排 | 已能保存并刷新本地 Home 来源；无工具 dotenv 同步 | 按当前渠道配置更新目标实例 `.env` 的两项，后写覆盖前写；不自动重启 Gateway |
| OpenClaw Gateway Adapter | 无每轮环境载体，非空 Context envs 明确拒绝 | 保留此合同；渠道两个工具变量走 CLI 预配置，不传入每轮覆盖 |

## 渠道合同

1. 普通子进程 Adapter 的 `OCTO_BOT_TOKEN` 使用当前连接已验证的实际 Token。OpenClaw CLI 预配置使用所处理渠道配置经现有凭据源解析的值，不要求等待 WS 消息；执行时的 Bot 身份校验仍保留。配置文件直接值、凭据文件及宿主 credentials source 继续由现有逻辑解析；不能只读 `config.bf_token` 而跳过其他来源。
2. `OCTO_API_BASE_URL` 从同一连接的 `api_url` 构造。使用 URL API 校验 http(s) 地址，拒绝凭据、query、fragment；规范化尾部斜杠后，只移除末尾完整 `/api` 路径段，不替换主机名或路径中间的 `api`。保留端口及其他路径前缀。例如 `https://im-test.deepminer.com.cn/api/` 得到 `https://im-test.deepminer.com.cn`。其他前缀是否能用于该部署须通过真实工具请求验证。
3. 两个变量均不允许空字符串，也不从设备环境补值。普通子进程 Adapter 应用渠道强制覆盖；OpenClaw 按下述 dotenv 加载规则生效。Context 已识别字段与 mandatory 规则仍先按既有合同校验；工具环境单独应用，不修改已校验的 Context 或声称它满足不同值的 mandatory。
4. 本任务只覆盖这两个变量，不新增 `OCTO_TOKEN`、`OCTO_SPACE_ID` 或统一身份选择逻辑。租户身份继续由 Bot 认证合同确定。
5. 普通子进程 Adapter 的覆盖顺序为设备继承环境、Context envs、gateway 工具环境。Adapter 的既有传输固定变量仍按原合同处理，但不得重新改写这两个 OCTO 变量。Codex 的原生 shell 环境与变量白名单也必须包含本次覆盖，不能只设置 app-server 启动环境。OpenClaw 的例外见专节。
6. 工具值不进入模型文本、Context hash、业务快照、控制指令、状态或可公开诊断。内部 IPC 必须传递必要值，但不得持久化或输出原始 RPC 凭据。OpenClaw CLI 可以按本方案将两个值持久化到目标 `.env`。错误及工具执行日志亦须使用现有脱敏边界，测试不得打印真实值。本设计不能阻止 Agent 主动读取或输出自身进程环境。

## 改造步骤

### 一、绑定连接的工具环境

普通子进程 Adapter 在 GatewayTransport 完成 Bot 身份校验后，由该连接闭包构造不可变的两项覆盖。向应用编排传递仅供执行使用的本地数据，不塞入 `buildContext`、`runMetadata` 或 `InvokeInput.contexts`。应用层在调用 Host 时取副本，禁止全局对象共享。OpenClaw 使用下述 CLI 预配置，不构造这两项按轮覆盖。

配置更新与重连沿用现有连接失效检查。旧连接尚未开始执行的消息在连接失效后拒绝执行；已开始的 Run 保留自己的原环境，不热替换凭据，也不将其重发为新 Run。重新收到消息按现有幂等与授权规则处理。

### 二、补齐必要的内部传递

本地 `InvokeEnvironment` 增加可选的 `executionEnvOverrides`，payload 为 `{ env_variables: [{ key, value }] }`。它与 signal 并列，不属于公共业务 JSON 或 Context。内部已准备请求和 Host RPC 使用同名字段承载；Schema 与生成类型同步。存在非空覆盖时使用 `invoke.with-environment` RPC，旧 Host 明确拒绝，不回退会忽略覆盖的普通 invoke。

这个字段只是实现本次工具环境所需的传递载体。Host/Adapter 不识别 Bot、IM 或变量名，不负责凭据获取。不得为此建立通用凭据代理、委托 Token 服务、插件配置扫描器或新的业务 Context renderer。

对已识别内部字段校验类型、变量名、字符串值、NUL、重复键与大小。复用现有环境条目的校验和预算规则，但独立计量，不占用或修改业务 Context 的预算。旧 Host 无法证明支持该覆盖时必须在本轮执行前拒绝，不依赖未知字段被忽略来继续执行；不新增 Runtime 云端能力准入门槛。

### 三、实际应用与会话复用

Adapter SDK 集中合成每轮环境；各 Provider 复用该结果，不能某条路径仍只读取 Context envs。覆盖必须同时到达 Provider 子进程、Codex 原生工具环境及依原生规则继承的本地子进程。远端 Provider 或 MCP 进程不因本机设置而自动获得变量。

Provider 会话或进程复用必须确保当前轮工具环境已更新；不能更新时新建适当执行进程或明确拒绝。不得为了记录凭据变化而向业务会话元数据写入 Token 或 Token hash。新连接的执行不得复用携带旧凭据且无法更新的进程。

### 四、OpenClaw 的 CLI dotenv 预配置

这一分支按用户决定使用实例共享环境。复用 CLI 探测 OpenClaw 的启动编排，在已加载渠道配置并定位目标实例后同步 dotenv；SDK、Adapter、probe、invoke 不增加隐式文件写入。当前 CLI 来源实现位于 `apps/daemon/src/openclaw.ts`，属于 CLI 组合逻辑，不因物理目录而把职责下移到 SDK。

1. 复用当前选定的 OpenClaw 来源，必要时用 `openclaw config file --json` 的结构化输出确认实际配置文件。命令使用与目标实例一致的 profile/环境，不调用 `config set`，不把 Token 放入命令行参数。目标路径按实例实际加载的全局 `.env` 确定：默认 `~/.openclaw/.env`，显式 state dir 则使用 `$OPENCLAW_STATE_DIR/.env`。配置文件同目录是通常布局，不能覆盖 state dir 的显式选择。仅有远端 URL 且没有本地目标时，不猜测或写入默认实例，报告无法同步。
2. 从当前渠道配置解析两个变量；API 地址遵循本方案的去 `/api` 规则。CLI 按配置中的 bots 数组顺序处理同一批次，后者覆盖前者。同一目标文件的更新串行；多次 CLI 操作以最后完成的原子写入为准。不同 OpenClaw 目录分别写入，不互相覆盖。
3. 只更新 `OCTO_BOT_TOKEN` 和 `OCTO_API_BASE_URL` 的有效定义，保留其他变量及注释。使用 dotenv 解析和正确序列化，避免追加重复键或执行 shell；以临时文件加原子替换保存，权限 `0600`。相同输入重复处理不增加内容。写入失败明确报告，不声称配置已同步。
4. CLI 只报告目标路径、写入结果以及需要人工重启，不输出值，不自动管理 Gateway 服务。文件缺失时创建 `.env`；目标实例目录必须已由来源解析确认，不初始化新的 OpenClaw Home。配置轮换后下次 CLI 同步更新文件，运行中 Gateway 保持原环境直至人工重启。卸载渠道不自动删除其他配置或清空整个 `.env`。
5. 同一文件后写覆盖前写意味着该 OpenClaw 实例的所有相关 Agent/工具共享最终身份。明确接受该语义，不增加多 Bot 冲突拒绝，也不承诺按轮身份隔离。两个 Bot 需要独立身份时可使用各自现有的 OpenClaw 目录；本任务不创建或重建实例。
6. 官方文档说明全局 `.env` 高于配置 `env`，但通常不覆盖 Gateway 进程已存在的同名值。因此 CLI 写入成功只表示文件已更新；人工重启后通过实际工具请求验证生效，父进程或服务存在旧值时由操作者调整，不由 CLI 改写服务配置。远端工具或 sandbox 环境也需按原生继承规则单独验证，不保证仅写文件就传遍所有执行后端。

官方依据：[Environment variables](https://docs.openclaw.ai/help/environment)、[config file](https://docs.openclaw.ai/cli/config)。OpenClaw 仍拒绝非空每轮 Context envs；本分支不改变其协议能力。普通 Adapter 的每轮隔离验收不适用于这个共享文件分支。

### 五、兼容与交付

未提供内部覆盖的调用保持原行为，包括桌面 IPC 与其他 Extra。Run=7、Context=v3、Adapter protocolVersion=2 不机械升级。新增内部执行字段、生成类型、RPC 调用方、消费端、脱敏逻辑及测试须一起更新；混用旧消费端时明确失败，不把覆盖静默丢弃当作兼容。

构建并重启受影响的 Runtime/AdapterHost；桌面内置 Runtime 使用新 SDK 时同步构建桌面应用并重启验证。若实施实际触及 Run/Context 共享协议，则按工程规则同步构建 Worker、Runtime、桌面并验证注册执行；本任务不预设需要修改 Worker 业务或部署数据库。

## 验收

| 场景 | 通过条件 |
| --- | --- |
| WS 普通消息，Context 为空或无 envs | 工具进程仍取得连接对应的两个值 |
| 设备及 Context 包含错误同名值 | 进程实际值为 gateway 强制值；Context 原值未改写，其他变量保留 |
| Token 直接配置、文件与 credentials source | 三条来源均使用实际验证值，缺失或验证失败时不执行 |
| URL 规范化 | 覆盖 `/api`、`/api/`、无后缀、端口、非末尾 api 及非法 URL |
| 普通 Adapter 两个 Bot 并发 | 各工具进程只取得自己连接的值，宿主 process.env 不变 |
| 重连、替换配置及排队消息 | 新轮使用新连接；失效连接待执行消息拒绝；在途轮不换凭据 |
| RPC 与真实 Provider | 覆盖跨实际子进程边界生效；Codex 工具环境及续聊不保留旧值 |
| 普通 Adapter 的旧消费端 | 明确拒绝，未执行，不静默忽略覆盖 |
| OpenClaw dotenv 路径 | 默认、自定义 Home/state dir/profile 均写实际加载位置；仅远端来源不误写本机 |
| OpenClaw 多配置与重复同步 | 同一文件后写覆盖前写，不同目录独立；其他变量及注释保留，无重复定义，文件权限正确 |
| OpenClaw 重启前后 | 写盘后明确提示人工重启；重启后实际工具请求使用最终值，若高优先级旧值仍存在则不能报告生效 |
| OpenClaw 每轮输入 | 不向调用传入那两项内部覆盖；显式非空 Context envs 仍按现有合同拒绝 |
| 模型与诊断隔离 | Token 不出现在模型输入、Context、业务快照、公开事件、日志或错误中 |
| 桌面与其他入口回归 | 不传内部覆盖时，已有 envs 与调用行为保持 |

实施时运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`，补充针对真实 Host RPC 与 fake Provider 子进程的测试。真实联调必须连接 `https://im-test.deepminer.com.cn/`，通过真实 IM WS 触发 Agent 调用只读 `octo-cli bot user-info`，核对当前 Bot 身份和实际目标地址；不得通过发消息验证工具身份。凭据只从本机受保护配置读取，验证记录只保存脱敏结果。涉及桌面真实接口时再按仓库规则进行 CDP 验证。

实现及实际检查结果持续记录在关联 journal；未完成的真实 WS 触发与 OpenClaw 人工重启验证不得用 mock 或写盘成功代替。
