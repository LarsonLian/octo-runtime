# native / canonical 实施记录与 Protocol 合同

日期：2026-10-13（Asia/Shanghai）。设计基线：`OCTO-RUN-DUAL-PROTOCOL-BL-01`。
依据：[IPD-SE 设计基线](../../docs/runtime-agentrun-native-canonical-ipd-se.md)。

## 1. 当前交付边界

本轮实现 WP-DP-01 的 Protocol 子包：JSON Schema、生成 TypeScript、模式解析、
序列化、支持范围校验、帧与交互响应校验、canonical 类型化视图和共享 fixtures。

**AdapterHost、Provider Driver、Daemon、Embedded 和消费者尚未接入新合同。**
当前运行入口仍输出既有 canonical 事件，不能用本轮的合同测试证明默认 native 已上线。
本轮没有修改数据库、聊天历史或进程管理配置，也没有建立兼容、回退或双写路径。

Run `schema_version=7`、Context `octo.context-envelope/v3`、既有执行传输
`protocolVersion=2` 均保持各自版本。新增类型不代表执行入口已经支持对应模式。

## 2. 已实现的合同

| 合同                        | 内容与运行时入口                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `HostInvokeOptions`         | TypeScript 选择器；`resolveHostInvokeOptions` 仅在省略 `protocolMode` 时解析为 native，返回独立且冻结的结果                    |
| `HostInvokeWireOptions`     | 序列化字段为 `protocol_mode`；`serializeHostInvokeOptions` 总是发出明确模式，`resolveHostInvokeWireOptions` 校验接纳边界的输入 |
| `AdapterProtocolSupport`    | 声明 `protocol`、`modes`、`nativeMethods`；`assertProtocolSupport` 拒绝不支持的模式或错误协议标识                              |
| `HostRunReceipt`            | 接纳身份：Run、invocation、stream、AgentSession、会话代次、有效模式与原生协议；不表达 Provider 完成                            |
| `HostFrame`                 | `NativeHostFrame / CanonicalHostFrame / ControlHostFrame` 判别联合；`assertHostFrame` 校验分类，禁止混装载荷                   |
| `HostControl`               | 独立的执行状态、Host 错误、pending 交互状态和流缺口；`assertHostControl` 校验语义                                              |
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
`lost` 表达执行联系丢失，不能作为成功依据。`isHostTerminal` 只识别 Host 终态控制帧；
即使 native payload 含有 `result` 或 `completed`，公共层也不据此推断执行终态。
后续 Driver 必须报告原生协议的真实终态事实。

交互状态为 `pending / resolved / expired / invalidated`；pending 必须带 `expiresAt`。
Host 仍需维护唯一控制者、检查响应是否写回、使旧代次和终态后的请求失效。
这些执行行为尚未由本轮实现。

`gap` 携带 `requested_after_seq / oldest_seq / latest_seq`。
运行时要求确实存在缺口，且窗口下界不超过 `latest_seq + 1`；JSON Schema 只校验字段形态和数值范围。
所有序号、代次、数值请求 ID 与期限均要求 JavaScript 安全整数。

`canonicalEvents(frames)` 是新帧流的类型化消费函数。它校验事件、源身份和连续序号，
拒绝 native 帧，并将 Host 错误与 gap 抛给调用者。它不启动执行、不调用 Normalizer，
也不建立续流缓冲。读取已有窗口时，首帧可以从窗口内任意序号开始，后续帧必须连续。

## 3. 待接线的唯一执行入口

下一工作包将现有 `AdapterHost.invoke` / `AdapterHostRpc.invoke` 接入
`HostInvokeOptions` 与 `HostFrame`。其接纳顺序必须为：校验执行请求和权限 →
解析并冻结模式 → 核对 Adapter 支持范围与协议标识 → 接纳身份 → ACK → 启动 Driver。

本轮没有新增第二个 Host 或 Provider 执行器。现有 `invoke` 方法尚未接受上述 options，
因此目前不要向运行入口传入新参数并期待 native 输出。

