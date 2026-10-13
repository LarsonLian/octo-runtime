# @mininglamp-oss/octo-harness-protocol

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

Octo Harness 的协议包：定义 Core、Adapter Host 与所有 provider 适配器共用的类型契约与运行时校验，包括 `InvokeRequest`、`CanonicalEvent`、`EventEnvelope`、provider 会话与 capability。它与具体 provider 及传输方式均无关。

新增 native / canonical 的模式、帧、接纳身份和交互响应合同，详见[实施记录](../../docs/27-native-canonical-protocol-contract.md)。当前只完成 Protocol 子包，运行入口尚未接入双模式；下文流程仍描述现有 canonical 执行。

## 定位与职责

各 provider 的原生事件格式差异很大。若缺少统一契约，会带来两个问题：其一，上层（UI、存储）被 provider 绑定，需为每家单独解析，更换 provider 即需重写；其二，适配器作为插件，一个格式错误的事件对象可能污染 Core 的状态。

本包提供一套 **provider 无关、传输无关** 的类型定义与 `assert*` 校验函数：规范一次调用的输入（`InvokeRequest`）、事件的形态（`CanonicalEvent`）、以及持久化时的封装（`EventEnvelope`），并在插件边界上进行运行时校验。

## 工作原理

同一条信息存在三个层次，越靠上越稳定。provider 的原生事件须先由适配器翻译为 `CanonicalEvent`，Core 在持久化前再封装为 `EventEnvelope`：

```mermaid
flowchart LR
    Native["provider 原生事件<br/>(codex thread.item / claude stream-json 等)"]
    Canonical["CanonicalEvent<br/>{ type, payload }"]
    Envelope["EventEnvelope<br/>+ id / seq / tsMs / agentSessionId / runId"]

    Native -->|适配器翻译| Canonical
    Canonical -->|Core: envelope()| Envelope
    Envelope -->|按 (runId, seq) 幂等追加| Store[(Store)]
```

关键约定：

1. **四个 ID 互不混淆**：Worker AgentSession ID、AgentRun ID、Harness invocation ID、Provider Session ID（Codex thread / Claude UUID 等）是独立标识。`seq` 仅在单个 run 内单调递增，消费方按 `(runId, seq)` 排序与去重。
2. **终态唯一**：一次 run 最终只能收敛为 `run.finished` / `run.error` / `run.stopped` 之一。
3. **会话凭证不透明**：Core 仅搬运 provider session，不解释其私有字段。
4. **`modelInput ?? prompt`**：发送给模型的文本与用于产品展示的文本可以不同，从而使“发送给模型的隐藏上下文”精确地只发送一次。
5. **编译期与运行时双重校验**：TypeScript 负责编译期，`assert*` 函数保护动态插件边界。

## 使用

```ts
import {
  assertCanonicalEvent,
  envelope,
  isTerminal,
  type CanonicalEvent
} from "@mininglamp-oss/octo-harness-protocol";

const event: CanonicalEvent = {
  type: "message.delta",
  payload: { channel: "final", text: "done" }
};

assertCanonicalEvent(event); // 边界校验
const stored = envelope({ id: "run-1", sessionId: "session-1" }, 1, event);
console.log(stored.seq, isTerminal(event));
```

以下两个细节属于正式契约，需特别注意：

- **工具输入是契约，而非 UI 推导字段**：完整输入位于 `tool_call.create.payload.args`；分片型 provider 先发送空 `args`，再按同一 `id` 发送多个 `tool_call.delta.argsDelta`，消费方须按顺序拼接 JSON 片段、完整后仅解析一次。`tool_call.update` 仅负责收尾，不能以其 output 反推输入。
- **消息 channel 表达用途，不表达 Provider 名称**：`analysis` 是推理类内容，必须继续经过 `exposure` 授权；`commentary` 是 Run 执行期间可公开的过程播报，可以进入进度卡但绝不能进入最终答案；`final` 是答案内容候选，只有 Run 收敛到 `run.finished` 后才允许作为最终正文交付。`message.update` 只结束一个 message item，不代表 Run 已结束。
- **`channel=analysis` 不等同于可公开**：仅当 `exposure` 明确为 `public_reasoning` / `public_summary` / `public_plan` 时方可进入公开展示；缺失、`unknown`、`private_reasoning` 一律视为不可公开——不应仅依据 `channel=analysis` 判断。
- **模型轮次与内容分离**：`model_step.started/finished` 描述一次 provider 模型轮次的边界；同轮的 message/tool 通过 `stepId` 关联。它用于过程时间轴和聚合，不替代最终 `channel=final` 正文。

