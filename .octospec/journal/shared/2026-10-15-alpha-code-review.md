---
type: Journal
title: Runtime 当前代码 Alpha 发布前评审
description: 记录 Alpha 评审及用户对齐后的纯执行代理目标、修改路径和异常场景防泄漏验收标准。
tags: [review, runtime, testing, identity, session]
timestamp: 2026-10-15T00:00:00Z
---

# 评审范围与发布意见

按用户要求，以当前代码作为 Alpha 待发布产品评审，不比较历史提交，也不将历史设计作为验收条件。范围包括当前全部已跟踪代码和未提交实现；记录时 HEAD 为 `a2a62a66b5b70abc749794f76c1c41f292639759`，该提交号仅标识快照基础，不代表未提交内容已入库。

采用 code-review 技能，Standards 与 Spec 由两个独立子 Agent 并行审查。用户已将技能默认的固定点 diff 评审改为当前完整工作树评审。依据是当前有效的 AGENTS、规则、README 和 INTEGRATION；不追溯旧方案，不将仅有设计的功能视为已交付。仓库未提供 `docs/agents/issue-tracker.md`，未关联外部需求单。

建议修复以下两项 P1 后再发布 Alpha；渠道长期运行前也应修复 P2。结论来自风险抽查和现有测试，不代表逐行穷尽全部 Provider、平台和安装方式。这里只提交评审意见，未修改产品代码。

本记录后续按同日用户澄清更新：AdapterHost 是纯执行代理，只持有在途状态；Session ID 可传入或默认生成，不代表长期会话对象。下文“对齐后的修改目标”是本次新增的实施依据，取代本记录原先“按 24 小时 TTL 重建 Session、保留后台重放窗口”的建议。仓库规则仍有源窗口与 TTL 的现状描述，实施时须同步修订，不能把本次目标写成已经实现。

## Standards

### S1 [P1] 已有无效身份文件会被重建，缺失或错误类型的 Runtime ID 也能通过

- 位置：`packages/octo-runtime-daemon/src/runtime/identity.ts:18`，校验位于第 20 至 24 行，初始化与写盘位于第 28 至 34 行。
- 触发：已有 `identity/runtime.json` 内容为 JSON `null`。`saved && ...` 跳过验证，随后 `saved ?? ...` 生成新 Runtime ID，`if (!saved)` 覆盖已有文件。若对象的 schema、profile、space 正确，但遗漏 `runtime_id` 或传入数字 `123`，正则会将其转换为字符串进行匹配并接受。
- 影响：无效状态被当作首次安装，启动时悄悄更换身份；另一条路径则允许缺失或错误类型的身份继续流转。即使不考虑历史兼容，这也违反当前安装实例的稳定身份约束。
- 规范：[本地身份合同](../../rules/runtime-lifecycle.md)要求身份不合法时明确失败；[基础架构](../../rules/architecture.md)要求已有 Runtime 身份的重新初始化须有当前任务明确授权。这是硬性规范违规，不是代码气味判断。
- 建议：以 `unknown` 读取并验证非 null 对象和各字段类型；严格区分文件不存在与文件存在但无效，仅前者允许初始化。
- 证据：主评审使用当前构建产物，在新建临时目录调用真实 `ensureLocalRuntime`，三种输入均被接受：`null` 导致文件被替换，缺失 ID 返回 `undefined`，数字 ID 返回 `number`。临时目录已清理，未接触现有 Home、profile 或凭据。

本轴未报告缺乏明确实际影响的气味，也未把 lint 已覆盖的格式问题列为发现。

## Spec

### F1 [P1] 消费者结束迭代后，未经 Provider 确认便记录 cancelled 终态

