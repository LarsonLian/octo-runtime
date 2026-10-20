---
type: Rule
title: 统一 InvokeInput 合同
description: 所有公共入口共用的输入、默认值和多模态字段。
tags: ["invoke","protocol","multimodal"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-invoke-input
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["apps/cli/**","packages/octo-runtime-executor-core/**","packages/octo-runtime-protocol/**","packages/octo-runtime-adapter-host/**","packages/octo-runtime-daemon/**","packages/octo-runtime-extra-*/**"]
  touches: ["invoke","protocol","multimodal"]
source: self
supersedes: []
---

# 统一 Invoke JSON 合同

原始 TS class 是本包的 `InvokeInput`，运行时用 `InvokeInput.check(value)` 校验。普通 JSON 对象满足结构类型即可，不要求 `new`。CLI playboard、SDK、AdapterHost、gateway、wecom、SSE 使用同一对象。示例不是字段全集。

只有 `inputs`、`contexts` 必填；其他字段可选。默认值在执行边界解析，不写回调用方对象。未知可选扩展忽略，已识别字段继续校验。Context=v3、Run schema_version=7、内部 Adapter protocolVersion=2 是三个独立合同；统一包装不机械修改版本。

AdapterHost.invoke、RpcClient.invoke 和 daemon SDK 共用 `invoke(input, environment)`。RPC 传输原输入，只有 Host 调用 prepareInvokeInput 解析执行默认值和内部请求；不得按入口或 native/canonical 模式另建执行准备路径。createInputInvoke 只选择同一源流视图，invokeFrames 也使用同一个 input/environment；旧三参数 HostInvoke/createHostInvoke、HostInvokeWireOptions 和模式序列化函数已删除。signal 留在 environment，RPC 映射为 cancel，服务端用自己的 AbortController 接回同一 Host 流程。实施与验收范围见[任务](../tasks/unify-invoke-transport/brief.md)。

这是通用单次执行合同，不是长期 IM Agent 管理接口。sessionId 标识会话，不决定 workdir；Provider 会话续接与目录选择分别按本轮输入及真实 Provider 约束处理。IM 固定工作目录、reset 和历史采集由 Channel 负责，不能推导为通用 Host 按 session 建目录或补业务背景。详见[责任边界](../guides/im-agent-invocation-boundary.md)。

提前取消必须在发送 RPC 或启动 Provider 前失败。执行中取消沿原 invocationId 发送；接纳期间服务端也持有同一 AbortController，不能因回执尚未送达而丢失取消。客户端停止消费或连接断开时执行既有取消和资源清理合同；源帧的回执、排序和终态校验继续有效。

## 完整顶层字段

| 字段 | 必填 / 默认 | 含义及内部映射 |
| --- | --- | --- |
| inputs | 必填 | 1–128 个有序 text/image part，对应 modelInputParts，图片字节不转成文本。 |
| contexts | 必填，items 可空 | 当前 Event 的 Context v3 快照，对应 context。业务项原值、保序传递；只补必要执行默认值，不补历史业务背景。 |
| sessionId | 省略时生成 | 业务会话 ID，对应 agentSessionId，不保证 Provider 恢复。 |
| protocol_mode | native | native HostFrame 或 canonical CanonicalEvent，是同次执行的输出视图。 |
| invocationId | 省略时生成 | 本次调用 ID及取消目标。 |
| runId | 省略时生成 | 本轮业务执行 ID，与 invocationId/sessionId 独立。 |
| sessionGeneration | 无推断默认 | 非负整数会话代次，阻止过期回写。 |
| providerEpoch | 无推断默认 | 非负整数 Provider 绑定代次。 |
| agentSource | OpenClaw 默认 preset，其余 provisioned | Agent 归属与执行配置解析模式。 |
| prompt | inputs 文本摘要 | 展示安全描述，可以与真实模型输入不同；图片占位只用于摘要。 |
| modelInput | inputs 文本摘要 | 需要显式保存时的精确纯文本模型输入，不以展示文本覆盖。 |
| workdir | Context workspace / 本机 cwd | Provider cwd；与已提交 fixed workspace 必须一致。preset 可由 Provider 管理 cwd，cwd 本身不是安全边界。 |
| controlInstructions | 当前 Context 控制项 | 可信会话指令，独立于业务上下文；入口必须认证和授权。 |
| approvalMode | Context approval_policy / ask | 审批模式；与 Context 已提交策略冲突时拒绝。 |
| agentConfig | 解析后的执行配置 | 完整 Provider 配置，见下文；显式 model/effort 必须与 Context 一致。 |
| runtimeLimits | 执行配置；run timeout 默认 120000ms | 完整时间预算和 enforcement，见下文。 |
| runMetadata | 无 | JSON 业务/诊断信息，如 event、actor、channel；不注入模型，不作为授权凭据。 |
| providerSession | 无 | Provider opaque 会话及其扩展字段，不从业务 sessionId 重建。 |
| continuityMode | 有 providerSession 为 continue，否则 fresh | fresh 禁止携带 providerSession；continue 必须携带。以真实恢复结果为准。 |
| freshFallbackModelInput | 无 | 调用方明确冻结的恢复文本，不从历史自动生成。 |
| freshFallbackModelInputParts | 无 | 调用方明确提交的恢复 text/image 数组，结构同 inputs。 |
| freshFallbackImagesUnavailable | 无 | 恢复图片字节不可得时明确阻止不完整 fresh fallback。 |

`signal` 不属于 JSON，通过 `invoke(input, {signal})` 的本地环境传入。CLI/HTTP 自行产生取消信号，body.signal 拒绝。内部 protocolVersion 固定为 2，其余原 InvokeRequest 字段均有上表映射。调用方的身份、权限、租约和 mandatory 约束仍在原边界校验。

## 多模态 Part

| 字段 | 含义 |
| --- | --- |
| id | 可选字符串，单个数组内唯一的 part ID。 |
| type | text 或 image。 |
| text | text 必填字符串，保留原文本。 |
| mimeType | image 必填：image/png、image/jpeg、image/webp。 |
| data | image 必填：原字节的规范 base64。 |
| byteSize | image 必填：解码字节数，必须与 data 一致。 |
| sha256 | image 必填：原字节 SHA-256，64 位小写十六进制，必须一致。 |

每组最多 4 张图片，单图最多 2 MiB，图片总字节最多 8 MiB。所有执行入口整体请求上限 32 MiB，按实际 UTF-8 JSON 计量，包含 Context、base64、显式恢复输入、可信执行环境和各跳包装；换行分隔符不计。等于上限接纳，超限在发送或 Provider 启动前以 INVOKE_REQUEST_TOO_LARGE 拒绝，不截断、不杀共享 Host。接收器有界丢弃异常超长行，未终止的故障传输有有限关闭期限。请求预算不扩大输出事件或源流窗口。Provider 不支持图片时明确报错。主输入和恢复输入显式提交相同图片属于业务选择，框架不自动去重，实际传输字节分别计费。实现与验证见[请求容量专项](../tasks/invoke-request-size-budget/brief.md)。

## Context

`schema` 固定 `octo.context-envelope/v3`，`items` 为有序数组，空数组有效。每项 namespace/name/payload 及权限、mandatory 等遵循 [Context 合同](context-input.md)。执行 adapter/model/workspace/limits/envs/审批项不渲染到模型业务上下文。业务项不按会话、轮数或 hash 补齐、去重、省略；跨 Event 重复提交的项每轮均发送。

## Provider 配置

agentConfig 的全部已定义字段：`workdir` 为 cwd；`model` 为模型 ID；`effort` 为推理强度；`sandbox` 为 Provider sandbox 标识；`providerAgentId` 为 Provider Agent ID（OpenClaw 缺省 main）；`timeoutSeconds` 为调用超时秒数；`openclawConfigPath` 为配置路径；`openclawStateDir` 为状态目录；`providerOptions` 为完整透传的 Provider 专属 JSON 参数。其他既有 Provider 扩展字段保留；已删除的 permission/thinking 旧字段继续拒绝。安装仍由 HostApp 决定。

runtimeLimits 的数值字段均为毫秒：`firstFrameTimeoutMs` 首帧等待、`modelIdleTimeoutMs` 模型空闲、`modelIdleWarningMs` 空闲告警、`toolTimeoutMs` 工具空闲、`toolWallTimeoutMs` 工具总时长、`runTimeoutMs` 整轮时长、`cancelGraceMs` 取消宽限。`modelIdlePolicy` 为模型空闲 observe/enforce；`enforcement` 为总体 observe/enforce。省略按执行配置及既有 Adapter 默认处理，类型和范围继续校验。

providerSession 的 `sessionId` 是 Provider 句柄；`resumable` 是可选布尔值；`resumeOutcome` 为 new/resumed/fresh_fallback/compacted，表示真实连续性结果；`resumeFallback` 为回退原因；`contextInputVariant` 为 primary/recovery，标识实际采用输入；其他 Provider 扩展字段原样保留。业务 sessionId 和 Provider sessionId 不可互换。

通用执行协议不包含渠道快照引用、采集游标或投影 hash。`contextSnapshot` 和 `ChannelContextSnapshotRef` 已删除，Core 不校验、读取或转发它们。业务自行保存所需材料并显式构造本轮 inputs / contexts；渠道接入层可维护自身业务数据，不要求通用 Runtime 提供快照恢复合同。

## 大小与完整性

TS class 声明更多可选字段不会自动扩大 JSON。只有实际填入的字段参与序列化。统一对象是字段重组，不裁剪已有数据，不要求反复填写派生默认值，也不复制原图片；主输入和显式恢复输入分别保留。`invocationInput` 将既有准备请求整理为这个结构，执行层统一解析回内部 Adapter 合同。
