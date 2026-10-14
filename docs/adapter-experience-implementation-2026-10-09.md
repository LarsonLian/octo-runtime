# Adapter 体验改造：实施与验收记录

日期：2026-10-09（Asia/Shanghai）。对应基线：`OCTO-ADAPTER-EXPERIENCE-BL-01`，[完整合同](adapter-experience-refactor-baseline.md)。

结论：核心生命周期、消息分段、活动选择、Worker 终态防护及前端过程入口已实现，并按问题分别提交。六个 Provider 完成真实工具任务和历史恢复检查。完整基线验收尚未完成：线上 Worker 路由、四个 Provider 的运行前置条件、逐路径原生证据及部分恢复场景仍有缺口。

## 1. 实施范围

本次不新增 CanonicalEvent／Presentation 公共事件、字段或版本，不加入旧版兼容分支。工作区已有的 AgentSource、executionFeatures、Run 公开投影 v3 等改动属于其他工作；本次没有将其混入修复提交。

| 修复 | 最终行为 | 主要证据 |
| --- | --- | --- |
| ACP／CodeBuddy 工具状态 | pending／in_progress 不再转成 failed；输出快照替换；终态保留工具身份；未知状态只记去敏诊断 | `adapter-tool-lifecycle`、`acp-tool-diagnostics` 测试 |
| Canonical 工具校验 | create 必须 running；update 只允许 completed／failed／cancelled | `tool-event-contract` 测试 |
| Host 消息与活动 | streaming 快照不结束活动；session／usage／空占位不结束 starting；model_step 不再自动代表 thinking | `message-snapshot-lifecycle`、`activity-progress` 测试 |
| Host 身份补全 | 匿名段按真实工具／轮次边界分开；全部通道按 step 收尾；占位不制造空消息 | `host-message-identity` 测试 |
| ACP／CodeBuddy 分段 | 共享 invocation 内轮次与消息段状态；工具后新思考使用新 ID；终态工具也形成边界；重复开始不重启工具 | `acp-message-segments` 测试 |
| Claude Code | 保留正文 content block 身份，partial 与整块输出各自去重、收尾 | `claude-message-segments` 测试 |
| OpenClaw | 保留 Gateway itemId；工具后 analysis 新段；滚动快照替换；preamble 保持 commentary；只有 token 进度时只表达状态 | `openclaw-message-segments` 测试与真实记录 |
| OpenCode | 保留 part ID；相同快照不追加，扩展快照只追加后缀；替换快照保持 streaming | `opencode-message-segments` 测试与真实记录 |
| ZCode GUI | 只收到 result／error 时直接保留终态工具，不补造 start；终态之后忽略重复开始 | `zcode-tool-lifecycle` 测试 |
| Worker | 根终态后迟到内容与活动不重启；允许迟到 usage；终态工具缺少 duration 时不虚构开始时间 | `terminal_lifecycle_test.go` |
| Work App | 运行中正文和工具按 firstSeq 排列；完成后显示“用时 · 执行过程”；复制仍只取最终回答 | 前端专项测试、真实 CDP |
| 启动诊断 | `OCTO_RUNTIME_DEBUG=1` 时将 Host 日志追加到 Octo Home | Host debug 日志测试 |

已有 Provider dispatch.written／output.first observation 与 adapter.invoke.started 日志继续使用。客户端验收时点来自 renderer 的 performance 时钟，仅作本机观测，不与服务器时间戳直接相减。新准备耗时日志已经过单测，尚未在重新启动后的真实 daemon 上采样，不能用它解释旧样本的具体启动耗时。

## 2. 提交记录

所有提交在各仓库现有 `main` 上完成，没有推送或部署。保留了工作区原有及并行修改。