- 位置：`packages/octo-runtime-adapter-host/src/host-run-service.ts:180`，关键逻辑位于第 180 至 188 行。
- 触发：调用方在首帧后关闭 `invokeFrames()` 迭代器。`finally` 忽略 `cancel()` 返回值及异常，直接追加 `state=cancelled`。
- 影响：查询和源流重放显示已取消，但 Provider 工具可能仍在执行副作用。这里把取消命令回执提升成了执行终态。
- 需求原句：[本地执行合同](../../rules/local-execution.md)规定“invoke、cancel、respond 的命令回执只证明相应操作被接纳，不证明 Provider 完成或已退出”；[输出协议](../../rules/output-protocol.md)要求按 Host 控制事实维护终态。
- 建议：在有截止时间的取消及资源清理阶段等待真实完成事实；失去确认能力时报告 `lost` 或等价的明确错误，不制造取消成功证据。清理结束即移除在途状态，不转入长期后台跟踪或终态缓存。
- 证据：Spec 子评审对构建产物使用进程内 fake transport，令取消返回 `{cancelled:false}`；首帧后执行 `stream.return()`，随后 `get(runId).terminal.control.state` 仍为 `cancelled`。

### F2 [P2] IM 会话调度条目不释放，累计 128 个历史会话后拒绝新会话

- 位置：`packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts:228`，容量判断及插入位于第 228 至 240 行；WeCom 对应第 231 至 243 行。
- 触发：进程生命周期内依次出现 128 个不同业务会话。两包 `#sessions` 只在 `close()` 清空，已完成执行的会话继续占槽；已有条目直接复用，不重新查询 session-store 的过期状态。
- 影响：全部会话闲置后，第 129 个新会话仍持续得到 `IM_SESSION_CAPACITY_EXHAUSTED`，需要关闭并重启渠道才能释放。容量变成累计接待次数限制，而非当前工作量。
- 对齐后的依据：用户明确要求只保留当前工作的执行状态，结束后释放，不设 Session 数量上限。原先引用[会话合同](../../rules/session-reset.md)建议补齐 TTL 检查，现已撤回；业务可能连续使用同一 Session 三天以上，缓存淘汰和时间流逝不构成业务 Session 结束的依据。
- 建议：回收闲置编排对象，取消 128 个累计会话的门槛；业务需要的会话映射、Provider binding 和 reset 代次由业务调用方或 Channel 业务层管理，不搬入 AdapterHost，不新增通用会话缓存或持久化模块。
- 证据：Spec 子评审在进程内替换 Octo transport 启动入口并使用 fake Host，依次完成 129 个不同会话，仅 128 次进入执行，随后报告容量耗尽。进程内时钟推进 25 小时后，首个会话仍使用原 `agentSessionId`。WeCom 已交叉检查同构源码，未单独动态复现。

其中“25 小时仍复用原标识”仅保留为原始观察，不再单独判作缺陷；新目标允许业务长期复用同一标识。

**F2 后续修复状态（2026-10-15）**：已移除两种 Channel 的累计 128 会话门槛，队列闲置后回收调度对象；卡片重试重新进入当前队列。每天一万个会话的验证与局限见 [修复记录](2026-10-15-im-session-scheduling-release.md)。本次仅关闭 F2 的调度条目问题，以下完整 AdapterHost 代理化目标、F1 及 S1 不据此标记完成。

### 修正状态追加（2026-10-15）

| 项目 | 当前状态 | 证据与剩余边界 |
| --- | --- | --- |
| F2：累计 128 个聊天后无法接待新会话 | 已修复并验证 | Octo、WeCom 各完成模拟每日 10,000 个不同会话，逐轮调度条目归零；reset、排队、失败、旧卡片重试和关闭回归通过。 |
| F2：历史调度对象的内存累积 | 当前负载验证通过 | 预热后至第 10,000 次强制 GC 的堆增量分别为 -1,073,136 / +8,128 字节，未超过 8 MiB 门槛；不据此承诺所有 Provider 的 RSS 或无限并发上限。 |
| F2：线上测试环境验证 | 部分链路已验证 | im-test 真实 Bot 认证及 WS 建联，真实 Host 子进程完成 150 次本地注入输入；未执行真实 IM 用户发消息或真实 WeCom 联调。 |
| S1 / F1 | 本任务未修复 | 身份校验和取消终态失真继续保持未完成，不能随 F2 一并关闭。 |
| 完整 AdapterHost 无历史缓存、防失联泄漏目标 | 待实施 | 源流窗口、RPC 恢复及所有 Adapter 的极端故障验收仍按下文目标推进；本次不修改其完成状态。 |

