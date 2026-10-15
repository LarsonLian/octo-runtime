---
type: Task
title: 现有 Adapter 的 actmode 与用户交互探索
description: 按产品意图归属验证 Context v3 的显式模式映射及问答往返，不在 Runtime 决定产品会话策略。
tags: [adapter, protocol, interaction, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 现有 Adapter 的 actmode 与用户交互探索

## 状态

首批 Codex、Claude Code 和 OpenCode ACP 已实现 Context v3 的显式 `octo.execution/actmode`，通过真实 Work App / im-test 执行与原始生效事件核对。Codex 显式 Plan 下的多题、选项与自由回答已回到原 Run。其余 adapter 仍为探索范围，未声明支持。构建、测试、版本、Run ID 及 OpenCode 重复续聊超时见[交付记录](../../journal/shared/2026-10-16-actmode-first-three-delivery.md)。

2026-10-16 用户再次纠正职责：本计划撤回“每轮强制应用模式、Plan 后省略必须恢复 default”以及 Runtime 选择新建/继承会话的建议。前一版五项建议包含产品策略越界，不能只补充异常处理后继续使用。正式依据为[强制架构原则](../../rules/architecture.md)、[工程范围检查](../../rules/engineering.md)及[纠偏记录](../../journal/shared/2026-10-16-product-intent-ownership.md)。

## 第一性原理与需求归属检查

| 检查 | 本需求结论 |
| --- | --- |
| 真实业务动作 | 桌面或自研 App 的用户选择模式、模型或思考强度，业务方将意图输入 Provider 执行链路 |
| 产品决定权 | 调用方决定是否提供 Plan、何时切换、模式默认值及会话新建/续接/继承/reset |
| Runtime 范畴 | 统一协议字段、合同内配置解析与校验、完整转发、adapter 原生映射、问答响应路由及真实结果返回 |
| 不属于 Runtime | 因省略字段擅自恢复模式、选择新会话、继承产品设置、开启实验能力、决定产品 UI 或替其他模块输入错误兜底 |
| 跨产品影响 | SDK 和 CLI 可供多个产品使用；不得把 Work App 或某个 Extra 的策略升级为通用默认 |
| 本次明确例外 | 已确认不支持可选 actmode 时允许降级 default，并报告实际处理；不扩大到网络故障、未知状态、权限或 mandatory |

IM Channel Gateway 当前产品决定始终普通/default，不配置或接入 Plan。本任务不向它增加 actmode 设置、选择器或逐轮重设逻辑。正式交互体验由 Work App 作为测试宿主，不能反过来用其体验要求决定所有接入方策略。

## 已确认的输入方向

继续使用 `schema: octo.context-envelope/v3`，Run 保持 `schema_version=7`。不新增信封版本，不引入第二套普通配置入口。以下 item 已实施：

```json
{
  "schema": "octo.context-envelope/v3",
  "items": [
    {
      "namespace": "octo.execution",
      "name": "actmode",
      "payload": {
        "mode": "plan"
      }
    }
  ]
}
```

- 初期 `mode` 定义为 `default | plan`，`default` 表示显式选择 Provider 的普通执行方式，不混淆为上一轮产品选择。
- 发起方将本轮意图保存于 Event 的 Context 快照。执行层沿用已有明确的 defaults / mandatory 规则解析校验；没有配置来源时，省略 actmode 不新造模式选择或模式重设操作。
- 业务方需要新会话默认、续聊继承或每轮固定模式时，由业务方决定并按协议表达。Runtime 不建立产品模式记忆，不自动读取历史 Event 补值，也不保证省略字段时 Provider 会恢复普通模式。
- actmode 与 `octo.execution/model` 内的 `payload.reasoning.effort`、`octo.security/approval_policy` 独立。Runtime 不将 Plan 转为产品权限策略，不修改现有 effort 的已授权映射合同。
- adapter 映射显式输入，负责原生载体差异，不替业务方选择切换时机；必要的技术性调用不改变会话绑定或其他用户意图。无法在现有会话应用时如实返回限制，不静默新建 session。
- execution item 不进入 LLM 文本，不从自然语言推断模式，不通过提示词模拟原生模式，不默认开启 Provider 实验开关。
- 问答沿用 `interaction.requested` 与结构化 answered/cancelled 回传；不自动追加用户聊天消息，也不把回答问题解释为切换模式或执行方案授权。
- 未识别可选 item 的消费者沿用忽略未知扩展合同，不新增 Runtime 能力准入门槛；未确认应用时不伪造已生效。已识别字段、身份、权限和 mandatory 仍须校验。

## 支持与降级边界

收到显式、合法的可选模式请求后，已确认 adapter 未接线或 Provider 不支持时，按用户授权降级 default，并报告请求值、实际处理和原因。选择器是否提供该能力由产品决定，Runtime 不代管 UI。

此降级仅处理能力不支持，不能兜底格式错误、认证失败、超时、断线或无法确定的原生响应。不支持不得从模糊错误文案猜测。mandatory 无法满足时按原合同失败；降级不放宽权限。若 default 也无法应用，返回真实失败，不伪造成功。

## 探索对象与初始证据

范围：CLI 默认集合的 12 个既有 adapter，另覆盖共享 ACP 桥；不纳入 MiMo 或新增 adapter。不隐式安装、改全局配置、清空身份或重建 Provider 状态。

| Adapter | 初始入口 | 待验证 |
| --- | --- | --- |
| codex | app-server collaborationMode、requestUserInput | 显式 default/plan 映射、应用证据与原生问答 |
| claude-code | 原生 plan、AskUserQuestion、权限参数 | 模式与授权如何同时表达；进入/退出原生 Plan 的事实 |
| zcode-gui | 产品有 Plan，当前 adapter 有 session mode 参数 | 当前 app-server 真实取值与问答载体 |
| codebuddy | ACP / CLI permission-mode | 实际原生模式入口，不用审批值猜模式 |
| hermes | 共享 ACP | 当前版本发布的 modes/configOptions 与交互 |
| kimi-code | 共享 ACP | 同上；区分权限回调和用户问题 |
| mcode | MiniMax Code，共享 ACP；不是 MiMo | 模式目录、设置与交互响应 |
| qodercli | 共享 ACP 与独立入口 | 版本、原生模式和回执 |
| qoderclicn | 独立入口 | 不复用 qodercli 未经验证的结论 |
| opencode | build/plan agent、自有传输 | 原生 agent 选择与 providerAgentId 的差异 |
| openclaw | Gateway / 本地执行 | 是否有同义原生入口，无证据记未知 |
| antigravity | 独立 adapter | 原生模式入口、限制与实际可用性 |
| 共享 ACP | v1 session/set_mode；v2 configOptions | 按真实握手版本映射，不统一硬编码一个 RPC |

表中为探索入口，不是全部支持声明。首批实现：Codex 使用 collaborationMode；CC 使用原生 permission-mode plan 及 system/init 回执；OpenCode 在既有 ACP 路径使用 configOptions，普通模式对应原生 build。生效信息走 canonical `execution.update` 或 native `evidence/execution`，不依赖模型自述。

## 原五项缺口的纠正与技术建议

| 项目 | 推荐与理由 | 明确不做 |
| --- | --- | --- |
| 生效结果返回 | 比较现有 notice 与结构化 control evidence，优先复用公共 control 路径返回适配事实；最终载体由现有输出合同核对决定。native/canonical 都不依赖模型自述或提示文案判断 | 不提前在接纳 receipt 声称生效，不因“完整体验”扩展产品模式状态管理 |
| 会话与省略 | 产品选择会话和模式策略；adapter 只应用本轮解析得到的显式意图，无法支持时返回限制 | 不在 Runtime 选新建/继承，不每轮强制恢复 default，不新增产品设置缓存 |
| 降级 | 仅对明确的不支持按本项授权降级 default，其他错误如实返回；理由是忠实执行例外合同 | 不捕获所有异常后改成普通执行，不重试或重建会话补救产品意图 |
| 权限组合 | 模式、effort、权限独立，adapter 对显式组合做原生映射与校验，无法同时满足则返回冲突 | 不代用户选择更宽权限，不把 Plan 当权限授权，不新增组合模式枚举 |
| 验收 | 公共链路先行，真实验证 Codex、CC 与一个已安装可用 ACP Provider，再记录其余差异；用至少两个产品输入策略的测试证明互不影响 | 不让所有产品遵守 Work App 的默认，不将 IM Gateway 拉进 Plan 测试，不把未测记通过 |

这些建议只涉及执行合同。产品仍可自行选择每轮新 session、显式设置或沿用其自己的偏好，Runtime 不替产品评选哪一种体验更好。执行层已有资源互斥、身份和调用冲突保护仍有效，但不能借技术保护新增产品模式策略。

## 工作阶段

### E1：版本与能力证据

- [x] 固定已有 adapters 范围、Context v3 / Run 7、actmode 命名与产品意图归属。
- [x] 初步核对 Codex、Claude Code、ZCode、OpenCode 和 ACP 资料；不将文档能力等同于本机支持。
- [ ] 记录实际安装版本、原生发现结果、显式参数作用域和当前接线；缺认证/工具标未测，不隐式安装。

### E2：合同与端到端传递

- [x] 新增 item Schema、语义校验、生成类型、样例及已有 defaults / mandatory 接入；不增加业务默认策略。
- [x] 首批三家经 SDK/Host 与 Work App 内置 daemon 执行，证明显式输入映射；模拟调用确认省略不产生额外设置。
- [x] 核对 native/canonical 的适配结果载体；`execution.update` / `evidence/execution` 区分 applied、fallback、unknown，未知实际值为 null。
- [ ] 核对模式与权限/effort 共用原生字段时的映射冲突；无法满足返回限制，不替业务决定取舍。
- [ ] 核对 question/options/自由输入/多题/isSecret/期限/取消的原生与 canonical 保真。

### E3：宿主与真实 Provider 验收

真实接口使用 im-test 和 octo-auth；记录版本、显式输入、原生设置、回包、交互及 Run ID，不记录凭据。

| 用例 | 验收 |
| --- | --- |
| 省略 actmode、无配置值 | 没有 Runtime 自动设置/重置；原生表现如实记录，不将其定义为跨产品体验保证 |
| 显式 default / plan | 对应统一意图进入原生参数；请求、处理及证据可追踪 |
| 两个产品策略 | A 产品每轮显式选定；B 产品按自己的规则决定省略或传值，彼此不影响 |
| 同 session 显式切换、resume、新 session | 由测试宿主明确选择，Runtime 执行输入或返回限制，不自行替换会话 |
| 不支持 / mandatory / 非法字段 / 原生故障 | 仅可选不支持按合同降级；其他错误真实报告，不补造模式或权限 |
| 选择 + 自由输入 / 多问题 | 改选和文字完整回到原 Run，提交前不提前回答，不增加一条新 user 消息 |
| 自由输入限制 / 取消 / 过期 / 断线 | 按真实原生能力和交互合同处理，不假造支持或永久悬挂 |
| Plan 输出与工具进度 | 不把 plan.updated、模型自述或方案文本当作原生模式生效证据 |
| 旧消费者 | 可选 item 未应用如实记录，不显示已生效；不因新可选信息断开 Runtime |
| IM Channel Gateway 回归 | 保持既有普通执行输入，不增加 Plan 配置或模式重设逻辑 |

### E4：交付与范围复查

- [ ] 按 adapter 交付支持/未接线/不支持/未知及真实验证矩阵。
- [ ] 再次执行架构范围检查，逐项删除未经授权的默认、继承、重试、自动模式与会话操作。
- [ ] 如进入协议实施，同步生成合同、构建受影响 Worker/Harness/桌面并重启本地进程；真实验证内置注册与执行、CDP renderer。无协议代码改动时不为文档更新部署服务。
- [ ] 不改变 Runtime 身份、Home、profile、Provider 全局配置或安装状态，不迁移/重建数据库。

## 历史实验与评分修正

2026-10-16 Codex CLI 0.154.0 的 Default 提问实验临时启用 default_mode_request_user_input。Run `run_4fb605ae-e14a-499f-ad9b-fda43a6ff218` 产生两题，选项与自由输入回到原 Run，completed 且 user 消息数仍为 1。无选项问题曾被该版本拒绝；这不是所有版本都要求选项的结论。

应用层 providerOptions.defaultModeRequestUserInput 和对应 adapter 实验映射已撤回，未修改全局配置。现已另行通过通用 Context 显式 Plan 验证问答，使用 `OCTO_QUESTION_ACTMODE=plan`；新截图及 Run ID 见相邻 Work App 验证目录。旧实验记录仍只代表历史事实。

撤回上一版 **82/100** 作为当前完整性结论：它把 Runtime 每轮模式管理当成需要完善的职责，评分前提错误。修正责任边界比补齐该越界方案更优先。后续评分只评统一输入、忠实传递、原生映射、事实返回、问答路由和已验证交付；不因未替产品管理会话而扣分，也不因增加文字而加分。真实实现尚未完成，本次不伪造新的验收分数。

## 官方资料

初读日期 2026-10-16，实施时绑定实际 Provider 版本，本次职责纠偏未重新验证远端资料。

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code 权限与 Plan](https://code.claude.com/docs/zh-CN/agent-sdk/permissions)
- [ZCode Agent](https://zcode.z.ai/en/docs/agents)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [ACP v1 session modes](https://agentclientprotocol.com/protocol/v1/session-modes)
- [ACP v2 migration](https://agentclientprotocol.com/protocol/v2/migration)
