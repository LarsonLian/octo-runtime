---
type: Task
title: PR 1 评审评分、处理取舍与同类问题清单
description: 区分必须修复的执行隔离缺陷、条件性 HTTP 风险及文档建议，列出必要性、可执行性、证据和剩余缺口。
tags: [review, lifecycle, architecture, testing]
timestamp: 2026-10-17T00:00:00Z
---

# PR 1 评分与同类问题

属于[原评审计划](brief.md)，沿用基线 `0eb8b8d8fe8be5829da74ec6e686bfa39432f521`。原分析来自 yujiawei 和 Jerry-Xin 两份 Changes Requested，以下保留问题与决策依据。用户后续已授权实施；第一轮 R01/R02a/R02b/R03/R05/R06 与 S01–S05 的修复已分别提交，R06 第二轮 Codex 遗漏已补齐，本次验证见第二轮记录，具体检查与平台范围见[实施记录](implementation.md)。R04 不需要新增产品代码，按新修改记录 Node 24 本地检查；第一轮已推送，R06b 本次已实施，R07 已发表评审说明，未合并。

[Channel API 消费者专项](channel-api-audit.md)确认无已知消费者，按用户决定删除三个 API 并保留图片解析。固定渠道逻辑仍可直接调用 API，不以模型执行前后时点判断越界。

## 第二轮当前状态

新增 [R06b / R07](second-review.md)：R06b 为 Codex 回收遗漏，已实现并补回归，P1，必要性/可执行性 100/100；R07 经组织规范及其他项目核对，保留共享 workflow 的 @v1，改为证据回应，本仓单独改 SHA 必要性 0、回应可执行性 100，评审讨论尚未关闭。R06b 本次验证与第一轮分开记录；下表保留第一轮问题和证据，第二轮的实现和回应按独立记录判断。

## 评分口径

- **修改必要性 / 100**：当前架构、真实调用和已知影响下是否值得改。100 表示既有合同已被破坏，应在合入前修复；低分不表示问题不存在，而是现有需求不足以支持扩建。
- **技术可执行性 / 100**：当前是否已有明确、局部、可验证的处理方案。100 不等于已经完成；低于 100 必须说明尚未解决的合同或实施细节。未实施、未跑修复后测试，本身不作为扣分理由；问题是否复现另列证据状态。纯文档或证据回应按该处理动作评分。
- **严重程度**：P1 为共享执行中断或受管任务停止后仍持续执行；P2 为局部缺陷、条件性风险或尚需定级的资源保护缺口；P3 为说明不足。评审原定级与本次建议定级分别保留。
- **处理目标**：“修复”指接受缺陷并按边界修正；“讨论范围”对应用户所说 battle，使用调用证据和合同讨论定级或方案，不否认已证实事实；“证据回应”指已有检查覆盖，无需新代码。

分数是工程判断，不是压测指标，也不对整个大型 PR 给出一个掩盖 P1 的平均分。

必要性 80–99 分仍表示建议纳入修复；85 分不表示方案只能解决 85% 的问题。已接受修复项的目标都是完成下述整个验收范围，不能留下 15% 的已知缺陷。候选项先核实触发条件，确认后按相同标准修复。

## 原评审逐项判断