本轮全量构建与测试为 759 通过、7 跳过、0 失败，lint、命名、类型与 OKF 检查通过。默认业务 binding store 的容量/期限保持现有合同；调度条目释放不等于长期业务 binding 已完成重新设计。

## 对齐后的修改目标

### 责任与生命周期

1. AdapterHost 只代理本轮 `invoke()`：准备请求、调用 Adapter、转发 native/canonical 事件、处理交互与取消、清理资源。两种模式采用同一释放合同。
2. `sessionId` 有值时使用调用方值；省略时通过统一输入准备入口生成 UUID，并在回执或事件中返回实际值。协议已有 ID 格式、身份和权限校验继续执行；未知或错误输入不能因默认生成而被掩盖。
3. Session ID 只是关联标识，不建立历史 Session 注册表。同一 Session 可连续使用三天或更久，也可同时有不同 invocation；在途状态以 invocation ID 唯一标识，活动 Session 列表是从在途执行派生的去重视图。
4. Provider binding 由调用方提供，Provider 返回的新 binding 交还调用方。AdapterHost 不按 Session ID 补齐 binding、背景、Context 或历史，不决定长期会话过期和 reset。
5. 仅保留在途执行及清理期间必需的数据。正常终态或明确失败后完成清理，删除请求、帧、交互及资源引用；不得等待 120 秒 TTL，也不归档已完成 Run。清理中的执行仍在活动列表，以免提前显示设备空闲。
6. 不设置历史或并发 Session 个数上限。提供活动查询：去重的 Session ID 列表、Session 数量、执行数量，必要时按 invocation 展示执行中/清理中。查询不返回输入、Token、Context 或历史终态。
7. 防泄漏指内存不随已结束调用数量增长；并发执行本身会消耗内存，不承诺无限并发下固定 RSS。单帧、解析长度和在途输出缓冲仍可有字节边界与背压，不能以“不限 Session 数量”为由变成无限队列。

### 具体修改路径

| 模块 | 修改内容 |
| --- | --- |
| `packages/octo-runtime-adapter-host/src/host-run-service.ts` | 移除已完成 Run 留存、历史帧数组、120 秒 TTL 和 128 Run 门槛。保留 invocation 级在途注册、实时流和幂等清理；活动查询从当前注册项派生，不另建 Session 缓存。 |
| `packages/octo-runtime-adapter-host/src/rpc.ts`、`index.ts`、`process.ts` | 收敛接纳中、执行中和清理中的退出处理；RPC EOF、error、exit、写失败、取消响应丢失均终结对应等待并触发清理。校验首帧前失败也能注销；不得无限等待 generator.return 或取消 ACK。 |
| `packages/octo-runtime-daemon/src/server.ts`、`runtime/run-stream.ts`、`runtime/daemon-runtime.ts` | SDK、daemon、Host 同步改为在途流合同。删除对完成后 get/subscribe 重放与丢 ACK 自动续流的依赖；失联明确失败/结果未知，不能透明重新 invoke。业务历史和可靠投递由调用方实现。 |
| `packages/octo-runtime-core/src/invoke-input.ts` 与公共输入合同 | 核对现有 Session 默认生成入口，保证所有入口传值则使用、缺省则生成且结果可获取；避免 SDK、Extra 和 Host 多层各自生成不同 ID。 |
| `packages/octo-runtime-adapter-codex/src/app-server.ts` 及其他 Adapter/SDK | 核对请求 Promise、进程、管道、交互、取消和超时的资源归属；异常退出拒绝所有受影响的等待。单次失败不关闭其他执行共用的连接或进程；共享传输死亡则明确失败全部受影响执行。 |
| 两个 `extra-channel-*/src/application/im-channel.ts` | 去掉累计 128 会话门槛，执行和队列闲置后回收调度对象。卡片 retry/cancel 回调通过当前 invocation/key 查找，不能长期捕获已回收 session、消息和执行材料。业务 Session/binding 仍由 Channel 作为调用方决定，不能依靠 Host 缓存。 |
| `.octospec/rules/`、`INTEGRATION.md`、样例及测试 | 同步更新 stateless、local-execution、output-protocol、session-reset、invoke-input 等受影响合同。旧缓存/重放测试改为在途代理验收；Run=7 与 Context=v3 不机械升级，实际 RPC 合同改变需联动全部消费者，不能混用后静默降级。 |