## 协议真值：JSON Schema 与代码生成

数据结构类型并非手写，而是以 `schema/protocol.schema.json`（JSON Schema draft-07）为唯一真值自动生成：

```text
schema/protocol.schema.json → scripts/gen-types.mjs → src/generated/protocol-types.ts → src/index.ts 组合导出
```

- **自动生成**：各类可 JSON 序列化的结构体（`ProviderSession`、`AgentConfig`、`CanonicalEventPayload`、`InvokeRequestWire` 等）。
- **仍需手写**（非纯数据，代码生成无法表达）：运行时枚举常量（如 `CANONICAL_EVENT_TYPES`）、泛型 `CanonicalEvent<TType>`，以及带 `AbortSignal` 的 `InvokeRequest`（即 `InvokeRequestWire` 交叉一个 `signal`）。

修改协议的流程：

```bash
$EDITOR schema/protocol.schema.json   # 1. 修改 schema
pnpm gen                              # 2. 重新生成（build 前会自动执行）
pnpm build                            # 3. 构建
```

`src/generated/*` 带有“请勿手改”横幅，任何改动均须经由 schema。

## 约束与注意事项

- 本包不表达某个 provider 的完整私有协议；无法统一的字段应保留在适配器内，必要时置于可扩展的 payload 或 provider session 中。
- 选用 JSON Schema（而非 Protobuf/Thrift）的权衡，以及为将来 Go/Rust daemon 抽取类型的意义，见下方文档。

## Context 统一处理合同

内置 Context 各类型是否进入 LLM 提示词及目标通道，必须遵循 [Context v3 的 LLM 注入约束](../../docs/context-llm-injection.md)。执行参数不进入提示词；inline、references 和 extra 进入普通上下文块；已授权 control instructions 使用独立控制通道。固定格式内部使用 `指引: ...`、`数据: ...` 换行纯文本，不要求 XML。

运行合同固定采用 schema 7，选路快照为 `octo.runtime-selection/v2`，Context 信封固定为 `octo.context-envelope/v3`。Compiler/Catalog 版本与编译应用协议已删除。新增可选场景元数据不升级 Run/Context 版本；通过 candidates 或 explicit 声明设备意图，授权候选由 Worker 固定。

`CONTEXT_TYPE_CATALOG` 只记录已定义类型的 schema、持久性与可信通道。处理阶段和覆盖检查已删除。`renderModelContexts` 只按白名单 pattern 保序拼接，不执行目录覆盖或业务检查；全新 extra 不需要注册。

`ContextConfiguration` 包含 defaults 与 mandatory。使用 `assertContextConfiguration` 验证持久配置，再用 `resolveContextConfiguration(configuration, request)` 解析有效项。adapter/model/workspace/runtime/approval_policy 沿当前独立类型合并，limits 按字段覆盖。mandatory 检查原始请求，冲突必须拒绝；内部能力要求由可信执行计划提供。

随机目录声明仅使用 `{mode:"random"}`，不得携带 scope 或 path。Runtime 在 AgentSession 首次运行时创建目录，后续运行复用；不同 AgentSession 使用独立目录。实际路径由 Runtime 准备，不能以空 workdir 启动 Provider。

Skill、Plugin、MCP 和 Connector 由本地用户或原生 Runtime 安装与配置。`octo.resources` 及旧云端安装字段直接拒绝；执行计划不包含 `resources` 或 `mcp_servers`。Context 表达发起方选择的普通材料以及独立执行配置；不生成 continuity 或编译应用证据。

`ToolAuthorization` 只包含 `service_subject_id`、`allowed_tools` 与 `resource_refs`。独立授权接口返回 `IssuedToolAuthorization`，增加短期 `token`、`octo_space_id`、`namespace` 与 `expires_at`；不允许携带地址、命令或配置模板。凭据只能进入本地已配置的业务连接或宿主授权接收器，不能进入模型输入。

这些公开函数不执行 ACL 检查、签发凭据或下载资源。职责与验收见 [Event Context IPD-SE](../../../docs/event-context-rendering-ipd-se.md)；旧 Pipeline 文档只保留历史背景。

## 相关设计

- 事件生命周期与 JSON-RPC 映射：[Architecture](../../docs/01-architecture.md)
- 为何选用 JSON Schema：[Protocol Schema And Codegen](../../docs/10-protocol-schema-codegen.md)

## 模块责任边界

- 负责：定义和校验统一执行、事件与 Context 合同。
- 不负责：连接管理、provider 执行、业务状态。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
