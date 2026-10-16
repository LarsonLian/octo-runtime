---
type: Journal
title: 资源地址 Context 与 Harness 按需取材的架构决策
description: 文档、网盘及内部附件以地址和获取指引进入统一 Context，由执行中的 Agent 按需调用工具，区别于首轮原生媒体输入。
tags: [architecture, context, channel, ownership, resource]
timestamp: 2026-10-16T00:00:00Z
---

# 决定与状态

2026-10-16，在旧 Gateway F04 特性评审中，用户明确：文档、网盘文件和纯 file 附件都有自己的资源地址，差别主要在获取方式。这些资源应作为统一 Context 提供地址及获取指引，由 Harness 内的 Agent 根据任务决定是否和如何读取，不要求 Adapter 在执行前下载、解析或转换成原生附件。

本决定纳入当前架构约束。资源进入 Channel 的报文映射、指引装配和端到端取材验证尚未实施；本轮只更新规则、计划和决策记录，不改代码或协议 Schema，不发请求、不运行模型。替代 F04 此前将需求主要归为“新增原生 PDF/音视频输入”并建议不纳入的评估。

这里的 Harness 指 Provider/Harness 中 Agent 的模型推理与工具执行循环，不是 AdapterHost 额外增加一个资源抓取调度器。

## 两类输入

| 路径 | 业务意图 | 承载与执行 |
| --- | --- | --- |
| 首轮原生媒体输入 | 发起方明确要求模型本轮直接看到图片等原始内容 | 由业务方显式构造统一 inputs；Host/Adapter 按既有合同传递和原生适配。当前 IM 已定范围为 Codex 独立图片，本决定不扩大该范围 |
| 资源地址 Context | 资源是本轮可访问的材料，Agent 可根据任务选择读取、下载、分段查看或不读取 | 发起方提交类型、来源、名称/标识、地址和获取指引，IM 使用 extra.im。Agent 在正常工具循环中按需获取，结果作为真实工具输出进入执行 |

两条路径可由业务显式选择，也可在有明确意图时同时存在。发起方没有选择首轮原生输入时，Runtime 不因资源是 PDF、图片或视频就自动下载并转换。资源 Context 不要求预先把所有文件内容转成文本，也不要求 Adapter 增加一种原生输入类型才能成立。

## 职责

| 主体 | 决定或执行的内容 |
| --- | --- |
| 业务发起方 / Channel | 选择本轮资源及顺序，保留真实来源、资源标识和地址，提供与当前工具匹配的读取指引；处理本业务的准入和报文映射 |
| Provider/Harness 内的 Agent | 根据任务决定是否读取、用哪个已提供工具、读取哪些部分及如何处理结果；不要求每个资源都必须读取 |
| octo-cli / 下载与读取工具 / 服务端 | 按真实身份和权限获取资源，处理地址解析、签名、分页、下载、类型相关操作及失败；工具成功不等于所有内容均被模型理解 |
| Host / AdapterHost | 校验并转发显式 Context，使用现有固定 renderer，保持执行、审批、取消和预算合同；不理解文档/网盘业务，不预取、摘要或缓存业务材料 |
| Adapter | 负责普通 Context 渲染结果和工具交互的原生适配；仅在明确提交原生 inputs 时处理对应媒体映射。不管理资源目录、CLI 路由或附件获取策略 |
| HostApp | 决定工具、技能和 Runtime 的交付安装及使用范围；没有提供 octo-cli 或所需工具时返回真实不可用情况，不由 Extra/Adapter 隐式安装 |

“Agent 按需决定”不表示越过权限或审批。CLI 身份经现有独立执行环境传递，Bot Token、密钥和认证配置不进入 Context。资源地址本身也不授予其所不具备的访问权限。

## 资源类型与指引

资源类别与扩展名分别判断：一个 PDF 可能来自网盘或内部 file，获取入口由资源所属系统决定；在线文档地址也不能当作静态文件直接下载。业务方根据真实来源提供指引，不依赖 Adapter 解析 URL 或从扩展名猜测来源。