采用每次 invocation 的统一、幂等清理路径：登记资源及所有权，异常或终态只进入一次清理；解除订阅并停止继续入队，终结 pending Promise/交互，以截止时间取消和回收本次拥有的进程，释放缓冲和引用，最后注销在途记录。清理自身失败也必须执行剩余清理，并向调用方报告真实失败。

不能通过清空整个 Map 掩盖仍运行的工具；不能为了注销本次执行而终止共享 Gateway 或其他 invocation 的资源。远端 Provider 失联后无法保证远端副作用停止，应报告结果未知并清理本地资源，不能声称远端已经取消。

### 极端场景验收标准

以下为待实施的验收要求，本次文档更新未执行这些验收。自动化用可控 fake Provider 和真实子进程/IPC 注入故障，不调用真实模型。建议 CI 设清理总截止时间为 10 秒；若具体 Adapter 必须不同，应在实现前写明有界预算，并用其实际预算断言。该预算针对取消和故障清理，不给正常长任务设置 10 秒或 24 小时执行寿命。

| 场景 | 必须通过的断言 |
| --- | --- |
| 顺序完成 10,000 次调用，每次不同 Session ID | 全部可执行，不因累计 128/1024 次拒绝；每轮清理后在途数为 0，无已完成 Run、Session、帧或输入留存。 |
| 同一 Session 持续跨三天调用；模拟时间越过 24 小时 | 使用调用方原标识及显式提供的 binding；不因时钟推进换 Session、补背景或取历史缓存。正常长任务不被清理预算误杀。 |
| 同一 Session 的多个 invocation 并行 | 活动 Session 去重计数为 1，执行计数等于实际 invocation 数；结束一轮不移除其他轮，全部完成后两类计数均归零。 |
| 在资源允许的测试机并发运行超过 128 个轻量 fake invocation | 无 Session 个数硬拒绝；活动列表准确。停止后全部注销，不用历史缓存容纳结果。此项不要求真实模型提供同等并发。 |
| 省略或显式传入 Session ID | 缺省调用产生可获取且不同的 UUID 标识；显式值保持不变；错误值仍按协议拒绝。 |
| Provider 在 spawn 后、首帧前、输出中、交互等待中崩溃 | 每个阶段都在清理预算内结束调用并注销；所有 pending 等待有结果，无遗留进程、管道和交互；不得发布成功。 |
| Codex Adapter 连接断开；Host IPC EOF/error；AdapterHost 被 SIGKILL | 受影响调用全部明确失败或结果未知，活动列表收敛；无悬挂 Promise、自动重复执行或无限重连积累。验证孤儿清理机制能回收本次拥有的本地后代进程。 |
| 取消 ACK 返回 false、抛错、丢失或永久不返回 | 不伪造 cancelled；有截止时间地回收本地拥有的执行资源，调用最终结束，状态注销。远端执行结果无法证实时明确 unknown/lost。 |
| 工具和孙进程忽略 SIGTERM，或子进程继承管道令 EOF 不到达 | 宽限期后升级强制终止本次拥有的进程树，关闭管道；在预算内结束，不只杀父进程。外部共享服务不在终止范围。 |
| 消费者提前 return、SSE 断开、SDK AbortSignal 中止 | 取消和清理最终完成，不等待消费者继续读取；不会留下无人消费的执行或后台事件数组。 |
| 消费者永不读取，Provider 持续高速输出 | 背压或明确的流失败策略生效；每执行缓冲有可测字节上限，不无限 push。取消后无需先排空全部输出即可释放。 |
| Provider 单帧超限、畸形 JSON、缺失终态、重复终态、终态后迟到事件 | 明确报协议失败；终态和清理最多一次；迟到事件不重新创建状态，不出现未处理 rejection。 |
| 终态、取消、IPC close、timeout 同时到达，循环 1,000 次 | 不重复 resolve/reject、不重复关闭资源、不删除其他 invocation；没有 uncaughtException、unhandledRejection 或监听器增长警告。 |
| 关闭 Host 时有初始化、执行、交互和清理任务同时存在 | 拒绝新 invoke，终结在途等待；在关闭预算内释放本地拥有资源、清空活动状态并退出；失败不无限阻塞 shutdown。 |
| 两个独立 invocation 共用连接，其中一个失败 | 若底层连接仍健康，另一执行不受单次清理影响；若共享连接死亡，所有受影响调用均结束，其他独立连接继续工作。 |
| Channel 顺序接待 10,000 个聊天，包含 reset、排队和卡片 retry | 无累计槽位耗尽；闲置调度对象回收；同聊天顺序、代次隔离、取消及 retry 仍正确，旧回调不复活已回收对象。 |