| 仓库 | 提交 | 内容 |
| --- | --- | --- |
| Runtime | `7b2827a` | ACP／CodeBuddy 非终态工具映射 |
| Runtime | `8f58d88`、`ff0c6dd` | 工具状态校验及提交分支定位校正 |
| Runtime | `ec2cdcf` | streaming 消息活动生命周期 |
| Runtime | `989a9e5` | 真实进展驱动活动切换 |
| Runtime | `28e3e29`、`13de54a` | ACP／CodeBuddy 消息分段与终态工具边界 |
| Runtime | `be0f01a` | Claude 消息块身份 |
| Runtime | `16c0158` | OpenClaw 思考分段与原生身份 |
| Runtime | `552b259` | OpenCode 快照与消息身份 |
| Runtime | `ee9a818`、`4a85ecb`、`89abdaa` | Host 匿名身份及补全过程顺序 |
| Runtime | `47ce16d` | ZCode 终态工具 |
| Runtime | `1469b5a` | 准备与首个公开进展耗时 |
| Runtime | `a3f65f7` | 未知 ACP 工具状态去敏诊断 |
| Worker | `21b1d7e` | 根终态后拒绝重启活动 |
| Worker | `4e74c30` | 终态工具不虚构开始时间 |
| Work App | `59ca8a7` | 运行顺序及明确过程入口 |
| Work App | `d70b0fe` | 将陈旧流测试样例对齐已存在的 v3 合同 |
| Work App | `1380f35` | 指定引擎与 preset Agent 的真实联调脚本 |

隔离提交复查发现过仅新增行在脏工作区中的定位偏差，已用独立纠正提交修复。最终另外导出 Runtime 已提交版本，独立安装依赖、构建和跑全量测试；下表的 824 项结果来自该提交版本，不依赖并行工作区文件。

## 3. 自动化验证

| 验证对象 | 结果与边界 |
| --- | --- |
| Runtime 最终已提交源码快照 | 构建通过；824 项测试通过，4 项跳过，0 失败 |
| Runtime 联调工作区较早完整回归 | 831 项通过，4 项跳过；包含其他工作流未提交测试，不能与独立快照计数直接比较 |
| Worker | runprojection、runaggregation、service 三个 Go 包通过；两项新增行为尚未加载到实机运行的 Worker 进程 |
| Work App | tsc、build 通过；Vitest 1332 项通过，1 项跳过；工作区包含并行修改 |
| UI 专项 | 47 项通过；运行顺序、折叠、复制、失败、活动优先级覆盖 |
| UI 静态检查 | Impeccable detector 对改动界面文件返回 0 项问题 |

Work App 的 5 项旧流测试最初失败，原因是样例仍为 v2，而已提交客户端只接受 v3。`d70b0fe` 只更新测试样例与错误断言，没有修改公共协议。

## 4. 真实环境与 Provider 资格

实际链路：`https://im-test.deepminer.com.cn` 的 octo-auth 登录 + `http://127.0.0.1:8091/agentworker/api` 本地 Worker + 真实 Electron renderer（CDP 9222）+ 已安装 Provider。

Runtime：`runtime_4b5da7e3-3ec6-41e9-87cc-441df06add10`。Provider 的具体模型未在本轮证据中捕获；使用各自默认配置，因此下表不构成某个模型版本的资格认证。

统一任务：只运行 `sleep 3; printf <本次验收标记>`，确认工具输出后答复，不读写用户文件。Codex 样本使用 ask，并实际通过“允许一次”执行该指定命令；其他样本使用 full_access。OpenClaw 使用已有 preset Agent 的 `main`，其他成功路径使用 provisioned Agent。

| Provider | 发现版本 | 本轮结果 | 公开思考消息段／工具数 |
| --- | --- | --- | --- |
| Codex | 0.154.0 | 通过 | 0／1；该样本没有公开思考，不据此制造正文 |
| Claude Code | 2.1.293 | 通过 | 2／1 |
| CodeBuddy | 2.161.4 | 通过 | 1／1 |
| OpenClaw Gateway | 未由探测返回 | 指定 preset Agent 后通过；最初默认 Agent 的 UI 选路未进入执行 | 2／1；存在下文重复正文边界 |
| OpenCode | 1.18.30 | 通过 | 2／1 |
| Hermes ACP | 0.21.2 | 通过 | 2／1 |
| Kimi Code ACP | 未返回 | 失败；另行原生诊断返回模型网关 403／额度不足 | 0／0 |
| MCode ACP | 0.5.3 | 失败；工具完成后根执行失败；另行原生诊断返回模型网关额度不足 | 1／1，不能视为整轮通过 |
| Qoder CLI ACP | 1.1.63 | 失败；另行原生诊断要求认证 | 0／0 |
| Qoder CN ACP | 命令不存在 | 未执行 | 未验收 |
| ZCode GUI | 未返回 | 失败；原生 session/create 提示缺少显式模型配置 | 0／0 |

