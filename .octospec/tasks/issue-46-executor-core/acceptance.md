---
type: Acceptance
title: Issue 46 分阶段验收与证据清单
description: 将 Core 自主验收、现有 worker 回归及新 Kernel 联验分别记录。
tags: [executor, testing, lifecycle, protocol]
timestamp: 2026-10-20T00:00:00Z
---

# 本轮评估与文档检查

- [x] 新建独立 worktree，fetch 后更新为 GitHub `origin/main` 的 `7fb81e9`；分支 `refactor/46-executor-core`，原目录未跟踪工作未混入。
- [x] 按用户澄清重做 [开发计划可执行性评审](assessment.md)：评估 M0–M5、边界与验收，当前 94/100，不以代码完成率评分。
- [x] 建立 brief、设计、评估、验收及规则来源记录；公共接口已在本机工作树实现和验收，尚未发布。
- [x] 新基线下 5 份 OKF、context YAML、规则 ID、源码路径、相对文件链接、评分加总、未跟踪 Markdown 空白检查通过；origin URL、HEAD=origin/main 和 refactor 分支复核通过。
- [x] 修改后全仓知识校验复查，仍仅报告与修改前相同的 14 处跨仓库相对链接失效；没有新增报错，不能记作全仓校验通过。

## A：Core 独立交付检查点

以下 Core 本机检查点已经实施并通过；实际命令、初次 17 项及评审整改 21 项新增回归对应见 [实施记录](implementation.md)。三平台 CI 与新 Kernel/真实业务证据继续单列，不能用本机检查替代。

| 编号 | 必须观察到的结果 | 测试方式 / 既有参考 |
| --- | --- | --- |
| A1 | 使用公开模块创建 AgentExecutor、显式注册 fake Adapter，直接流式执行、取消、canonical/native 回答；无 Kernel/socket/云账号 | 增加外部消费者编译与执行 fixture，检查进程/端点/全局监听副作用。 |
| A2 | 唯一准备保留 defaults/mandatory、身份、权限、审批、32 MiB 请求预算；signal 不序列化、输入不被改写 | invoke-input、invoke-size-budget、invoke-parity、adapter-permission-modes。 |
| A3 | native/canonical 保留载荷、receipt 身份与连续 seq；不支持模式在接纳前失败 | native-host、host-message-identity、协议正反 fixtures。 |
| A4 | 同会话空业务 Context、变化项、跨 Event 重复、顺序、图片/恢复输入均按本轮传递；执行配置不进模型 | model-context、context-extension、model-input 与 envs 相关回归。 |
| A5 | Provider 启动/退出失败、Adapter 同步 throw/异步 reject、无效/超大帧、缺失/重复终态均真实失败；兄弟及后续调用可执行 | adapter-failures、acp-transport-failure、native-host；对缺失场景新增 fault fixture。 |
| A6 | 提前取消不启动 Provider；活动取消/消费停止执行清理；完成后取消不覆盖终态；候选成功但清理失败不能成功 | invoke-parity、native-host:458、watchdog、process-group-cleanup；双模式竞态验证。 |
| A7 | 1024 记录边界、接纳中/未消费/结束状态、120 秒惰性淘汰与释放；关闭门禁/并发 shutdown/超时残留明确 | 增加 fake clock/容量与生命周期测试；不将序列化限额当 RSS 保证。 |
| A8 | 新 Core 不导入 IPC/RPC/worker/Extra/默认 Adapter；原 worker 仍独立运行并委托同一实现 | 依赖守卫、原 runner 真实子进程测试；现有 PassThrough parity 只作单元证据。 |
| A9 | 主发行物新增公开 Core 入口可被仓库外 Node/TS 工程使用；旧内部路径保护继续有效 | pack:release、更新 verify-release 正向 fixture，在隔离临时目录消费 tarball；仅生成/本地安装，不发布。 |
| A10 | 中央容量策略、受信覆盖、每轮冻结、大帧、精确非重试错误与安全 failure 测量在 direct/worker 一致；策略不能由业务 Context 升权 | stream-limits、host-stream-policy、host-stream-transport、host-capacity-diagnostics、provider-buffer-limits；保留 #21 既有能力。 |

按 M0 的合同与基线执行构建/type/lint 与定向测试；跨包迁移再执行全量回归。按现有脚本 `pnpm typecheck` 会构建，`pnpm test` 也会构建，可复用一次构建后用 `pnpm test:suites` 验证，避免无意义重复：