| 编号 | 缺失点及我的评审意见 | 建议级别 | 修改必要性 | 技术可执行性 | 是否需要修改 / 目标 |
| --- | --- | --- | --- | --- | --- |
| R05 | ACP 未监听进程及相关管道 error；缺失命令可终止共享 Host，坏任务无 run.failed，兄弟任务中断。已独立复现，是真实故障隔离缺陷 | P1 | 100 | 100 | 已修复并提交；进程/管道错误仅终止本调用 |
| R06 | NDJSON、ACP 以父进程退出判断组已清理，后代拒绝 TERM 时继续工作。两条传输均复现，不是性能微优化 | P1 | 100 | 100 | ACP/NDJSON 已修复；Codex 遗漏 R06b 已补齐，Windows 真机仍待验收 |
| R01 | getGroupInfo 未编码群 ID，保留字符改变 URL 语义。局部错误成立；暂无内部调用，不足以证明越权或跨域泄露 Token | P2，原评审 P1 | 85 | 100 | 已删除并提交；通过清理解决 R01 |
| R02a | 保留上传 helper 时未禁止重定向，存在字节被继续发送的条件性风险。当前无自动上传链，PUT 本身不带 Bot Authorization | P2，原评审 P1 | 85 | 100 | 已删除并提交；通过清理解决 R02a |
| R02b | 初始上传目的地的可信合同未明确。仅禁跳转不能解决恶意初始地址；存储可合法跨域，且现有实现包含 HTTP/私有部署 | P2，条件性 | 85 | 100 | 已删除并提交；通过清理解决 R02b，不建设目的地策略 |
| R03 | 用户确认系统账号是本地信任边界，同账号客户端互信；现有设计符合目标，只需说明合同 | 文档说明项，不构成当前鉴权缺陷 | 80（文档）/ 0（代码） | 100 | 已同步架构、本地执行及两份 SDK 指南并提交；不新增 APP 鉴权或错误卡片 |
| R04 | Node 24 验证建议：同一 SHA 的 Linux/macOS 完整 CI 已成功，Node 22 失败没有被原评审认定为回归 | 不构成代码缺陷 | 0（新代码） | 100（证据回应） | 不改代码；提交已有 CI 证据，修复后正常跑新提交检查 |

R01/R02a/R02b 的可执行性均为 100：删除范围、保留边界和验收方式已明确。修改必要性按无用途公开 API 的清理评为 85，不代表线上 P1；可执行性 100 不代表代码已完成。octo-cli 支持与端到端验收是用户确认的依据，本轮未重跑。

### 原可执行性缺口的处理