“通过”只表示本轮 CDP 用例通过：提交后有执行区域、真实 tool 投影、成功根终态和标记回答、完成折叠、明确入口、键盘展开、刷新后工具数量与答复一致、无残留 busy。所有成功样本记录中 renderer 异常与非取消网络失败为空。

各 Provider 的通道规则：Codex 保留原生 commentary／final；Claude、ACP、CodeBuddy、OpenCode、ZCode 未明确给出 commentary 的普通文本继续归 final；OpenClaw 将原生 preamble 归 commentary。不会依据“我将”等措辞改通道。OpenClaw 没有 itemId 的持续文本以及 ZCode 当前桥的粗粒度 step，不承诺细粒度模型轮次一致。ACP 完整参数替换不能用 argsDelta 无损表达，当前保留 create／terminal 已知参数，未新增快照字段。

## 5. 剩余差异与验收缺口

1. **线上 Worker 未验收。** 测试域名下 `/agentworker/api/v1/runtimes`、`/agentworker/api/v1/agent/list` 等 GET API 返回 HTTP 200 的前端 HTML，而不是 Worker JSON。需确认正确网关路由及部署版本；本地 Worker 结果不能替代线上结果。
2. **四个运行前置条件未满足。** Kimi／MCode 需要可用模型额度，Qoder 需要认证，ZCode 需要模型配置；Qoder CN 需要已安装命令。本轮没有替用户充值、登录或修改模型凭据。
3. **OpenClaw 存在双通道重复。** 真实流先给出普通 assistant item，随后又给出内容相同但 ID 不同的 preamble。当前分别忠实保留，完成后会看到重复说明；没有原生关联证据时不按文本相似度删除。此项意味着 OpenClaw 尚未达到完整逐段展示一致。
4. **四层资格证据不完整。** 已归档公开 Presentation 事件、真实 DOM 和单测原生 fixture；尚未为每个成功 Provider 保存同一次调用的完整去敏原生→CanonicalEvent→Presentation 对应链，因此 A15 仍为部分覆盖。
5. **切租户、断线恢复与取消联调未重做。** 既有相关自动化通过，本次六个成功用例验证的是刷新恢复，不等于断线重连与切租户真实验收。A17 未通过本轮实机资格认定。
6. **最新诊断与 Worker 防护需联合重启后复验。** 实机 daemon 在部分尾部修复前已启动；这些修复已在最终提交快照／Go 单测通过，未声称已在线生效。

A01—A09 的关键语义已有专项自动化覆盖；A10—A14 有专项测试和上述六条真实路径的部分覆盖；A15—A17 尚不能整体标为通过。本轮没有数值性能 SLA，也没有宣称 Provider 启动耗时已经降低。

## 6. 证据与复现

[脱敏证据目录](../../octo-work-app/docs/validation/adapter-experience-2026-10-09/) 包含按 Provider 保存的事件身份、通道、状态、相对时点、运行 ID 和检查结果，以及裁掉侧栏的执行区域截图。未归档 token、模型密钥或私有推理。`provider-blockers.json` 记录失败原因摘要，不包含网关额度详情或请求原文。

[真实联调脚本](../../octo-work-app/scripts/test-adapter-experience-e2e.mjs) 默认通过 UI 选择引擎。指定 `OCTO_ADAPTER_E2E_DIRECT_TYPE` 可通过现有 main bridge 提交；preset 路径同时指定已有 Agent ID。脚本的失败清理只取消自己创建且尚未取得终态的测试执行。

每次修复继续遵循：针对性测试 → 单独 commit → 受影响真实路径回归 → 更新资格记录。线上路由与 Provider 配置满足后，优先补齐第 5 节，而不是将当前“部分覆盖”直接改为“完成”。
