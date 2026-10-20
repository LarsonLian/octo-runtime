---
type: Assessment
title: Issue 46 开发计划可执行性评审
description: 评审模块和故障边界、milestone、验收可行性、迁移及依赖，不以代码完成率评分。
tags: [architecture, executor, assessment, testing]
timestamp: 2026-10-20T00:00:00Z
---

# 结论与评分

实施状态更新：以下 94 分是规划阶段的评审记录。用户授权后已完成本机 Core 检查点；R3 的关闭消费映射和失败测试通过，R1/R2 与跨平台证据仍待补。实际结果见 [实施记录](implementation.md)，不以这份评分代替验收。

**当前开发计划可执行性：94/100。** 评审对象为本次补全的 [M0–M5 开发计划](plan.md)、[设计](design.md)和[验收矩阵](acceptance.md)，不是 issue 写得好不好。此前对 issue 原文给出的 84 分不再用于计划结论。

判断问题是：开发者能否明确每阶段改哪里、做到什么程度、如何证明通过，以及失败后如何继续。代码尚未编写、计划内测试尚未执行均不扣计划分；没有明确验收方法、缺少跨任务交接合同才扣分。分值为人工工程评审，非统计测量或可靠性保证。Issue 快照更新时间为 `2026-10-20T02:19:23Z`。

| 维度 | 满分 | 得分 | 判断 |
| --- | ---: | ---: | --- |
| 模块与责任边界 | 20 | 20 | Core/临时传输壳/Kernel/Adapter/业务归属及逐文件去向明确，禁止双实现和默认去隔离。 |
| 状态、故障与资源边界 | 20 | 18 | direct 接纳/取消/终态/关闭已细化；新 Kernel 丢失源的共同 fixture 尚待 R1。 |
| Milestone 可交付性 | 20 | 20 | M0–M5 均有进入条件、改动、产物、通过标准和失败处理；迁移与最小接线在同阶段完成。 |
| 验收标准可行性 | 20 | 18 | D01–D18 提供故障注入与断言；M5 的实际 SDK/IM 入口和脚本仍需 R2 具名。 |
| 迁移、发行与回归 | 10 | 10 | 覆盖依赖/runner/exports/声明/tarball/三平台、旧缺陷基线和状态保护。 |
| 依赖与交接 | 10 | 8 | M4 自主交付和 M5 联验无循环；shutdown 新结果对旧关闭链的承接需 R3。 |
| 合计 | 100 | 94 | 剩余 6 分只对应下列三项可定位的交接缺口，不是笼统“后续完善”。 |

## 原计划确实不够执行的地方

原计划写了“固定合同、迁移 Core、补齐回归”，但未说明怎样判定完成，也未处理以下实施分歧；这些不是文档篇幅问题：

1. **包与进程混淆**：旧 adapter-host 整包移动会把 RPC/进程/窗口带进 Core；旧 core 先删而消费者未接回，会产生不能构建的中间 milestone。现在 M1 要求唯一实现及原 worker 最小接线一起通过。
2. **接纳早于取消所有权**：`index.ts:359` 已 yield running，Provider 执行到 `:551` 附近才建立 controller；`cancel():905` 此时可能返回 false。现在 M2/D03 明确 receipt 可见前建立控制器，取消后不得启动 Provider。
3. **拒绝却留状态**：`index.ts:280` 写入接纳记录，`:287` 标记 started，`:302` 才校验 streamLimits。现在 D02 要求无效策略接纳前失败且不占状态，不能只验证“抛错了”。
4. **把超时当清理成功**：`shutdown():941` 等到期限就 resolve，不停止新接纳。现在定义关闭门禁、结果快照、并发/再次清理，D11–D12 验证残留不能隐藏。
5. **两处终态权威**：Core 正常收口，而 HostRunService `:164` 在源异常时也可追加 lost。现在明确正常终态与 transport-lost 的所有者和先后，D06–D08/D17 覆盖迟到事件。
6. **验收过于宽泛**：PassThrough parity 不证明 worker 隔离，workspace 构建不证明 tgz 可消费。现在 M3 验真实 PID/NDJSON，M4 验仓库外类型/执行和 OS 专项。
7. **跨项目验收被混为已完成**：原计划没有说明 #47 未交付时 #46 能到哪一步。现在 M4 是 Core 检查点，M5 仍保留原 issue 最终要求，缺证据不关单。

以上保留规划阶段对原基线的静态风险判断；后续已执行的故障回归和修复证据单列在 [实施记录](implementation.md)，不把两种证据混写。

## 当前源码证据

以下行号属于上述基线，迁移后应更新引用。源码存在和测试已编写均不代表本次重新执行通过。