```sh
pnpm typecheck
pnpm lint
pnpm lint:names
pnpm format:check
node --test test/invoke-input.test.js test/invoke-parity.test.js test/native-host.test.js test/model-context.test.js test/adapter-failures.test.js test/watchdog.test.js test/host-run-service.test.js test/stateless-executor.test.js test/process-group-cleanup.test.js
node --test test/stream-limits.test.js test/host-stream-policy.test.js test/host-stream-transport.test.js test/host-capacity-diagnostics.test.js test/provider-buffer-limits.test.js test/adapter-host-manifest.test.js test/runtime-endpoint.test.js
pnpm test:suites
pnpm pack:release
node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-0.0.0.tgz
```

命令按迁移后的实际文件名同步，tarball 使用 pack:release 实际输出路径。源码 `0.0.0` 仅作本地打包验证；正式 annotated tag 注入发行版本，不修改源码版本或在本任务发布。记录平台、基线、成功/失败/跳过及清理证据，不沿用历史通过数量。

## B：跨任务最终验收

- [ ] #47 新 Kernel 的独立 execution worker 使用同一 Core；两种模式下 direct、现有 worker、新 Kernel 对等输入语义一致。动态 streamId/时间可按显式规则比较，不能抹掉身份错误。
- [ ] #47/#51 固定 ACK、首帧、最终终态与 worker 丢失的先后；订阅断开不取消、显式取消才取消，重连不重新 invoke。
- [ ] #47 记录进程崩溃/阻塞/重启与 collateral Run 失败；不能用 direct 的异常测试声称具备进程容错。
- [ ] #14/#47 记录 Windows 原生证据；POSIX 通过不代替 Named Pipe/后代回收验证。
- [ ] #50 在测试环境 `https://im-test.deepminer.com.cn/` 及真实 Provider 验证消费迁移、身份/Home/profile/配置保留与安装产物；凭据不进入文件或输出。
- [ ] 如果实际改变 Run/Context wire 合同，同步构建 Worker/Runtime/桌面并重启受影响本地实例验证；仅移动代码且合同不变时不机械升级版本。

Core 检查点完成可供下游开工；B 未完成时 #46 的新 Kernel 原始验收仍未满足，不标记全量完成或可靠性 100%。

## D：可执行场景矩阵

