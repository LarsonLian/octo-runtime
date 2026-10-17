---
type: Task
title: PR 1 yujiawei 与 Jerry-Xin 评审分析及最小整改计划
description: 核实共享 Host 故障隔离、Provider 进程组回收及 HTTP 信任边界，按实际影响确定整改顺序。
tags: [review, channel, architecture, testing, lifecycle]
timestamp: 2026-10-17T00:00:00Z
---

# PR 1 评审分析与处理计划

## 当前执行状态

用户已授权逐项修复并分别提交；问题修复和 SDK 文档同步已实施，历史分析及决策如下，最新检查结果与验证边界以[实施记录](implementation.md)为准。此前“只更新 OKF”的阶段限制已被本次实施授权取代，删除范围与架构决策保持有效。

## 来源与实施前分析范围

来源为 [yujiawei 的 Changes Requested](https://github.com/Mininglamp-OSS/octo-runtime/pull/1#pullrequestreview-5556231591)，提交时间为 2026-10-17 12:37:55（北京时间），评审基线为 `0eb8b8d8fe8be5829da74ec6e686bfa39432f521`。

同一计划补充 [Jerry-Xin 的两项阻塞意见](https://github.com/Mininglamp-OSS/octo-runtime/pull/1#pullrequestreview-5556251807)，提交时间为 2026-10-17 12:43:24（北京时间），基线相同。保留原目录名称，以免拆散本轮评审上下文；[Jerry-Xin 专项分析](jerry-lifecycle.md)记录独立复现、职责及验收。

[评分与同类问题清单](assessment.md)补充每项修改必要性、技术可执行性、严重程度及修复或讨论取舍；新增 Codex 断管和 Host 组清理的独立探针结果，以及长时间运行的资源累积风险。

[Channel API 消费者专项](channel-api-audit.md)记录上传 helper 无已知调用、脚本的群列表依赖及真实结果投递链。按用户最新澄清，固定统一渠道逻辑可调用 API，不能仅凭模型前后时点判越界；未发现自动产物上传执行链。用户已确认删除 getGroupInfo、getUploadPresign、uploadFileToPresignedUrl，保留原生图片尺寸解析；已按决策删除并验证。

用户初始要求分析意见并建立 OKF 计划。该分析阶段只增加计划与索引，不修改产品代码、依赖、运行配置或现行架构合同，不提交 PR 回复或申请重新评审。当时区分已确认决策与其他评估建议，尚未实施产品代码。该阶段仅更新 OKF；后续实施授权与状态见本文顶部。

yujiawei 认定 PR 符合需求范围，没有发现架构实现偏离；其 Request Changes 来自两项 HTTP 代码意见。本地 socket 是附加建议，Node 22 的失败被该评审明确排除为未经核实的回归。Jerry-Xin 另指出两项生产调用链可触发的生命周期缺陷；本轮已独立复现，优先级高于 HTTP helper 整理。

## 实施前问题证据与当前判断

| 编号 | 意见 | 已证实的事实 | 工程判断与建议状态 |
| --- | --- | --- | --- |
| R05 | ACP 启动或管道错误可能终止共享 Host | 缺失可执行文件触发未处理 error；独立 Host 探针退出码 1，失败任务没有 run.failed，另一条已启动任务没有完成 | 接受 P1，真实故障隔离缺陷，建议合入前修复；已修复并验证 |
| R06 | Provider 主进程退出后中止整个进程组的逻辑提前结束 | NDJSON 与 ACP 均复现父进程已消失、工具子进程在关闭 1.3 秒后仍继续写文件 | 接受 P1，取消与资源回收合同缺陷，建议合入前修复；已修复并验证 |
| R01 | 群 ID 未进行路径段编码，评审标 P1 | getGroupInfo 确实拼接原值；保留字符会改变路径或查询语义。但当前业务链没有该函数调用方 | 局部缺陷成立，按当前可达性建议 P2；已决定删除无已知消费者的 getGroupInfo，不再补编码。已实施并验证 |
| R02 | 上传跟随未验证重定向，评审标 P1 | PUT 没有设置 redirect，默认 follow；URL 仅做字符串检查。当前没有自动上传调用链 | 条件性风险成立，按当前可达性建议 P2；R02a/R02b 均决定通过删除两项上传 API 处理，不继续建设 Channel 上传能力。已实施并验证 |
| R03 | 本地 socket 依赖同账号信任 | server 已明确注释无上层 RBAC，并设置 POSIX socket 为 0600；接入文档未清楚说明信任假设 | 用户已确认系统账号是本地信任边界，同账号客户端互信；现有设计符合目标。仅补文档，不新增 APP 身份区分、鉴权、错误码或错误卡片 |
| R04 | 用 Node 24 重跑检查 | 同一评审 SHA 的 GitHub Ubuntu/macOS 完整矩阵已经成功 | 已有证据覆盖。不能用 Node 22 的失败判回归，也不必因这条建议重复运行相同提交；后续代码变更照常验证 |

这里的 P2 是本次基于调用链的建议定级，不代替维护者最终定级，也不自动撤销 Changes Requested。不能把“暂无内部调用”写成“任何消费者都不可能调用”：删除前，三个 helper 都通过包级 imApi 导出；本轮已核对删除后的构建导出。

R05/R06 的前提不依赖并发压测或恶意远端。安装缺失、可执行路径失效和取消任务都是正常生命周期场景。CI 全绿只证明现有测试通过，不覆盖未加入测试的失败路径。对这两项，不能用“宿主负责安装”或“业务动作归工具”免除执行层的错误隔离与受管进程回收责任。

## 已确认决策：R01、R02a、R02b

状态：**已按确认决策实施并逐项提交；验证与提交记录见 [实施记录](implementation.md)。**

| 对应项 | 已选方案 | 原因与结论 |
| --- | --- | --- |
| R01 | 删除 getGroupInfo 的实现及公开导出 | 产品、脚本及已知宿主未发现消费者；用户确认 octo-cli 已支持相应业务能力并完成端到端验收。无需在 Channel 保留重复的群资料查询接口 |
| R02a、R02b | 删除 getUploadPresign、uploadFileToPresignedUrl 的实现及公开导出 | 未发现 Channel 上传消费者或内置上传需求；用户确认 octo-cli 能力及端到端验收。通过移除无用途入口处理风险，不继续补重定向策略、存储白名单或上传编排 |
| 保留范围 | 保留 files.ts 中仍用于原生图片输入的 parseImageDimensions 及必要依赖 | 输入图片尺寸解析是当前真实调用，不能因删除上传函数而整文件删除或关闭图片理解 |

“octo-cli 已支持且端到端验收通过”来自用户本轮确认，本轮未独立重跑，也未新增线上验收证据。其他无消费者 helper 仍只是候选，不自动纳入本次删除范围。

### 判定原则

1. 按具体职责、实际消费者、替代能力及内置必要性判断 API 是否保留；旧插件曾使用或当前仍公开导出，不单独构成保留理由。
2. 本次业务查询和文件上传已有 octo-cli 承担，且未发现 Channel 消费者，因此选择清理。此结论只适用于上述三项 API，不推导出“所有 Channel API 都不允许存在”。
3. 固定渠道接入、最终 @ 身份校验、卡片、typing、交互回传和协议投递可以直接调用 API。模型执行前后、是否发 HTTP，均不能单独作为越界判据。
4. 输入解析与输出上传分别判定。保留原生图片尺寸解析、群成员查询、群规则和话题规则；不把 getGroupInfo 与这些能力混同。
5. 删除公开接口是明确的 API 面变更。后续实施核对导出、生成声明、文档和消费引用；若发现新的真实消费者，记录影响并评估迁移，不自动扩大删除范围或恢复上传编排。
6. 决策完成不等于代码修复完成。R01/R02a/R02b 在清理与验收完成前继续标记“待实施”，不得用旧 CI 或用户提供的 octo-cli 验收替代本仓回归。

## 实施前实际调用与核实证据

- [conversations.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/conversations.ts) 的 getGroupInfo 未编码；相邻 getGroupMembers 已使用 encodeURIComponent。
- [files.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/files.ts) 包含 getUploadPresign 与 uploadFileToPresignedUrl；[API 汇总](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/index.ts)和[包入口](../../../packages/octo-runtime-extra-channel-gateway/src/index.ts)导出这些函数。
- 在本仓 apps、packages、public、test 中检索这三个符号，结果仅为定义、说明和日志，没有业务调用。已查 Work App、SDK 注册 demo 与 Worker 的源码；匹配仅为其中 Runtime 源码副本，未发现宿主调用。不能据此保证未知外部消费者不存在。
- files.ts 仍有正常使用：image-input.ts 使用 parseImageDimensions。若后续清理上传 helper，不得整文件删除或破坏首轮原生图片处理。
- Node v24.19.0 下替换 fetch 为内存捕获函数，调用当前构建产物：groupNo 为 `a/../b?view=other#fragment` 时，Request URL 归一化为 `/v1/bot/groups/b?view=other#fragment`；带 fixture Authorization。fragment 不是发给服务端的内容，但改变了群 ID 的解析语义。
- 同一次内存核实中，上传 helper 接受 `http://storage.example.invalid/object`，Request.redirect 为 follow，且不含 Authorization。所有值均为合成数据，无网络请求、真实凭据或文件上传；这仅证明请求构造，不是线上漏洞利用或业务验收。
- [daemon server](../../../packages/octo-runtime-daemon/src/server.ts) 的 459–461 行已说明 Unix socket 是本地控制边界、0600 限定当前账号、无额外 RBAC。
- [同 SHA 的真实 CI](https://github.com/Mininglamp-OSS/octo-runtime/actions/runs/39001794839) 已完成 Ubuntu/macOS 的 Node 24 安装、Lint、类型构建、完整测试、打包和离线安装；CI Gate 成功。

## R01 / R02：缺陷成立，按已确认删除方案处理

R01 的原始问题是群 ID 被 URL 解析为路径、查询或片段；这属于局部构造缺陷，尚无证据证明越权或跨域 Token 泄露。R02a 的原始问题是上传默认跟随重定向；R02b 是初始上传地址的可信合同不明确。风险依赖实际上传调用及错误或恶意目的地，不能描述为正常聊天已经泄露文件。

此前提出的路径编码、禁止上传重定向及可信存储策略，是“保留 API”前提下的备选方案。用户已选择删除三个无已知消费者的 API，这些备选不再属于本次实施计划，也不再要求用户确认 HTTP 部署或存储白名单。

本轮验收已检查三个 API 的实现及公开导出均已移除，构建声明不再暴露它们；保留的原生图片输入、最终 @、卡片和交互链路通过相关回归。不得把删除 Channel helper 表述为已修复 octo-cli 或外部存储的全部传输风险。

## R03：系统账号作为本地信任边界，现有设计符合目标

**决策已确认：本地 app-server 采用同一操作系统账号内客户端互信的模型。设备归属人已确定，不要求 Runtime 再区分同账号下的宿主 APP。R03 是文档说明项，不是当前架构的鉴权缺陷。**

原因：当前需求是用户机器上的本地执行服务。操作系统账号提供本地访问边界，Runtime 为该账号下的可信客户端提供执行能力；新增 APP 身份、共享 Token 或逐应用授权并不服务于当前需求，还会增加宿主接入与凭据维护成本。POSIX socket 已设置 0600；该权限用于限制其他普通账号访问，不承担同账号 APP 隔离。

判定原则：以本项目明确的部署范围、操作系统访问控制及执行合同判断是否满足要求。同账号客户端互信是主动选择的合同，不是因为问题低概率才暂不处理。与其他 app-server 架构的类比可以帮助理解，但不以“其他产品采用类似设计”代替本仓证据，也不泛化为所有 APP 均使用相同信任模型。

处理结论：仅在本地执行与 SDK 接入文档说明“系统账号是本地信任边界；同账号客户端互信；本地 IPC 不额外识别 APP 身份”。不新增鉴权机制、专用错误码或错误卡片。同账号正常调用没有违反合同，不能人为制造错误；真实的连接、权限和超时失败沿用既有错误路径，由宿主决定展示方式。POSIX 0600 的说明不扩展为未经验证的 Windows Pipe 权限保证。

状态：OKF 决策与结论已记录，并已同步[架构规则](../../rules/architecture.md#本地信任边界同一操作系统账号内互信)和[本地执行合同](../../rules/local-execution.md#本地客户端信任)；两份 SDK 接入说明已同步，本轮不修改产品代码。文档方案可执行性 100，产品代码修改必要性 0；无需为 R03 增加安全框架或代码修复验收。

## 里程碑与决策点

- M1：本轮完成意见核实、调用链与最小方案记录。状态：分析已完成，后续实施见实施记录。
- M1a：优先修复 R05 的 ACP 传输错误收敛，验证单任务失败、共享 Host 及其他任务存活。状态：已实施并验证。
- M1b：优先修复 R06 的本次受管进程组有界回收，覆盖父进程先退、后代拒绝 TERM；同步核对取消预算与清理事实，见[专项](jerry-lifecycle.md)。状态：已实施并验证，平台范围见实施记录。
- M2：按已确认决策删除 getGroupInfo 及两项上传 API 的实现与导出，覆盖 R01/R02a/R02b；保留图片尺寸解析。状态：已实施并提交。
- M3：核对删除后的引用、生成声明及文档，运行类型构建和相关图片、回复、卡片、交互回归；记录实际结果后才能将三项标为完成。状态：实现与聚焦验证已完成，最终完整检查见实施记录。
- M4：R03 架构规则与本地执行合同已同步，两份 SDK 接入说明已同步；现有代码符合该信任模型，不新增鉴权或专用错误反馈。产品代码变更按范围验证，并以新提交的 Node 24 CI 为证据；需要真实 API 联调时只使用 im-test，记录与模拟边界测试分开。

R01/R02a/R02b 的删除决定、R03 的信任合同及 R05/R06 与同类项已实施并逐项提交。当前没有新的产品决策点；未推送、未发送评审回复、未合并。最终检查与平台证据范围见实施记录。
