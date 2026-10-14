# native / canonical 实施记录与 Protocol 合同

2026-10-14 包边界更新：本地 SDK 已合入 daemon，embedded 独立包已删除。模式选择与源流合同不变；本地调用不要求 Worker 注册或在线。统一原则见 [Runtime 合同](runtime-local-and-online-contract.md)。下文原里程碑仍保留其当时验证范围。

每轮模型上下文由业务发起方决定，允许空值、当轮增量或显式重复。Host 只渲染本轮快照，不按 session 缓存或补齐背景；Compiler/Pipeline、预取和字段投影已删除。详见 [LLM 注入约束](context-llm-injection.md)。

日期：2026-10-13（Asia/Shanghai）。设计基线：`OCTO-RUN-DUAL-PROTOCOL-BL-01`。
依据：[IPD-SE 设计基线](../../docs/runtime-agentrun-native-canonical-ipd-se.md)。

## 1. 当前交付边界

WP-DP-01～05 的执行代码已接线：Protocol、SDK、Codex/Claude Driver、Host、RPC、
Daemon 本地 SDK、Work App 和 IM。公共 `invoke` 默认 native，
现有业务消费者显式 canonical；native 不创建或调用 Canonical Normalizer。
当前仓库已移除 Worker 接入包，不提供远端 native 执行入口。
本轮无数据库模型变更，不需要删库，也没有建立兼容、回退或双写路径。
代码及自动化测试与真实环境发布验收分开记录；未做的实机验证不记为通过。

Run `schema_version=7`、Context `octo.context-envelope/v3`、既有执行传输
`protocolVersion=2` 均保持各自版本。

## 2. 已实现的合同

| 合同                        | 内容与运行时入口                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `HostInvokeOptions`         | TypeScript 选择器；`resolveHostInvokeOptions` 仅在省略 `protocolMode` 时解析为 native，返回独立且冻结的结果                    |
| `HostInvokeWireOptions`     | 序列化字段为 `protocol_mode`；`serializeHostInvokeOptions` 总是发出明确模式，`resolveHostInvokeWireOptions` 校验接纳边界的输入 |
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

## 3. 执行入口与消费者

`AdapterHost.prepare` 校验请求、权限、模式和协议，冻结身份及输入，不启动 Provider。
RPC 在 prepare 和唯一执行声明成功后 ACK，再消费同一执行的源帧。
`invokeFrames(type, request, options)` 返回完整源帧；`invoke(type, request)` 默认返回 native
源帧，`invoke(type, request, { protocolMode: "canonical" })` 返回 canonical 类型化视图。
`createHostInvoke` 复用于 Host、RPC、Daemon 和 Embedded，不按消费者名字选择模式。
同一接纳身份改模式、改请求或重复执行均拒绝；恢复用已有源窗口订阅。

| 已接线的调用点                                              | 当前行为                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `adapter-host/src/rpc.ts`                                   | 接纳前拒绝不支持的选择；将 RPC ACK 与帧流绑定到同一执行     |
| `daemon/src/server.ts`、`adapter-host/src/host-run-service.ts` | 转发冻结模式，缓冲原帧，按 Host 控制事实维护终态            |
| `daemon/src/runtime/daemon-runtime.ts`、`run-stream.ts`      | 显式传递选择；续流继承回执模式；为 canonical 暴露类型化视图 |
| `extra-channel-*/src/execution/dispatcher.ts`               | 执行、final 文本与投递链路显式 canonical                    |
| Work App `src/main/agent-conversation-service.ts`           | 主对话、统一交互和回放保持 canonical                        |
| Work App `src/main/daemon-runtime-service.ts`、`index.ts`     | 代理传递明确选择，避免在通用 SDK 中按调用者名称选模式       |
| Provider 内部 `adapter.invoke`                              | 仍为 Driver 与转换器的内部边界，不以旧签名推导 native 可用  |

Daemon 缓冲真实 HostFrame，保留原身份、模式、序号和载荷。窗口：每 Run 4 MiB / 4096 帧，
总计 64 MiB，TTL 120 秒，最多 128 Run、16 订阅、每页 32 帧；单帧上限 256 KiB。
IPC 队列同样有上限，慢输出使用背压。重放不启动 Provider、不转换事件、不重复写响应。
Embedded 在丢失 ACK 后通过 `agent_run.get` 查回已接纳身份，再订阅原 stream；已知缺口与
过期明确失败，不能重新 invoke。重启后旧 stream 不可恢复。

## 4. 原生支持范围

以下为本轮代码支持范围，真实 Provider 验证状态见第 5 节。

| Provider                | Driver 自动管理                                               | 客户端范围                                                | 明确拒绝                                                                |
| ----------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Codex app-server        | 初始化、thread 启动/恢复、唯一 turn 启动、中断与资源关闭      | 已声明的执行内通知/响应，以及当前 pending 请求的原生响应  | 客户端再次 `turn/start`、账户/全局配置/任意 thread 管理、未知客户端方法 |
| Claude Code stream-json | 命令构造、上下文与环境准备、stdin、原生行读取、结果观察与关闭 | 原生 stream-json 消息及当前 `can_use_tool` 控制请求的响应 | 第二次启动执行、账户/全局配置控制、不支持的控制请求                     |

Codex 现有交互方法清点：`item/commandExecution/requestApproval`、`execCommandApproval`、
`item/fileChange/requestApproval`、`applyPatchApproval`、`item/tool/requestUserInput`、
`mcpServer/elicitation/request`。现有代码对 `item/permissions/requestApproval` 明确拒绝，
native 也不得绕过该限制。未知服务端请求必须得到明确应答，不能悬挂。
Claude Code 本轮范围依据现有 `can_use_tool` 桥；不能据此宣称已支持所有 Claude 控制方法。

