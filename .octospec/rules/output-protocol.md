---
type: Rule
title: native 与 canonical 输出合同
description: 输出选择、原生帧、控制事实、交互与源窗口。
tags: ["protocol","native","canonical","stream"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-output-protocol
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-protocol/**","packages/octo-runtime-adapter-host/**", "packages/octo-runtime-executor-core/**","packages/octo-runtime-daemon/**","packages/octo-runtime-adapter-sdk/**","test/native-*","test/host-*"]
  touches: ["protocol","native","canonical","stream"]
source: self
supersedes: []
---

# native / canonical 输出合同

完整调用时序、各层回答接口及审批／追问往返见 [总体协议与调用设计](protocol-design.md)。本文维护输出模式、帧和源流规则。

公共输入见 [InvokeInput](invoke-input.md)。Run=7、Context=v3、Adapter transport=2 版本独立；本地默认 native，业务消费者显式选择 canonical。当前不提供 Worker 远端 native 接入。

## 1. 已实现的合同

显式 actmode 的执行事实通过 canonical `execution.update` 或 native control `{type:"evidence",name:"execution",payload}` 返回。`payload.actmode` 包含 requested、effective、status 和可选 nativeMode/reason：applied 必须与请求一致；fallback 仅用于已确认的不支持且 effective 为 default；unknown 的 effective 为 null、reason 为 provider_unconfirmed。认证、超时和执行错误不能伪装成不支持。省略 actmode 不制造执行事实或模式设置，也不建立产品模式记忆。首批接线及验证范围见[交付记录](../journal/shared/2026-10-16-actmode-first-three-delivery.md)。

| 合同                        | 内容与运行时入口                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `HostInvokeOptions`         | TypeScript 选择器；`resolveHostInvokeOptions` 仅在省略 `protocolMode` 时解析为 native，返回独立且冻结的结果                    |
| `InvokeInput.protocol_mode` | 公共输入中的模式选择；省略为 native。RPC 转发同一 InvokeInput，不恢复已删除的 HostInvokeWireOptions 或模式序列化 API。 |
| `AdapterProtocolSupport`    | 声明 `protocol`、`modes`、`nativeMethods`；`assertProtocolSupport` 拒绝不支持的模式或错误协议标识                              |
| `HostRunReceipt`            | 接纳身份：Run、invocation、stream、AgentSession、会话代次、有效模式与原生协议；不表达 Provider 完成                            |
| `HostFrame`                 | `NativeHostFrame / CanonicalHostFrame / ControlHostFrame` 判别联合；`assertHostFrame` 校验分类，禁止混装载荷                   |
| `HostControl`               | 独立的执行状态、Host 错误、pending 交互状态、上下文/会话证据和流缺口；`assertHostControl` 校验语义                             |
| `NativeInteractionResponse` | 原生 `requestId` 与完整响应 `payload`；这里只校验形态，写回前仍须核对当前执行、权限和 Provider 方法                            |
| `RunProtocolErrorCode`      | 共享错误目录；Provider 原生错误保留在 native payload，不转为 Host 错误                                                         |

`protocolMode: undefined` 作为显式属性存在时属于非法输入；整个 options 参数省略时解析为 `{ protocolMode: "native" }`。
`null`、空字符串、错误拼写和额外的模式字段均拒绝。模式不进入 Context，不改变 Context hash。

帧身份使用序列化字段：`run_id`、`invocation_id`、`stream_id`、`agent_session_id`、
`session_generation`、`protocol_mode`、`protocol`。`seq` 是源流中从 1 开始的连续安全整数。
`assertHostFrameIdentity` 对照接纳回执核对全部身份字段；订阅不重新选择模式。

native 帧的 `messageKind` 为 `response / notification / request / message`。
`payload` 保留 Provider 对象中的 ID、错误 code/message/data、未知可选字段及协议结构。
校验函数不修改对象，不增加 Provider JSON-RPC 字段，不从 canonical 重建 payload。
有效 JSON 及 Unicode scalar 字符串规则仍适用。

控制状态为 `running / completed / failed / cancelled / lost`。
容量错误控制帧可携带由中央 failure 机制创建的可选 `failure`，保留公开码、诊断编号、时间和安全测量；
`params` 仅接受 `boundary / measuredBytes / limitBytes / itemCount / limitItems` 白名单。
canonical 视图将该事实及测量透传到异常，不把 Host 投递失败伪造为 Provider 的 `run.failed` 或成功结果。
无 `failure` 的既有错误控制帧仍有效；接收新增字段需同步更新 Schema、生成类型及运行时校验器。
`lost` 表达执行联系丢失，不能作为成功依据。`isHostTerminal` 只识别 Host 终态控制帧；
即使 native payload 含有 `result` 或 `completed`，公共层也不据此推断执行终态。
Codex Driver 依据当前 `turn/completed` 报告真实状态；Claude Driver 依据 `result` 报告状态。
Host 等待 Driver 清理完成后发布唯一终态；缺失终态、协议异常和清理失败均不能报告成功。

交互状态为 `pending / resolved / expired / invalidated`；pending 必须带 `expiresAt`。
Driver 维护唯一控制者，响应写入确认后才发布 resolved；重复 ID、在途重复响应、扩大授权
范围、过期及终态后响应均拒绝。full_access 自动处理只作用于本次请求；问题与 elicitation
仍通过 pending 请求响应。取消/丢失时 Driver 和 Host 使未完成的交互失效。

`gap` 携带 `requested_after_seq / oldest_seq / latest_seq`。
运行时要求确实存在缺口，且窗口下界不超过 `latest_seq + 1`；JSON Schema 只校验字段形态和数值范围。
所有序号、代次、数值请求 ID 与期限均要求 JavaScript 安全整数。

`canonicalEvents(frames)` 是新帧流的类型化消费函数。它校验事件、源身份和连续序号，
拒绝 native 帧，并将 Host 错误与 gap 抛给调用者。它不启动执行、不调用 Normalizer，
也不建立续流缓冲。读取已有窗口时，首帧可以从窗口内任意序号开始，后续帧必须连续。

## 2. 执行入口与消费者

Host 在唯一执行源内解析输入、校验执行模式和配置，冻结身份及输入；prepare 为私有实现，不再对外暴露两阶段调用。
RPC 从同一源的首个状态帧取得回执并 ACK，继续消费后才启动 Provider。
`invoke(input)` 默认返回 native 源帧；`invoke({ ...input, protocol_mode: "canonical" })` 返回 canonical 类型化视图。
`invokeFrames(input, environment)` 使用相同输入，返回完整源帧；`createInputInvoke` 只负责 native/canonical 输出视图，不解析执行配置。旧 HostInvoke/createHostInvoke 三参数合同已删除。Host、RPC、daemon SDK 不按消费者名字选择模式。
同一接纳身份改模式、改请求或重复执行均拒绝；恢复用已有源窗口订阅。

| 已接线的调用点                                              | 当前行为                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `adapter-host/src/rpc.ts`                                   | 接纳前拒绝不支持的选择；将 RPC ACK 与帧流绑定到同一执行     |
| `daemon/src/server.ts`、`adapter-host/src/host-run-service.ts` | 转发冻结模式，缓冲原帧，按 Host 控制事实维护终态            |
| `daemon/src/runtime/daemon-runtime.ts`、`run-stream.ts`      | 显式传递选择；续流继承回执模式；为 canonical 暴露类型化视图 |
| `extra-channel-*/src/execution/dispatcher.ts`               | 执行、final 文本与投递链路显式 canonical                    |
| Provider 内部 `adapter.invoke`                              | 仍为 Driver 与转换器的内部边界，不以旧签名推导 native 可用  |

Work App 等外部 HostApp 应在组合入口显式选择模式，并保持交互与回放一致；其当前接线和验收由各宿主仓库核对，不列为本仓已验证的实现。

Daemon 缓冲真实 HostFrame，保留原身份、模式、序号和载荷。默认窗口：每 Run 32 MiB / 4096 帧，
总计 128 MiB，TTL 120 秒，最多 128 Run、16 订阅、每页 32 帧；完整单帧上限 20 MiB。
受信 Adapter execution 配置可在中央硬最大值内覆盖容量；每次 invocation 冻结有效策略，
低预算运行不得借全局清理淘汰其他 Adapter 已保留的帧。
IPC 队列同样有上限，慢输出使用背压。重放不启动 Provider、不转换事件、不重复写响应。
Host RPC 与 daemon SDK 的 NDJSON 接收上限共用中央 HostFrame 硬最大值加 64 KiB 包装预算，
覆盖有界身份的 JSON 转义与重复字段；实际帧、队列和重放仍执行本 invocation 的有效策略。
SDK 在换行前逐段累计 UTF-8 字节，不用字符长度代替容量，也不反复扫描或拼接完整在途大行。
daemon SDK 在丢失 ACK 后通过 `agent_run.get` 查回已接纳身份，再订阅原 stream；已知缺口与
过期明确失败，不能重新 invoke。重启后旧 stream 不可恢复。

## 3. 原生支持范围

以下为当前代码声明范围，历史实测见 [验证摘要](../journal/shared/provider-validation-history.md)。

| Provider                | Driver 自动管理                                               | 客户端范围                                                | 明确拒绝                                                                |
| ----------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Codex app-server        | 初始化、thread 启动/恢复、唯一 turn 启动、中断与资源关闭      | 已声明的执行内通知/响应，以及当前 pending 请求的原生响应  | 客户端再次 `turn/start`、账户/全局配置/任意 thread 管理、未知客户端方法 |
| Claude Code stream-json | 命令构造、上下文与环境准备、stdin、原生行读取、结果观察与关闭 | 原生 stream-json 消息及当前 `can_use_tool` 控制请求的响应 | 第二次启动执行、账户/全局配置控制、不支持的控制请求                     |

Codex 现有交互方法清点：`item/commandExecution/requestApproval`、`execCommandApproval`、
`item/fileChange/requestApproval`、`applyPatchApproval`、`item/tool/requestUserInput`、
`mcpServer/elicitation/request`。现有代码对 `item/permissions/requestApproval` 明确拒绝，
native 也不得绕过该限制。未知服务端请求必须得到明确应答，不能悬挂。
Claude Code 当前范围依据现有 `can_use_tool` 桥；不能据此宣称已支持所有 Claude 控制方法。

其他 Adapter 通过 SDK 定义阶段明确声明 canonical-only；Host 注册阶段验证声明，
请求未声明的 native 模式在接纳前拒绝。清单中的 codebuddy、hermes、kimi-code、mcode、
opencode、openclaw、qodercli、qoderclicn、zcode-gui、antigravity 及通用 ACP 均为 canonical-only。
Codex 协议标识为 `codex.app-server`，Claude 为 `claude.stream-json`。
初始化和唯一 turn 启动由 Driver 完成。
native 日志只记录元数据、数量、字节和转换次数，不记录原生正文。


## 核对入口

[模式与帧校验](../../packages/octo-runtime-protocol/src/run-protocol.ts)、[统一输入解析](../../packages/octo-runtime-executor-core/src/invoke-input.ts)、[Core 接纳](../../packages/octo-runtime-executor-core/src/index.ts)、[源窗口](../../packages/octo-runtime-adapter-host/src/host-run-service.ts)、[native-host.test.js](../../test/native-host.test.js)。

同一接纳身份不得改变模式、改请求或重复执行。已识别身份、权限、代次、游标和交互范围继续严格校验；未知可选 Provider 字段保留不意味着可以绕过这些边界。