下表是计划要求；已执行的本机场景、复用测试和未完成部分逐项映射到 [实施证据](implementation.md#d01d18-证据对应)。既有用例覆盖的内容迁移复用，不为每项机械新增同义测试。D17 的新 Kernel 分支和 D18 的原生 Windows 结果仍待补。

| ID / milestone | 注入或操作 | 必须断言 | 可行的执行方法 |
| --- | --- | --- | --- |
| D01 / M1 | 纯 Node 直接 import Core，注册双模式 fake Adapter | 不启动 Kernel/socket/worker、不增进程信号监听；真实模型输入不被改写 | 进程隔离的 import/执行 fixture，父进程核对句柄和子进程；对比注册前后监听器。 |
| D02 / M2 | 非法 input、mandatory 冲突、无权限、无效 streamLimits、超限请求分别接入 | Provider 启动数为 0，无 receipt 或 started 残留；修正请求后同 ID 可正常接纳 | 受控 Adapter 计数；拒绝后用同一身份提交有效请求，避免读取私有 Map。 |
| D03 / M2 | 取到首个 running 帧后暂停，不推进第二帧，立即 cancel；另测 signal 和 shutdown | 取消能定位 invocation，之后 Provider 启动数仍为 0；推进流时唯一 cancelled；记录可释放 | 手工 next 的 iterator + 显式闩锁，不用 sleep；区分取消接纳与终态帧交付。 |
| D04 / M2 | 同 ID 并发调用、同 runId 不同 invocation、重复消费 | 只一个执行被接纳；冲突无第二 Provider；同终态窗口内不能重复执行 | 并发 Promise/iterator 闩锁，计数 receipt、Provider 调用和冲突错误。 |
| D05 / M2 | spawn 失败、异步 reject、读取中途退出、无效/错模式/超大输出、无终态 | 错误类别与安全详情保留；已接纳流唯一失败终态，接纳前拒绝无伪 receipt | fake Adapter 加缺失命令子进程 fixture；核对 identity/seq/末帧，兄弟调用完成。 |
| D06 / M2 | Provider 候选 completed 后等待清理，此时 cancel；清理随后成功 | 最终 completed 不被迟到用户取消覆盖，唯一终态，资源已确认清理 | 可控 cleanup Promise；严格控制候选、cancel、清理三个时点，双模式。 |
| D07 / M2 | 候选 completed 后清理 reject/超时，或终态后又输出非法内容 | 不能成功；真实 failed/cleanup_timeout 保留，不能无限等待 | 复用 native-host 清理用例，fake scheduler 测超时；显式清理测试子进程。 |
| D08 / M2 | Provider 已报告 failed，同时取消/清理又失败；已最终交付后再通知故障 | 保留首个有效业务失败及清理诊断；最终终态不被改写或重复 | 双模式竞态表；断言完整错误来源与终态数，不只检查字符串包含 failed。 |
| D09 / M2 | native/canonical 审批与追问；错 invocation、错模式、过期、并发重复回答、写回失败 | 只写回原 pending responder，成功仅在原生写入确认后；终止后拒绝晚答 | fake responder 计数和写回闩锁；全程不用模型或人工审批。 |
| D10 / M2 | 仅创建不消费、读首帧暂停、执行中 return、长时间暂停并推进 TTL | 不消费不占 Core Map；已接纳暂停调用不被误淘汰；return/取消有界清理 | 构造 1024 边界与受控时钟；继续提交探测容量释放，核对无后台 Provider。 |
| D11 / M2 | shutdown 时并发新 invoke/register、两个 shutdown、一个 disposer 失败 | 接纳立即关闭；两次关闭共享当前尝试；兄弟清理均执行，不能短路 | 同一 event-loop turn 调用与 cleanup 闩锁；拒绝新执行且 Provider 启动数不增。 |
| D12 / M2 | 清理在预算内不结束，随后允许结束并再次 shutdown；清理拒绝、finally 抛错/继续 yield 或提前关闭无 return | 首次 incomplete 明确未决 IDs；未决清理真正完成后可 complete；失败/未确认清理持续 incomplete，门禁从未重开 | 可控 iterator.return 与 fake scheduler；真实 TCP listener 验证重复关闭不能伪造释放；子进程验证所有者退出结果，不将 Promise 超时当进程消失。 |
| D13 / M2 | 截止前/后进度、审批等待、工具运行、消费暂停、完成/取消竞态 | watchdog 预算保持现有合同，运行/清理截止不被无关进度延长 | 复用 watchdog 测试与假时钟；超时断言使用配置预算，不新增更短产品默认值。 |
| D14 / M1–M3 | 空业务 Context、保序项、跨轮重复、图片/恢复输入、执行配置与未知可选项 | 同轮数据完整、两轮重复均发送；不补历史；配置/凭据不进模型文本 | 捕获 Adapter 接收请求；复用 model-context/input/权限样例，使用脱敏值。 |
| D15 / M3 | 同一场景经 direct 与真实 worker NDJSON 执行 | 有独立 PID、同一 Core、相同执行输入/事件/终态语义；identity/seq 独立校验 | 复用 fixtures 加真实 child_process；明确可归一化字段，禁止抹掉故障/身份差异。 |
| D16 / M3 | 本次 Provider 启动/退出失败，另一调用并发运行；worker 自身退出 | Provider 故障不杀兄弟；worker 死亡如实影响其中在途调用；不自动重复 invoke | 对专属 fixture PID 发信号/受控退出，记录 Provider 创建计数、兄弟结果、后续就绪事实。 |
| D17 / M3/M5 | 订阅断开再续流、缺口/过期；终态送达前/后 worker 丢失 | 续订不重新执行；断订阅不自动 cancel；已接收最终终态不被 lost 覆盖 | M3 用现有 HostRunService；M5 用 R1 共同 fixture 验新 Kernel，不能互相替代。 |
| D18 / M3/M4 | 阈值内/等于/超出的大帧、队列慢读、不同 Adapter 预算、仓库外 tarball 与 Windows 路径 | 中央预算及错误精确；内存队列有界、无静默裁剪；离线 public export 可消费；Windows 原生启动/关闭 | 复用容量和发行 tests；在现有 CI 加新 Core 定向测试，不能把 macOS 结果记为 Windows。 |

## 证据格式与通过规则

每个 milestone 记录：源码 SHA、平台/Node 版本、输入/fixture、运行命令、预期断言、实际观察、通过/失败/跳过、创建资源及最终清理。没有脚本的真实联验必须有逐步操作及可观察结果，不用“体验正常”代替。

逻辑截止由假时钟验证；真实进程用 waitFor/退出事件和配置的外层超时验证，外层超时只是测试防挂，不表示 Runtime 的承诺时限。所有 fake 只证明通用执行行为，真实 Provider/IM 证据仍单列。同进程死循环/exit/OOM 测试在专用子进程内运行，不能杀测试 runner 或用户 Runtime。

当前 CI 的 Linux/macOS 执行完整 Node/UI，Windows 主要执行发行验收。M4 必须补上本次新的 direct/生命周期专项在 Windows 的原生运行入口；不要求在这个 issue 中把所有历史 Windows 失败一次性修完，但受本改动影响的必选场景失败就不能通过。