其他 Adapter 通过 SDK 定义阶段明确声明 canonical-only；Host 注册阶段验证声明，
请求未声明的 native 模式在接纳前拒绝。清单中的 codebuddy、hermes、kimi-code、mcode、
opencode、openclaw、qodercli、qoderclicn、zcode-gui、antigravity 及通用 ACP 均为 canonical-only。
Codex 协议标识为 `codex.app-server`，Claude 为 `claude.stream-json`。
`examples/managed-turn.mjs` 可调用两个 Provider 的 native/canonical，在 pending 时接收
对应模式的 JSON 响应，并通过 SIGINT 取消；初始化和唯一 turn 启动由 Driver 完成。
native 日志只记录元数据、数量、字节和转换次数，
不记录原生正文。客户示例显式打印所选择的流。

## 5. 验证与未完成项

本节保留 2026-10-13 的执行证据，早于 Worker 接入移除和 Channel 拆包；其中的旧包名、测试数量和跨仓库结果不是当前工作树的重新验收结论。

新增 `schema/run-protocol-fixtures.json` 为同源样例。测试同时运行 JSON Schema 和运行时校验，
覆盖默认值、非法值、协议不匹配、原生字段保留、混装载荷、Provider 错误、Host 终态事实、
身份与代次漂移、序列缺口、pending 期限和 canonical 类型化消费。
`test/run-protocol.types.ts` 验证生成类型的判别分支不能混读两种载荷。

| 工作包/门点                             | 当前状态                                                              |
| --------------------------------------- | --------------------------------------------------------------------- |
| WP-DP-01                                | 模式、身份、帧、错误、交互合同、生成类型与样例已实现                  |
| WP-DP-02                                | SDK、双 Driver、Host 生命周期、原生响应与取消已实现                   |
| WP-DP-03                                | RPC/Daemon/Embedded 接线、帧缓存、重连与远端拒绝已实现                |
| WP-DP-04                                | Work App 和 IM 显式 canonical，业务不增加 Provider 分支               |
| WP-DP-05                                | 模式声明、示例、观测、构建和自动化回归已接线；发布验收待实测          |
| G1 / G2 / G3                            | 模块测试证据逐项记录；真实 Provider、重启与消费者联调不能由 mock 替代 |
| WP-DP-06 / G4                           | 未启用；远端 native 单独验收                                          |
| 真实双引擎 native/canonical 执行        | 四种组合完成；native 转换次数均为零                                   |
| Work App CDP                            | im-test 登录、Runtime 注册、真实执行、存储一致性和刷新回放通过        |
| IM 真实收发、真实审批交互、切 Space CDP | 未验收；不能用 fixture 或普通执行代替                                 |
| 数据库重建                              | 本轮不需要，无数据库变更                                              |

检查命令：

```sh
pnpm --filter @mininglamp-oss/octo-runtime-protocol build
pnpm exec tsc -p packages/octo-runtime-protocol/test/tsconfig.run-protocol.json
node --test packages/octo-runtime-protocol/test/*.test.js test/protocol.test.js
```

上次 Protocol 子包提交的 838 项通过/5 项跳过属于历史证据，不能作为本轮改造结果。
本轮新增 native 执行、原始错误、交互、取消、拒绝、续流和零转换用例。最终运行
`node --test --test-concurrency=4 test/*.test.js packages/octo-runtime-protocol/test/*.test.js`：
868 项，863 通过，5 跳过，0 失败；Runtime 全量构建及 Protocol 判别类型检查通过。
Worker `go test ./...` 与 `make build` 通过；OpenAPI 已同步生成。
Work App `pnpm build` 及对话、Embedded、认证、切 Space 守卫 36 项测试通过。
当时修改文件 ESLint 通过；全仓 lint 在旧 Context Builder 中有两处 `no-control-regex` 错误。该包现已删除，不将这份历史结果当作当前 lint 状态。

真实验证脚本：`scripts/verify-dual-protocol-live.mjs`，只输出验收元数据。
Codex CLI 0.154.0、Claude Code 2.1.293，均采用 provisioned / full_access：

| Provider / 模式  | Run ID                                 | 转换次数 | 帧数 | 结果      |
| ---------------- | -------------------------------------- | -------- | ---- | --------- |
| Codex native     | `b39726a2-006f-4f5f-ab89-6d5696e0104e` | 0        | 25   | completed |
| Codex canonical  | `0ed95ac3-e477-4b97-a699-7ab3d91f30df` | 22       | 24   | completed |
| Claude native    | `482a1f89-16b3-4f41-8d14-1bc5e3343a35` | 0        | 49   | completed |
| Claude canonical | `51f0ef7e-3bb9-491e-9496-b727215190a7` | 45       | 37   | completed |

Work App `scripts/verify-local-chat-live.mjs` 通过 CDP 驱动真实 renderer，确认
server 为 `https://im-test.deepminer.com.cn`、已登录且 cloudConnected=true。
Runtime 为 `runtime_73b443cb-29c0-4488-988d-ef7908d57f19`；
Run `run_50035d76-0854-4412-8209-74fd98097dad` 的 22 个 canonical 事件与 SQLite
存储逐项一致，重复提交不重复执行，刷新后历史答复可见，思考/同步状态已结束。
Worker、Work App、Embedded Host 和测试 IM daemon 已重启；Worker 就绪检查通过，
Work App CDP 9222 可用。进程重启不等于 IM 投递验收。

原始日志位于 `/tmp/octo-dual-*`，桌面截图为 `/tmp/octo-local-invoke-proof.png`。
本文记录的是自动化与上述真实执行证据；IM 入站到发送回执、两个引擎真实审批交互、
取消后的真实 Provider 清理和切 Space CDP 尚未验收，G3 发布门不记为完成。