R06 已明确预算：TERM 400 ms + KILL 后确认 200 ms 共用起点，ACP/ZCode 协议取消宽限 250 ms，总计约 850 ms，低于 Host 默认 1000 ms。更短 Host 宽限仍返回真实 cleanup_timeout，不扩大用户预算。同次清理 Promise 保存结果，EPERM 不记为目标消失。POSIX 实现方案可执行性调整为 100；本机 macOS 已验证，远端 Linux CI 与 Windows 实机验证不冒充已完成。Windows 已有关闭实现，必须满足同等生命周期要求；本轮未真机验收，后代回收疑点及 CI 缺口由 [issue 2](https://github.com/Mininglamp-OSS/octo-runtime/issues/2) 跟踪，不能将支持要求降为“不保证”。

S03 已补真实 ZCode 协议 fixture，S04 已确定普通行、图片回显和队列各自上限；二者的原方案缺口已消除。当前实施细节、验证数量及平台边界以实施记录为准，历史低分描述不再代表待用户决策事项。

## 同类问题的定向检查

Jerry-Xin 的风格是核对资源所有权、错误是否越界、取消是否真实生效；yujiawei 的风格是检查输入能否改变传输目的地及信任假设。两者都有价值，但不能将每个条件性 HTTP 风险都等同为线上 P1。

检查范围为相邻 Adapter/ACP/Host 的 spawn、error、stdin、关闭和缓冲，以及 Channel API 路径构造；不是全仓每个 Provider、平台和业务场景的穷尽审计。

| 编号 | 同类缺失及源码位置 | 证据状态 / 后果 | 建议级别 | 必要性 / 可执行性 | 是否修改 / 处理 |
| --- | --- | --- | --- | --- | --- |
| S01 | [Codex app-server](../../../packages/octo-runtime-adapter-codex/src/app-server.ts)的 stdin 未监听 error；write 回调不等于流错误处理 | 真实管道探针已复现未处理 EPIPE、执行所在 Node 进程退出码 1；未重复真实 Host RPC 兄弟流验证 | P1 | 100 / 100 | 已修复并提交，Codex 正式回归通过 |
| S02 | [Host launcher](../../../packages/octo-runtime-adapter-host/src/process.ts)的 terminateProcessTree 也在 leader 退出时提前返回 | public spawnAdapterHost 探针已复现：close 约 1 ms 返回，1.3 秒后工具仍工作，随后 150 ms 新写 6 字节 | P1 | 95 / 100 | 已修复并提交；仅回收本次受管组 |
| S03 | [ZCode app-server](../../../packages/octo-runtime-adapter-zcode-gui/src/app-server.ts)的 close 同样由父进程退出决定是否升级 KILL | 源码确认同类条件，且以 detached 创建组；后续已补真实 ZCode 协议 fixture，验证 leader 先退时工具仍被回收 | P2 暂定 | 90 / 100 | 已修复并提交，预算已明确；平台范围见实施记录 |
| S04 | [ACP AsyncQueue/readline](../../../packages/octo-runtime-acp-client/src/index.ts)和 ZCode 的对应接收缓冲没有显式队列字节/条数上限及单行上限 | 源码确认；Provider 持续快发、下游慢消费或单行过大时存在内存增长条件。未做 RSS/吞吐实测，不声称已经 OOM | P2 | 85 / 100 | 已修复并提交；容量和正常终态保留回归通过 |
| S05 | Host launcher 给 stdio RPC 安装了流错误处理，但 spawn 的 ChildProcess 本身没有 error 监听 | 源码确认；固定 process.execPath 降低命令缺失概率，但资源不足等实际 spawn 失败仍可能发 error。未注入真实 OS 资源故障 | P2 暂定 | 85 / 100 | 已修复并提交；真实 ENOENT 注入验证通过 |

S02 不是 R06 Provider 泄漏的兜底方案：Provider 自己采用 detached 时属于另一个组。必须由各自创建者负责自己的资源，不能让宿主扫描全机杀进程。

R05 另须覆盖一个相邻状态缺口：ACP 的 failAll 只清当前 pending/updates，没有保存不可恢复失败状态；尚未 close 时的新请求可能继续写入或等待超时。归入 R05 的失败收敛验收，不重复计作另一条 P1。

## 具体修复建议

以下保留实施前方案；已实施的具体代码、预算与验证以[实施记录](implementation.md)为准。保持现有 Host、Adapter、Extra 职责；核心代码注释引用本计划中对应的问题编号和合同理由。

| 对应项 | 修改位置与具体动作 | 修复后的可观察结果 / 验收 |
| --- | --- | --- |
| R05、S01 | ACP client 和 Codex app-server 在发起首次请求前安装 child、stdin 及所拥有读取流的错误处理；把不可恢复错误收敛到一个幂等失败入口，保存首个真实原因，拒绝 pending、结束事件流，并让后续请求立即失败。写回调继续表示本地写入结果，不代替 error 监听 | 缺失命令、EPIPE 和连续 error/exit/close 只结束本次调用一次；canonical 由已有映射产出真实 run.failed，native 沿原失败合同处理。真实 Host RPC 中坏调用失败、好调用完成，随后新调用仍成功 |
| S05 | 在 spawnAdapterHost 创建 child 后立即监听 child error；使 readiness 等待立即失败、关闭本次 RPC client，释放 readiness 定时器及监听器。尚未获得 PID 时跳过进程组信号 | 注入异步 spawn 失败后 SDK 返回明确错误，宿主进程存活；不等满 readiness 超时，不产生未处理 rejection。用局部故障注入验证，不耗尽整机资源 |
| R06、S02、S03 | 各创建者持有本次进程组的清理状态与单一 cleanupPromise；abort、close、异常结束和 generator 提前退出均等待这次清理。TERM 后按组是否仍存在决定后续 KILL，取消以父进程存活为条件的升级判断 | 父先退、后代拒绝 TERM 时仍完成组回收；父子都拒绝 TERM、组已消失和重复 close 均有界结束。兄弟任务及外部 Gateway 不受影响；清理超时返回真实失败事实 |
| S04 | 在 ACP、ZCode 的读取端、JSON.parse 之前限制单行字节；在各自异步队列中记录条数与总字节。消费时扣减，关闭后拒绝 push；超限立即停止接收、释放积压，并进入本调用的失败及清理路径 | 快生产、慢消费及超长无换行输入不会无限积压；超限不静默丢正文或伪造完成。当前调用明确失败，其他调用继续；边界值、释放计数和反复创建/关闭均有回归 |
| R01 | 删除 getGroupInfo 的实现与导出，不再补路径编码 | 源码、公开入口及构建声明不再暴露该函数；群准入、规则和成员查询保持正常 |
| R02a | 删除 getUploadPresign、uploadFileToPresignedUrl 的实现与导出，不再补上传重定向策略 | 无遗留调用或上传导出；现有图片输入、回复、卡片及交互回归通过 |
| R02b | 随 R02a 同一清理处理，不新增可信存储配置；保留 parseImageDimensions 及必要依赖，不整文件删除 files.ts | 构建声明不再包含上传入口；原生图片尺寸解析仍可用。仅消除本仓该入口，不声称覆盖外部工具的全部上传风险 |
| R03 | 在本地执行与 SDK 接入说明中声明：系统账号是本地信任边界，同账号客户端互信，不额外区分 APP 身份。POSIX 0600 按实际平台说明 | 文档与现有架构一致；不新增鉴权、专用错误码或卡片。真实连接错误沿用既有路径，由宿主展示；本项无需产品代码修复 |
| R04 | 保留同 SHA Node 24 CI 链接；后续真实代码提交运行新增回归及受影响检查，并由 CI 验证 Linux/macOS | 提供修复后提交的检查证据，不能用旧 SHA 全绿代替新修复验收 |

### 进程清理如何落地

建议把清理实现写成当前资源拥有者内的可等待操作：记录本次创建的 PID/PGID、是否成功创建组、清理截止时点和 cleanupPromise。其他调用共享同一个 Promise，不能看到 closed=true 就提前返回“已完成”。本轮不要求新建公共包或全局进程注册表。

POSIX 顺序为：向本次受管组发送 TERM → 在剩余宽限内检查组 → 组仍存在则 KILL → 在截止前核实清理结果。leader 的 exit 只结束 leader 等待，不清除组升级任务。ESRCH 表示目标已不存在；EPERM、其他信号错误和截止时仍存在分别保留失败事实，不能等同成功。组探测和发信号只发生在本次连续、有界的清理周期，不保存历史 PGID 以后重试，也不扫描或终止任意同名进程。

当前约 1 秒的 Host 取消预算与传输约 1 秒宽限不能层层累加。建议由调用持有的取消截止时点约束传输：协议取消等待、TERM 宽限和 KILL 后核实共用剩余时间；短预算压缩温和等待，不静默延长。实施前仍须核对截止时点通过现有调用上下文如何传到每条传输，以及超时后清理失败的既有返回路径。这是 R06/S02/S03 可执行性保持 90 分的具体缺口，不需要用户决定某条业务流程。

平台验收按当前支持范围分别进行。POSIX 进程组方案不声称回收主动脱离组的后代；Windows 沿现有受管进程终止方式补等价验收，不能直接照搬负 PGID 或宣称未经验证的平台已完成。

### 缓冲上限如何落地

建议以现有 DriverQueue 的 **单项 256 KiB、队列 4096 项、累计 4 MiB** 作为普通事件队列的起始方案，任一上限都会生效；这些数值已有实现依据，尚不是 ACP/ZCode 已采用的新合同。单行限制须在读取字节时执行，仅在 JSON.parse 后判断已经太晚。超限沿现有 STREAM_EVENT_TOO_LARGE / STREAM_BUFFER_OVERFLOW 错误约定表达，并确认各自的协议映射。

实施前核对 ACP/ZCode 的合法回复形态：若有超过普通事件上限的原生图片或输入回显，按该消息的既有协议大小约束处理，仍保持有界；不能为兼容一种大消息而取消所有消息上限。优先复用现有低层原语；ACP 当前不依赖 adapter-sdk，不为复用队列引入循环包依赖。尚需完成消息分类和大小合同核对，因此 S04 可执行性保持 90 分。

正式回归除了单次容量边界，还应重复执行启动、取消、关闭和慢消费场景，确认受管组、队列计数、pending、监听器和定时器均回到可预期状态。RSS 可作为辅助趋势观测，受 GC 与系统缓存影响，不以固定运行次数后 RSS 完全相等作为唯一门禁，也不以整机 OOM 作为验收方法。

### 实施前分数修订记录（当前结果见实施记录）

R01、R02a、S05 的 85 分为修改必要性，其局部方案可执行性已经是 100 分。S04 的必要性为 85、可执行性为 90，建议纳入长期运行保护。S03 的可执行性由 85 调整为 90：具体组回收方案已写清，其尚未复现单独保留在证据列；剩余扣分来自取消预算接线及平台边界。R02b 原来的必要性 60 / 可执行性 65 针对保留上传并新增目的地约束的备选。用户确定删除后，当前清理方案调整为 85 / 100；部署策略不再是本次待决项，代码现已实施，见实施记录。

## R01 / R02 的历史用途与当前归属

旧插件核查目录为 `/Users/lvsijia/github.com/Mininglamp-OSS/openclaw-channel-octo`，源码基线 `2e710e903fa43ac9440723746f7395d2f7b4347e`。这里核实的是本地检出的版本及 Git 历史，不声称所有旧版本和线上部署均一致。

| API | 旧 OpenClaw 插件的真实调用方 | 原来解决什么问题 | 评审基线的 Runtime 状态 |
| --- | --- | --- | --- |
| getGroupInfo | src/agent-tools.ts 的 octo_management 工具，action=group-info；src/actions.ts 的 channel-info 动作 | 根据群 ID 获取群资料，返回群号、名称及服务端附加信息，供模型工具操作或消息动作查询使用 | 仓内只有定义与导出，没有这两条旧业务调用链。它不承担当前群消息准入或 @ 判断 |
| getUploadPresign + uploadFileToPresignedUrl | src/channel.ts 的 outbound.sendMedia；src/inbound.ts 的 uploadMedia / uploadAndSendMedia，被 IM 回复投递与 actions 媒体发送调用 | 读取本地文件、data URI 或下载远端媒体，取得上传许可，将字节上传到对象存储，拿下载地址后发送图片/文件消息；富文本也复用上传结果 | 仓内只有 helper，没有自动 artifact 收集、上传及发送链。保留代码不等于当前产品需要 Channel 执行上传 |

旧上传链路是“OpenClaw 产生媒体引用 → 插件解析文件 → 向 Octo Server 申请预签名 URL → PUT 文件字节到存储 → 把 downloadUrl 放进 IM 媒体消息”。本机路径不能直接供其他聊天用户访问，因此旧插件作为 OpenClaw 的媒体投递适配层实现了上传。src/inbound.ts 的 IM deliver 分支还会读取回复 payload 的 mediaUrl/mediaUrls 并调用此链路；这不同于扫描整个工作目录，不能将两者混写。

Git 提交 `7ef1e25036cf62440e14cb1bbab44b3b11535526`（2026-06-11，fix(upload): file upload via backend-agnostic presigned PUT，PR #66）记录了该 API 组合的直接来源：替换原先仅支持 COS 的凭据接口和 COS SDK，修复 Docker + MinIO 无 COS 配置时无法上传的问题。由 Server 选择并签发 MinIO/COS/S3 等存储地址，插件仅做标准 PUT；因此跨域存储是原设计的正常用法。此处引用的是历史提交说明，没有将其当成本轮真实部署验证。

当前 Runtime 的 conversations.ts、files.ts 均注明 Adapted from 旧插件 api-fetch.ts；在拆分渠道扩展提交 `1541538` 中已存在这些 helper。当前 apps/packages/public/test 检索没有三个 API 的业务调用，说明迁移后保留了超出已接线能力的 API 面。旧代码中有用途，并不能证明新 Channel 需要保留该职责。

按[现行架构](../../rules/architecture.md#业务动作归-agent-tool-callcontext-约束行为)，Agent 的业务查询、文件上传及附件交付由 octo-cli 或其他工具执行，业务方通过本轮 Context v3 指令表达要求；Channel 不因收到媒体引用就在后台替 Agent 上传。getGroupInfo 与群规则读取、群成员读取是不同接口，清理前者不代表删除后两者。

当前状态为“已按删除决策实施并提交”：删除 getGroupInfo、getUploadPresign、uploadFileToPresignedUrl；保留 files.ts 的 parseImageDimensions 及原生图片输入所需依赖。用户确认 octo-cli 支持相应业务能力且端到端验收通过，本轮未独立重跑。其他 helper 不自动纳入删除范围。固定渠道逻辑仍可直接调用 API，逐项按职责与必要性判断。

### 不应误报或机械扩大范围的地方

- 相邻 getGroupMembers、topic/group rules 等路径已编码。事件 ACK 的 eventId 在内部调用前经过 Number.isSafeInteger 校验，不能只看到字符串插值就宣布存在同等路径注入。公共 helper 的运行时输入合同可另核对，不据此伪造现有业务漏洞。
- ZCode 已有 child 和 stdin error 监听；Codex 已有 child error 监听。缺口应按具体事件源补齐，不宣称所有 Adapter 都没处理错误。
- [DriverQueue](../../../packages/octo-runtime-adapter-sdk/src/native.ts)已经有单项、条数和总字节边界；NDJSON/Codex 已有 watchLineLimit。应复用可适用的既有模式，但 ACP 不应为复用而引入循环包依赖，也不能把普通输出的固定大小机械套到合法原生图片或输入回显。
- Codex 关闭也观察 leader，但其进程终止实现和平台方式不同；本轮不把仅凭相似条件的猜测记录成已复现后代泄漏。

## 长时间运行与内存风险

有可能耗尽资源，但不能将“存在风险”写成“必定内存爆炸”。

R05/S01 的直接后果是未处理错误使共享执行进程退出和任务中断；它们不是已证明的单进程内存泄漏。R06/S02 的直接后果是调用收尾后仍遗留活跃后代。若残留持续存在且后续反复触发，进程数和总资源可能累积，消耗的不只是内存，还可能有 CPU、文件句柄、磁盘与网络。仅重启 Host 不能保证清除已经独立成组的 Provider。

可用于估算的关系是：额外总内存约等于“仍存活的残留进程数 × 每个残留的实际内存占用”；残留数又取决于触发次数、每次留下多少后代及后代自然退出速度。本轮没有这些生产测量值，不能给出几小时 OOM 或具体 GB 数，也不能把 RSS 简单求和当成精确物理内存消耗。

S04 是另一种机制：内存可能堆在仍存活的 Host 接收缓冲中，无需残留进程。需要验证有界输入、慢消费者和超限只终止当前调用，不用整机 OOM 证明问题。

## 本轮新增证据与实施边界

- macOS、Node v24.19.0，当前构建产物；临时探针 `/tmp/octo-runtime-pr1-adjacent-probe.mjs`，不进入产品源码。
- S02 使用模拟 RPC peer，走 public spawnAdapterHost 完成 list 握手；leader 默认响应 TERM，工具忽略 TERM 后继续写专属临时文件。
- S01 使用 public runCodexAppServerTurn 与真实 OS 管道，合成 peer 关闭 stdin；发生 EPIPE，Node 进程退出。没有调用真实 Codex 或模型。该探针只证明传输异常可越出调用边界，不冒充完整 Host RPC 验收。
- 先前的流对象注入也复现未处理 error；一次 Node peer 手动关闭 fd 的尝试因 fixture 自身断言失败，不能作为产品缺陷证据。最终结论采用真实 shell peer 管道结果。
- 所有专属工具、peer 已清理并核实不存在；临时目录已移除，没有修改 Runtime Home、配置、身份或已有服务。没有运行线上 API/模型调试，不属于 im-test 业务验收。

建议实施顺序：R05 + S01/S05 的传输错误隔离，R06 + S02/S03 的受管组回收，然后 S04 容量保护和 HTTP/文档项。缺陷按独立问题提交；边界清楚后再编码，不为此新建全局进程状态库、通用安全中心或 Channel 业务编排。