### 防泄漏证据与发布门槛

- 测试必须同时观察 SDK、daemon、AdapterHost 和所拥有的 Provider 进程，不能只看一个 Map 或父进程 RSS。记录活动执行、RPC pending、交互、订阅、缓冲字节、计时器/监听器、文件描述符和子进程数量；常驻共享资源单独列明基线。
- 单轮验收：调用关闭及清理预算结束后，上述每次执行拥有的资源全部归零；常驻共享资源回到预热基线。完成后通过活动查询找不到该 invocation；同 Session 其他在途执行仍可查询。
- 耐久验收：预热 1,000 次，再执行 10 批、每批 1,000 次混合成功及故障调用。在隔离测试进程使用 `--expose-gc`，每批结束强制 GC 并取样，检查 heapUsed、external、arrayBuffers、RSS 和句柄趋势；同时保留 heap snapshot/retaining path 作为失败定位证据。
- 建议自动化内存门槛：以各进程预热后数值为 B，最后三批 GC 后 heapUsed 中位数不超过 `B + max(8 MiB, B × 10%)`；对象与资源计数不得随历史调用累积。RSS 受分配器高水位影响，不要求逐轮下降；若持续随批次增长或任何资源计数不归位，即使 heapUsed 门槛通过也判失败，排查 native/external 引用。
- 真实验收必须连接 `https://im-test.deepminer.com.cn/`：经实际 SDK/Channel 触发只读工具执行，覆盖 Codex 连接故障、IPC 中断、取消和恢复后的下一次调用；核对活动列表、错误回执及进程清理。禁止以发消息或写业务数据制造测试副作用，不记录凭据。仅 fake 验收通过不能替代线上测试环境证据。
- 交付前执行 lint、typecheck、相关故障测试及全量测试。RPC/执行链路改变后同步构建并重启受影响的 Runtime 和桌面进程；若触及共享 Run/Context 协议，按规则同步 Worker 构建及注册执行验证。未完成项必须列明，不能把此次文档对齐写成防泄漏已经达标。

## 验证范围

| 检查 | 本次结果 |
| --- | --- |
| `pnpm test`，包含完整 workspace build | 通过；751 项，744 通过、7 跳过、0 失败 |
| `pnpm lint` | 通过 |
| `pnpm exec tsc -p tsconfig.json --noEmit`，在上述构建后运行 | 通过 |
| `uv run --with pyyaml python .octospec/scripts/lint.py` | 通过；50 个 OKF 单元、19 条规则、458 个本地链接 |
| 身份文件复现 | 当前 dist + 临时目录，真实文件读写 |
| 取消与会话复现 | 当前构建产物 + 进程内隔离替身 |
| 真实 Provider 与 im-test 联调 | 未执行，不将本地替身证据当作线上验收 |

上表为最初评审时的检查结果，不是新增目标的实施验收。跳过项为需要显式开启的真实 Codex 图片、envs、finalization 及 Claude/Codex/Kimi/MCode MCP 测试。自动化通过没有覆盖上述新增发现，也不能证明所有 Provider 的真实执行链路可以发布。此次仅更新评审文档；未修改产品代码、执行协议、重启现有服务或改动运行时状态。

汇总：Standards 1 项，最高 P1 为身份校验与静默重建；Spec 2 项，最高 P1 为取消终态失真。