| 来源 | 指引方向 | 需区分的行为 |
| --- | --- | --- |
| Octo 在线文档 | 使用 octo-cli docs 命令族，按真实 doc_type 读取；本机说明中富文档正文入口为 `octo-cli docs content get <docId>` | docs get 元数据与正文不同；表格、白板、HTML 等按各自命令读取，不把所有在线文档当成可下载 blob |
| Octo 网盘 | 使用 octo-cli drive 查询资源或下载；本机说明中普通文件入口包括 `octo-cli drive file get <file-id>`、`octo-cli drive download file <file-id> -o <path>`，分享地址走对应 share 命令 | 网盘挂载文档仍需按文档真实类型取内容；网盘 space 和文档 space 不得混用 |
| 内部 file / 原始附件 | 按提供的可访问原始下载地址获取；需要解析 storage key 时，使用真实 file 工具入口 | 本机说明中的 `octo-cli file download <path>` 返回含临时 URL 的 JSON，不直接写原始字节；Agent 需按返回值完成下载，不能把 JSON 当附件正文 |

上表核对自本机 CLI 技能说明，不代表本轮已验证服务器部署、当前 Bot 权限或 Provider 工具环境。具体命令名、参数及 URL 到真实标识的映射须在接线时核对实际 CLI；用户口述的 doc 领域不机械写成不存在的单数 doc 命令。读取方法是业务 Context 的指引，不是 Host 要执行的命令注册表。

## Context 组织示例

复用 Context v3 的 guidance 和 payload；以下为表达方式草案及虚构数据，不新增通用资源类型、resolver 或字段白名单：

```json
{
  "schema": "octo.context-envelope/v3",
  "items": [{
    "namespace": "extra.im",
    "name": "resources",
    "guidance": "以下资源供本轮任务按需使用。网盘文件可用 octo-cli drive 查询或下载；在线文档按真实类型使用 octo-cli docs 等相应命令读取；内部附件按所附获取方式下载。是否读取及读取哪些部分由任务决定，读取失败时如实说明。",
    "payload": {
      "text": "资源 1\n来源：当前用户提供的网盘文件\n名称：需求说明.pdf\n文件标识：123456\n地址：https://example.invalid/drive/file/123456\n获取方式：使用 octo-cli drive 获取该文件，按需下载和读取。"
    }
  }]
}
```

具体 item 名称、指引措辞、资源数量和文本预算在 Channel 接线时定稿。名称、URL 和文件正文是外部材料，不因写入 guidance/payload 而升级为可信控制指令；指引必须反映宿主实际提供的工具。源地址缺失、来源不明或权限不足时保留真实状态，不补造地址、替换租户或把失败材料写成空正文后声称已读。

工具按任务下载到文件与 Runtime 新增业务 Context 持久库是不同动作。本决定不改变 Agent 固定 workdir、不创建逐 session 目录，不新增 Host 自动下载缓存、附件归档或后台读取流程。普通工具文件操作继续遵循实际工作目录、权限、取消和资源预算。

## 评价与后续验证

F04 重新定义为“资源地址 Context 与按需取材”：需求必要性 90/100、技术方案可执行性 90/100，目标覆盖 100% 的资源引用和获取指引业务。该比例不表示每种 PDF/音视频格式都保证能解析，也不表示所有文件都会读取；实际工具结果和限制按发生情况报告。原 20/40 分评价了另一项“扩展原生媒体输入”的需求，不沿用到本方案。

后续验证应覆盖文档、网盘普通文件/挂载文档、内部附件的真实地址与标识映射；模型根据任务选择工具并成功读取所需内容，以及无需取材时不强制读取。检查权限失败、链接失效、工具缺失、超大文件、取消及双 Bot 身份隔离，确认没有 Host/Adapter 预取或凭据进入模型文本。PDF/音视频具体解析效果在实际工具可用范围内分别验证，不能仅以 Context 渲染成功替代。

现有 Channel 仍只接入 type=1/2，未自动提取本决定中的资源引用；纯资源消息还需明确执行触发接线。这些是业务入口待实施工作，不是统一 Context 协议缺少表达能力。真实接口验证环境为 im-test；本轮未执行线上验证，不修改 Run=7 / Context=v3 或现有图片合同。

当前规则见[基础架构](../../rules/architecture.md)、[Context 输入](../../rules/context-input.md)、[Channel](../../rules/channel-integration.md)；逐项状态见[F04 评审](../../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf04-资源地址-context-与按需取材)。
