---
type: Plan
title: Issue 46 ExecutorCore 实施计划
description: 基于 GitHub main 的分步改动、交付物、依赖和停止条件；本机实施已验证，跨平台和联验待完成。
tags: [architecture, executor, planning, testing]
timestamp: 2026-10-20T00:00:00Z
---

# 基线与计划口径

仓库 [Mininglamp-OSS/octo-runtime](https://github.com/Mininglamp-OSS/octo-runtime)，issue [#46](https://github.com/Mininglamp-OSS/octo-runtime/issues/46)。基线 `origin/main@7fb81e9`，分支 `refactor/46-executor-core`。用户已授权实施；M0–M3 本机通过，M4 本机产物验证通过但原生跨平台证据待补，M5 尚未进入。实际命令和消费映射见 [实施记录](implementation.md)。

交付决定更新：用户已明确要求提交正式 PR 到 main，并使用 `Closes #46`，其他 issue 为 Related。
以下 M5 保留为后续 #47/#51/#50 的联合验证计划，不再作为本次 PR 关闭 #46 的前置条件。
这项交付决定不表示新 Kernel、真实宿主或尚未运行的平台验证已通过。

开发可执行性按六项判断：边界是否明确、状态合同是否确定、每阶段能否独立交付、验收是否可重复、迁移是否保持可运行、依赖是否有进入/退出条件。评分见 [计划评审](assessment.md)，不把代码尚未实现、测试尚未执行作为计划扣分理由。

## 责任与改动边界

| 对象 | #46 必须做 | #46 不承担 |
| --- | --- | --- |
| ExecutorCore | 唯一输入准备、渲染、执行、交互、取消、终态和 invocation 资源 | socket/RPC 服务、窗口回放、进程监督、业务历史 |
| 原 adapter-host 包 | 移出执行实现，现有 RPC/runner 委托新 Core；保持原隔离默认 | 本次直接改造成新 Kernel 或删除 worker |
| HostRunService | 仅做新 Core 类型与传输端口所需接线，保留既有窗口 | 移入 Core、复制接纳/正常终态权威 |
| Provider Adapter | 更新必要类型路径；保留原生协议、队列、关闭和错误 | 普遍重写 Adapter、安装决策、替业务补 Context |
| CLI/SDK/Extra | 更新实际受迁移影响的 import/export/runner 引用 | 新 CLI 命令、独立 Extra 运行、宿主账号体系重构 |
| 协议与发行 | 保持 Run7/Context v3，新增公开 Core 入口，保留当前容量合同 | Go 客户端、隐式独立 npm 发包、远端发布 |

逐文件迁移表在 [设计](design.md)。新 Core 不向旧 host 包反向依赖；旧 host 可以暂作传输适配器，但不得存在第二套执行类。输入准备工具的迁移不授权把过去显式调用的准备步骤自动加入所有 invoke。

## Milestone 总览

| 阶段 | 进入条件 | 可交付结果 | 通过后允许什么 |
| --- | --- | --- | --- |
| M0 基线与合同 | 本计划及当前源码可用 | 消费清单、API/状态合同、既有失败基线 | 开始执行实现抽取 |
| M1 单一执行核心 | M0 的 Core 本地合同明确 | direct Core 及原 worker 最小接线可构建 | 开展生命周期/故障整改 |
| M2 生命周期与错误 | M1 可执行 | 接纳、取消、终态、shutdown 和状态释放回归 | 固定 Core 生命周期 API |
| M3 隔离与传输等价 | M2 本地合同通过 | 真正子进程 NDJSON parity、窗口与故障回归 | 下游使用新 Core，不删除隔离 |
| M4 发行与工程交付 | M3 通过 | 主包公开导出、仓库外消费、平台证据、说明 | #47/#48 可消费 Core 检查点 |
| M5 新架构联合验收 | #47 接口就绪，#50 有实际接入方 | 新 Kernel parity 和真实业务证据 | 关联任务的集成验收，不作为本次 PR 关闭 #46 的前置条件 |

依赖顺序：`M0 -> M1 -> M2 -> M3 -> M4 -> M5`。M1 迁移执行类与接回旧 runner 是同一可构建变更，不能交付一个必须等下一 milestone 才能构建的中间状态。M5 的外部依赖不阻止 M1–M4 开工。

## M0：建立可执行基线和合同

**输入**：当前 GitHub 基线、#46/#47/#51、已存在的执行和发行测试。

**工作与产物**：

- [x] 记录当前 build/type/lint/格式/测试结果。对已有失败记录具体测试、错误、平台和关联 issue，不以“既有失败”自动豁免受影响合同。
- [x] 导出实际 import/export/runner/打包消费清单，逐项归属新 Core、临时传输壳或下游任务。
- [x] 按 design 的声明、接纳时点和状态表固定 direct API，保留同步注册与异步探测差异。
- [x] 将 #47/#51 交接项列成具名产物：执行端口、receipt/源帧/终态 fixture、取消与交互失败语义；明确哪些可用现有 worker 先验，哪些必须等新 Kernel。

**验收**：清单覆盖代码 imports、类型 imports、runner URL、manifest、public declarations、package dependencies、lockfile 和 tarball verifier；每项有去向。接口文档没有 `shutdown 返回类型后定` 一类本地实现空缺。跨 issue 未完成项保留为 [R1–R3](assessment.md) 的显式进入条件。

**失败处理**：无法形成可构建切换时先缩小单次迁移范围，不创建双引擎作为兜底。未记录的关键基线失败先定位，不直接继续包改名。

## M1：迁移唯一执行实现并保持原链路

**改动文件**：新 `packages/octo-runtime-executor-core/**`；旧 core 的 context/invoke-input；旧 host 的 index/model-input/experience/watchdog/execution-preparation；必要 manifests、imports、serve/RPC 类型接线。

**步骤**：

- [x] 先迁入现有行为，再去除 Core 的传输 re-export；将执行类命名为 AgentExecutor，显式注册 Adapter。
- [x] 同一变更内让旧 worker 创建 AgentExecutor，更新所有直接受影响消费者并删除旧 Core 实现及其依赖引用。
- [x] 原 host 暂留 RPC/process/serve/runner/socket；仍为独立进程。Core 不读取 CLI manifest、账号配置，不隐式加载 Provider。
- [x] Core 保留原输入/输出、32 MiB 请求预算、中央 streamLimits 与本轮 Context 渲染。工作区准备工具保持显式来源。

**验收**：typecheck、lint 和相关输入/输出/Context/Adapter 测试通过；direct fake Adapter 完成双模式执行；原独立 runner 就绪且能执行；依赖检查不存在 Core -> old-host/Kernel/Extra 或 adapter-sdk -> Core 的环。

**失败处理**：构建或原 runner 失败时停止进入 M2，修复同一迁移变更。仅移走文件或新增空包不算 M1 完成。

## M2：完成接纳、取消、关闭与错误合同

**现状动机**：原 `index.ts:359` 先 yield running，`:551` 附近才建立活动控制器；`:941` 的 shutdown 不关闭接纳且超时直接 resolve。直接导出旧类不能作为完整生命周期验收。

**步骤**：

- [x] 接纳前完成输入、权限、streamLimits 和固定渲染校验；失败不留下 started/receipt 记录。避免现有 streamLimits 校验晚于记录写入的顺序。
- [x] 在首帧对外可见前建立 invocation 所有权及取消控制器，覆盖“收到 receipt、Provider 尚未启动”的窗口。
- [x] 区分候选 Provider 结果、清理结果与最终 Host 终态；已确认终态不得被迟到取消或外围故障改写。
- [x] 实现 design 中 OPEN/CLOSING/CLOSED 及 shutdown 结果，保留失败清理的所有权；不以“等待超时”代表进程清理成功。
- [x] 覆盖不消费、暂停消费、提前 return、接纳异常、容量满、终态后淘汰；不按 sessionId 存业务材料。

**验收**：执行 [D01–D14](acceptance.md) 的相关 fault/竞态用例。fake scheduler、可控 iterator 和进程 fixture 分别证明逻辑时序与 OS 资源结果，不用固定 sleep 碰运气。1024 invocation 与 TTL 边界可用缩短时钟测试，不等待真实两分钟。

**失败处理**：失败详情与清理结果分别保留；未终止资源不得通过清空 Map 隐藏。Core 无法强制停止同进程死循环，不能为通过用例增加虚假的恢复终态。

## M3：保留 NDJSON 隔离并验证同一执行合同

**改动范围**：旧 host 传输适配代码、真实子进程 fixtures、HostRunService 必要类型接线及回归。

- [x] direct 与旧 worker 使用同一 fake Adapter 测试表；worker 必须通过真实 child_process/stdin/stdout，PassThrough 测试仅补充。
- [x] 输入/Context/有效执行配置、事件载荷、错误类别、交互结果、取消与唯一终态等价。只归一化明示的随机 streamId/时间，单独验证身份关联与连续 seq。
- [x] 验证单个 Provider 失败不终止兄弟调用；旧 worker 退出使受影响执行真实失败/lost，不重放请求。父进程 hang 检测/重启仍由 #47 实现，本项不假称新增该能力。
- [x] 大帧、受信预算、慢读、窗口缺口、过期、源 identity、订阅断开与显式取消保持原合同；消费者重放不重复调用 Adapter。
- [x] Windows manifest/UNC/file URL、端点派生及受管后代回收的既有实现保留。

**验收**：D15–D18 与相关原测试通过；记录实际 worker PID、Provider 创建次数、终态数、资源退出与有界窗口结果。不能只比较最终一段文本。

**失败处理**：任何默认内联执行、第二套 resolver、身份重编号或重放副作用都阻止 M3 通过。

## M4：提供可安装产物并完成工程交付

- [x] 单一发行物增加 `/executor-core` ESM/类型导出；内部 workspace 包仍 private。完整主包保留原发行能力，Core import 不启动服务。
- [x] 从离线 tgz 在仓库外临时工程进行 Node/TS 消费，验证类型没有指向源仓库、旧内部 Core 或未打包依赖；保留旧内部路径负向检查。
- [x] typecheck、lint、lint:names、format:check、生成物/lockfile 漂移检查、全量 Node/UI 与 tarball 验证通过，命令见 acceptance。
- [x] 复用现有 Linux/macOS CI 和 Windows 发行验证；新 direct/生命周期专用测试加入 Windows 原生执行，不能把只有 Windows 打包步骤写成全套 Core 测试已覆盖。
- [x] 补齐 API、故障域、显式 direct 与默认隔离示例；明确稳定性优先推荐 Kernel IPC，direct 为可选 SDK 内嵌简易方案；同步规则路径触发器。公开 OSS 说明采用英文，内部 Octospec 采用中文。

**验收**：仓库外工程只依赖 tgz 即可注册 fake Adapter，完成 invoke/输出/respond/cancel/shutdown；同产物原默认 CLI/worker 路径仍可用。保护现有 Home/profile/config，临时测试只用新建隔离 Home。发布、用户 Home 升级和外部 App 改造不是本阶段操作。

**交付边界**：M4 可交付给下游使用，不代表新 Kernel worker 已验收。用户已授权提交、推送并创建正式 PR 到 main；PR 使用 `Closes #46`，其余 issue 为 Related，原生平台结果由该 PR 的实际 CI 提供。

## M5：新 Kernel 和业务联合验收

**进入条件**：#47 提供已就绪 Kernel、明确版本的执行端口和故障 fixture；#51 提供共同 wire/行为 fixture；#50 指明维护中的真实 SDK 宿主、CLI/Extra 配置和联调入口。缺少条件时停在 M4，不创造替代 Kernel 冒充证据。

- [ ] direct、旧 worker、新 Kernel 对同一表执行完整双模式合同，确认 Kernel worker 使用同一 Core。
- [ ] 核对 ACK 丢失、worker 在最终终态前/后退出、订阅断开、取消与交互竞态；与 #47 保持单一正常终态及真实 lost，无自动重放。
- [ ] #50 在 im-test 与真实 Provider 上覆盖一次 SDK 和 CLI 的执行、流、交互、取消、失败、停止及重启；实际 App 改动必须构建重启，涉及 renderer 则记录 CDP。
- [ ] 比较既有身份/Home/profile/配置前后状态；#14/#47 补实际 Windows 证据，缺失不能标绿。

**验收**：原 #46 八条验收逐条有当前提交、命令/步骤、观察值、平台及关联产物；外部验证链接到真实证据。M4 自主验收与 M5 联验分别记录，不减少 issue 的原要求。

## 全程约束

任一阶段失败均先停止下一阶段，保留原失败及资源所有权，修复或回退本次代码变更；不删除用户状态、不重建身份、不自动安装/重试 Run。不因某项属于旧实现就迁移其缺陷，也不把其他项目的全部整改并入 #46。新增明确缺陷按责任修复并补针对性测试。

milestone 是交付和验收边界。用户最新授权包含 Git commit、push 和正式 PR；不包含合并、发布或删除用户状态。