| 已清点的调用点                                              | 接线要求                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `adapter-host/src/rpc.ts`                                   | 接纳前拒绝不支持的选择；将 RPC ACK 与帧流绑定到同一执行     |
| `daemon/src/server.ts`、`host-run-service.ts`               | 转发冻结模式，缓冲原帧，按 Host 控制事实维护终态            |
| `embedded/src/embedded-harness.ts`、`run-stream.ts`         | 显式传递选择；续流继承回执模式；为 canonical 暴露类型化视图 |
| `core/src/engine.ts`                                        | 现有事件调度显式选择 canonical                              |
| `worker-access/src/agent-work-runtime.ts`                   | 现有远端消费显式 canonical；远端 native 在接纳边界拒绝      |
| `channel-im/src/index.ts`                                   | 执行、final 文本与投递链路显式 canonical                    |
| Work App `src/main/agent-conversation-service.ts`           | 主对话、统一交互和回放保持 canonical                        |
| Work App `src/main/embedded-harness-service.ts`、`index.ts` | 代理传递明确选择，避免在通用 SDK 中按调用者名称选模式       |
| Provider 内部 `adapter.invoke`                              | 仍为 Driver 与转换器的内部边界，不以旧签名推导 native 可用  |

## 4. 原生范围的接线约束

下表是 WP-DP-02 的范围，不是已发布能力。具体 Provider 输入参数和响应权限校验仍需在 Driver 中落实。

| Provider                | Driver 自动管理                                               | 客户端范围                                                | 明确拒绝                                                                |
| ----------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Codex app-server        | 初始化、thread 启动/恢复、唯一 turn 启动、中断与资源关闭      | 已声明的执行内通知/响应，以及当前 pending 请求的原生响应  | 客户端再次 `turn/start`、账户/全局配置/任意 thread 管理、未知客户端方法 |
| Claude Code stream-json | 命令构造、上下文与环境准备、stdin、原生行读取、结果观察与关闭 | 原生 stream-json 消息及当前 `can_use_tool` 控制请求的响应 | 第二次启动执行、账户/全局配置控制、不支持的控制请求                     |

Codex 现有交互方法清点：`item/commandExecution/requestApproval`、`execCommandApproval`、
`item/fileChange/requestApproval`、`applyPatchApproval`、`item/tool/requestUserInput`、
`mcpServer/elicitation/request`。现有代码对 `item/permissions/requestApproval` 明确拒绝，
native 也不得绕过该限制。未知服务端请求必须得到明确应答，不能悬挂。
Claude Code 本轮范围依据现有 `can_use_tool` 桥；不能据此宣称已支持所有 Claude 控制方法。

其他 Adapter 在 WP-DP-05 按实际原生出口声明模式。现有 canonical 能力不意味着 native 能力。
WP-DP-06 的远端 native 尚未启用。

## 5. 验证与未完成项

新增 `schema/run-protocol-fixtures.json` 为同源样例。测试同时运行 JSON Schema 和运行时校验，
覆盖默认值、非法值、协议不匹配、原生字段保留、混装载荷、Provider 错误、Host 终态事实、
身份与代次漂移、序列缺口、pending 期限和 canonical 类型化消费。
`test/run-protocol.types.ts` 验证生成类型的判别分支不能混读两种载荷。

| 工作包/门点                                 | 当前状态                                                |
| ------------------------------------------- | ------------------------------------------------------- |
| WP-DP-01 Protocol 子包                      | 已实现；新增 15 项行为测试、类型判别检查通过            |
| G1                                          | 尚未通过；Host 接线及 Driver 范围与控制行为仍需完成验证 |
| WP-DP-02～05 / G2～G3                       | 未完成；尚未交付本地双模式闭环及消费者切换              |
| WP-DP-06 / G4                               | 未启用；远端 native 单独验收                            |
| im-test、Work App CDP、真实双引擎执行及交互 | 未验证；不能用合同 fixture 代替实机证据                 |
| 数据库重建                                  | 本轮不需要，无数据库变更                                |

检查命令：

```sh
pnpm --filter @mininglamp-oss/octo-harness-protocol build
pnpm exec tsc -p packages/octo-harness-protocol/test/tsconfig.run-protocol.json
node --test packages/octo-harness-protocol/test/*.test.js test/protocol.test.js
```

验证结果：Protocol 相关行为测试合计 48 项通过；生成类型判别检查与新增模块 ESLint 通过。
Harness `pnpm test` 包含完整构建，838 项通过、5 项实机测试因未启用而跳过。
Worker `make build` 通过；Work App `pnpm build`（包含类型检查）通过。
本轮没有重启运行进程，也没有执行 im-test、CDP 或真实 native 调用。
运行链路改造后的重启与实机验收仍是 WP-DP-05 / G3 的未完成要求。