| 证据 | 对实施的含义 |
| --- | --- |
| `packages/octo-runtime-core/src/index.ts:1` 仅导出配置解析与输入准备 | 新 Core 需要吸收执行类，不是旧 Core 原地改名即可。 |
| `packages/octo-runtime-adapter-host/src/index.ts:102` 的 AdapterHost | 已具备 register/list/describe/probe、invoke/invokeFrames、cancel、两种 respond、shutdown，可迁移而非重写。 |
| 同文件 `:1`、`:6`、`:8`、`:1104` | 执行入口同时牵连旧 Core、HostRunService、socket、spawn、serve/RPC 导出，整体移动会把传输带进 Core。 |
| 同文件 `:232`、`:235`、`:287`、`:467` | invocation 记录最多 1024，非活动记录按 120 秒惰性回收；输入准备后清除请求引用，终止后更新时间。不是无限 Map，也不是严格定时 TTL 清扫。 |
| 同文件 `:941` 的 shutdown | 当前取消活动执行并最多等待 2500ms，返回本身不证明全部清理成功，也未建立永久关闭的接纳门禁。不能直接当成完整 direct 生命周期合同。 |
| `packages/octo-runtime-adapter-host/src/host-run-service.ts:1`、`:40`、`:43` | 有界窗口实现依赖 AdapterHostRpc；不能因有 Run 状态就整体移入 Core。 |
| `packages/octo-runtime-adapter-host/src/serve.ts:13` 与 `process.ts:35` | 现有独立 worker 注册、stdio 服务、就绪和进程清理可先接回新 Core，维持默认隔离。 |
| `test/invoke-parity.test.js:52` | 已有 direct 与内存 RPC 的同输入比较；不是独立进程或新 Kernel 的验收证据。 |
| `test/native-host.test.js:458` | 两种模式均明确要求清理失败不能输出成功，必须与终态保护共同保留。 |
| `packages/octo-runtime-protocol/src/stream-limits.ts`、`test/host-stream-policy.test.js` | 新基线已有中央容量策略、每次 invocation 冻结和精确容量错误；迁移不可退回旧 256 KiB 帧与 4 MiB 回放限额。 |
| `package.json`、`public/tsconfig.json`、`scripts/pack-release.mjs` | 内部 workspace 包为 private，根发行物仅公开 extra/protocol 等入口；内部包存在不等于外部宿主可直接 import。 |
| `scripts/verify-release.mjs:338` | 现有发行验证主动拒绝旧内部 Core 的直接导入，新增公开能力要更新正向验证，不能简单删除负向保护。 |

## GitHub 基线复核

最初误用落后的本地 `957c9b4`，现已 fetch 并将新 worktree 更新到 GitHub `main` 的 `7fb81e9`。两者相差 166 个文件，已经重新核对与本任务有关的容量策略/错误信封、Windows IPC/manifest、发行及规则差异；旧基线的容量数值和源码行号不再作为本计划依据。

当前默认 Provider 消息 16 MiB、HostFrame 20 MiB、Adapter/RPC 队列 32 MiB/4096 项、每 Run 回放 32 MiB/4096 帧、全局回放 128 MiB；受信策略可覆盖但每项不超过中央默认两倍。源码版本占位为 `0.0.0`，正式版本由发行流程注入。Channel 模型前固定准备有界历史仍归业务入口，不搬入 Core；D14/D18 覆盖迁移保护。

## 剩余 6 分在哪里

| 编号 | 扣分 / 所在阶段 | 缺的具体产物 / 补分条件 |
| --- | --- | --- |
| R1 | 2 分，M0 交接 / M5 进入条件 | #47/#51 共同 fixture：源终态尚未到父进程时 worker 丢失，父进程如何使用最后已接收 seq 收口；终态已接收而 ACK/订阅丢失时如何避免第二终态。需固定输入帧、允许结果与错误/查回语义，不能只写“真实终态”。现有 Core 本地规则可先实施，不等待 Go 完成。 |
| R2 | 2 分，M5 联验可操作性 | #50 需具名一个实际维护的 SDK 宿主及版本、安装/启动入口、IM 测试会话和可重复步骤，给出脱敏证据模板。当前仓库没有该宿主的已选 fixture，不能声称“真实 SDK 验收”已可直接运行。只影响最终联验，不阻塞 fake/worker/tarball 验收。 |
| R3 | 2 分，M0/M2 生命周期承接 | 新 shutdown 结果需由旧 serve/调用者判定 incomplete，不能因 Promise resolve 就 exit(0)；与 #13 明确仍活动资源的所有权和未决清理等待。失败 finalizer 不可通过重复 return 重试，见 PR 52 整改记录。需列出受影响调用点及失败用例，确认不把 Core 的 CLOSED 当成宿主锁可释放。无需等 #13 全部整改，但开始生命周期改动前要完成此映射。 |

补到 100 分的证据是共同 fixture、真实宿主联验步骤和 shutdown 消费映射，不是先把产品开发完成。当前可以推进 M0 和明确的本地迁移；M2 前补 R3，M5 前补 R1/R2。任何 milestone 的必选验收失败都不通过，即使整体计划评分较高。

## 主要风险

- 旧 index 的传递导出造成 Core 间接导入 RPC/launcher；用依赖图和独立 import/执行测试验证，而非仅搜索文件名。
- 只替换 imports 会漏掉 runner、fixtures、包依赖、打包脚本及发布负向测试；各步骤保持原 worker 可启动。
- 同进程 Adapter 的 process.exit、OOM、同步死循环无法靠 try/catch、AbortSignal 或 Core watchdog 隔离；共享 worker 崩溃也会影响其中其他 Run。
- Adapter 返回失败或清理超时应收敛本次调用；不能声称超时 Promise 已强制停止任意 JS 代码或已回收所有后代。
- 修改全局规则前要区分旧实现与新目标；历史规则仍有“实例只能在 Host 子进程创建”的表述，本任务只增加显式 direct 选择，默认生产隔离保留。

## 本轮验证范围

规划时已读取基线源码、相关测试、#46/#47/#51 正文、规则及发行脚本；worktree 基于当时已 fetch 的 origin/main，不混入原目录未跟踪工作。

规划时执行 `uv run --with pyyaml python .octospec/scripts/lint.py`：失败于 14 处既有跨仓库链接。默认 python 缺少 PyYAML，改用 uv 临时依赖运行，无仓库依赖变更。实施后的实际检查见 [验收](acceptance.md)与[实施记录](implementation.md)。未调用真实模型或变更线上环境和用户运行状态。
