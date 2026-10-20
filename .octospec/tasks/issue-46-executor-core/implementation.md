---
type: Implementation
title: Issue 46 Core 本机交付记录
description: 唯一 Core、生命周期、真实 worker、公开发行入口的实施与证据，保留 Windows 和跨任务联验。
tags: [executor, testing, lifecycle, delivery]
timestamp: 2026-10-20T00:00:00Z
---

# 当前交付状态

2026-10-20，`refactor/46-executor-core`，基线 `7fb81e930675c62897e436828b5a1fcdc8c99f40`。用户已授权提交、推送和正式 PR，交付检查正在进行。
本机为 macOS arm64、Node `v24.19.0`、pnpm `11.19.0`。以下证据属于本次代码，不是规划评分或历史通过数量。

用户进一步确认接入优先级：推荐 SDK 经 IPC 调用独立 ExecutorKernel，稳定性优先，
尤其适用于 Electron 等长期运行的宿主。direct 保留为显式可选的 SDK 内嵌简易方案，
由宿主管理生命周期并承担同进程故障影响。本次同步 README、贡献指南与当前规则，
未改变原隔离默认路径，也未将 #47 的新 Kernel IPC/监督能力记为已完成。

| Milestone | 状态 | 证据 / 剩余条件 |
| --- | --- | --- |
| M0 | 本地合同与消费清单完成 | 下方迁移清单；R3 关闭消费映射已实施并测试；R1/R2 仍为 M5 进入条件。 |
| M1 | 本机通过 | 单一 AgentExecutor，原 worker 接线、类型、构建及原装配回归通过。 |
| M2 | 本机通过 | 接纳、取消、关闭门禁、资源所有权与未决清理等待；新生命周期测试及原失败/超时/终态回归通过。 |
| M3 | 本机通过 | 真实 PID/stdin/stdout NDJSON 双模式对比、交互、取消、worker 丢失；原窗口/容量回归通过。 |
| M4 | 本机交付检查通过；跨平台证据待补 | 主包公开入口及仓库外 Node/TS tgz 验证通过；新增 Windows Core 专项 CI，未运行远端 CI、原生 Windows/Linux。 |
| M5 | 后续关联任务，未进入 | 需要 #47 新 Kernel、#51 共同源丢失 fixture、#50 具名真实 SDK 宿主和 im-test 联验；按用户最新决定，本次 PR 使用 Closes #46，后续联验不作为关闭前置条件。 |

## M0 消费与源码迁移清单

| 入口或资源 | 实施结果 |
| --- | --- |
| 旧 core 的 context / invoke-input | 移至 executor-core；旧 workspace 包、源码与 README 删除，无旧实现或路径转发包。 |
| 旧 host 的执行类 / model-input / experience / watchdog / execution-preparation | 移至 executor-core；唯一类改名 AgentExecutor；原 AdapterHost 导出为同一类的过渡别名。 |
| RPC / serve / runner / process / socket / manifest loader / HostRunService | 暂留 adapter-host 传输包；serve 创建 AgentExecutor，RPC 类型直接引用 Core。没有把 worker 或窗口搬入 Core。 |
| imports / 类型 imports | 原 Core 消费测试和 live 验证脚本改为新路径；host 的传输消费者保留原路径，执行 helper 测试改为 Core。 |
| package dependencies / lockfile | 根、CLI、daemon、两个 Channel 的旧 Core 依赖改为新包；Core 只依赖 protocol 与 adapter-sdk；锁文件无第三方版本变化。 |
| runner URL / 默认 Adapter manifest | 维持原 adapter-host runner、CLI 默认清单及 SDK 代码入口；manifest、Windows 路径与 readiness 原回归通过。 |
| public declarations / exports | 根包新增 `/executor-core`，公开类、必要 Adapter 结构及输入/输出/环境类型；内部包继续 private。 |
| tarball 与 verifier | 生产图自动包含新包；仓库外 fixture 编译和执行 direct，保留内部路径负向保护及原 Extra/CLI 检查。 |
| 规则与知识链接 | 同步 Core 职责和路径触发器；历史记录仅更新失效源码链接目标，不改历史结论。 |

Core 的源码、manifest、公开入口和测试分别见：
[执行实现](../../../packages/octo-runtime-executor-core/src/index.ts)、
[包](../../../packages/octo-runtime-executor-core/package.json)、
[公共入口](../../../public/executor-core.ts)、
[新回归](../../../test/executor-core.test.js)。

## 生命周期实施

输入准备、固定渲染和 streamLimits 校验先于接纳。创建但不消费的 iterator 不写入 Core Map。
首个 next 原子提交身份、controller 与 receipt；首帧可见后 cancel 已有所有者，暂停期间取消不会启动 Provider。
重复 invocation/run 身份拒绝；已接纳暂停调用和未完成清理不按 TTL 淘汰。Core 不保存请求正文或源帧回放。

shutdown 同步关闭新注册和接纳；并发调用共享尝试，默认 2500ms。返回不可变的 complete/incomplete 快照；
未决与失败清理保留所有权，后续调用可继续等待未决清理；失败或未确认清理不重复 return，不能重新开放执行。流的清理沿用原 cancelGraceMs，
不再叠加一个 2500ms 等待。已终态调用不能因尚有资源清理而再次被 cancel，资源仍由独立 owner 记录负责。

候选完成、清理和最终终态保留原合同：清理失败不能完成，迟到取消不能覆盖已接受的 Provider 候选结果。
正常错误不杀兄弟调用；进程 exit/OOM/同步阻塞仍属 direct 宿主故障域。没有新增 Run 自动重放或恢复。

### R3 消费映射

| 调用方 | 如何处理 shutdown 与所有权 |
| --- | --- |
| `serve.ts` 的信号 / stdin end / close | 等待结果并检查 cleanup；incomplete 输出安全诊断、以 exit 1 退出，不能因 Promise resolve 就 exit 0。 |
| `rpc.ts` 的连接错误 | 关闭接纳及传输，记录 incomplete；不声称资源清理成功，不操作 Home 锁。 |
| direct HostApp | 公开说明要求检查结果；再次 shutdown 可观察未决清理，失败不因再次 return 伪装成功；closed 不是释放宿主锁的依据。 |
| 原 daemon 的 worker 所有者 | 保留原 `hostProcess.close()` 的受管进程组回收；不从 Core.closed 推导进程退出。未把 #13 全部关闭、启动失败或锁问题写成本次已修复。 |

新增真实子进程 fixture 让 iterator.return 拒绝，父进程断开 stdin 后观察 worker **exit 1**。
另有假时钟与可控 cleanup Promise 验证 incomplete、迟到清理、快照不变、再次等待及兄弟清理不短路。

## D01–D18 证据对应

场景要求仍保留在 [验收矩阵](acceptance.md)，不机械新增 18 组同义测试。

| 场景 | 本次实际证据 |
| --- | --- |
| D01–D04 | executor-core：公开类严格等于旧别名、无全局信号/传输依赖；拒绝后同 ID 可用；首帧后取消双模式；并发重复身份；invoke-input/权限/大小原回归。 |
| D05–D08 | 真实 worker 双模式 startup throw、无终态与非法 native 输出；adapter-failures、native-host、watchdog、host 既有清理/终态竞态；新测试确认清理失败终态不可再取消，重复关闭仍报告失败归属。 |
| D09 | direct 与真实 worker 双模式回答、错 invocation、重复回答；原审批/原生写入、过期、模式、权限与 responder 失败回归；外部 tgz 原生回答。 |
| D10–D12 | 1100 个未消费 iterator 不占身份；1024 边界与假 Date；暂停调用不过期；shutdown 门禁、共享尝试、假时钟超时、快照、再次清理、兄弟清理；真实 worker exit 1。 |
| D13–D14 | 原 watchdog、model-context、context-extension/envs/MCP、输入与图片恢复回归均通过；无默认值或协议版本变化。 |
| D15–D16 | executor-core 的真实 child PID/NDJSON 对比；只归一化独立 stream_id、经过格式断言的 failure diagnosticId/occurredAt；逐帧校验 identity/seq。worker 受控 exit 23 使在途流拒绝，不在父进程回放。 |
| D17 | 现有 HostRunService、流窗口和 daemon 重启回归通过；新 Kernel 源丢失的 R1 fixture 尚未验证，不用旧路径代替。 |
| D18 | 中央容量、慢读和不同预算原回归通过；仓库外 tgz 编译/执行通过；Windows 原生专项已加入 CI，实际结果未取得。 |

## PR 52 资源清理评审整改

Jerry-Xin 的评审意见成立：async generator 的 finally 抛错后已永久关闭，再次 return
可能直接返回 done:true，不能证明原资源清理成功。以真实本地 TCP listener 复现并修复，
重复三次 shutdown 仍保留 failedCleanupInvocationIds，finalizer 只执行一次。

同类检查还修复了自然 next 拒绝被误判清理成功、finally yield 导致 return 返回 done:false、
提前关闭却无 return，以及取消后放弃 receipt 导致 modes 永久占据容量。清理成功的取消
调用现在释放 modes；最终 Host state 交付前也释放模式记录，canonical 终态事件交付前
结束 Core 包装流，避免消费者在终态处停止 next 导致容量永久占用。streamId 校验阻止
旧 iterator 在 TTL 后影响复用同一 ID 的新调用。
成功或失败清理都会解除 caller/controller 的 AbortSignal 监听。

新增 21 项回归，其中 14 项先在修复前执行并全部按预期失败，再验证修复；另补
真实 listener 成功关闭、无 return 的自然结束、Host/canonical 终态暂停正向用例。覆盖的是 Core 及现有 worker
资源合同，没有引入新 Provider disposal API 或宣称 #47 监督已完成。

限制：现有 AsyncIterator 合同不能区分普通 next 错误与 finally 错误，故保守保留未确认
所有权；incomplete 不等于证实泄漏。失败记录受 1024 上限约束且可耗尽接纳容量，由宿主
或隔离 worker 处理故障域，不通过重复执行 Run、全机扫描或清空记录隐藏问题。

## yujiawei 评审与同类路径整改

评审针对 ae0186f。P1 所述 pendingNext 作为 Promise.race 输入已有 rejection observer，
race 的其他分支先完成不会撤销该 observer；双模式取消/超时后迟到 next 拒绝均无 unhandled。
新增回归保留这一保证，不增加没有必要的空 catch 来伪装修复。

P2 成立：终态后 next、return、catch 分别启动完整 cancelGraceMs；暂停消费者恢复时也会
重新等待。现用 performance.now 的唯一截止时间，候选终态、首次 abort 或清理开始即计时，
所有阶段共享剩余预算。100ms 内 next80+return80 不再完成，next40+return40 正常完成。
deadline 只限制 Core 的等待，不证明底层操作已经停止，pending/failed 所有权合同继续保留。

同类检查发现 NativeInteractionBridge 的自动回复/过期后台 close 拒绝无人观察，以及传输
关闭失败跳过源 iterator.return；现缓存并观察同一次 close，所有独立清理均启动，Promise.all
在已有失败时及时返回且观察其他步骤的拒绝，避免等待阻塞兄弟项才能报错。respond 保留原写入
失败与清理失败。真实 TCP listener 回归确认源资源得到释放，阻塞 return 也不会隐藏关闭失败。

ZCode 的 client.close 拒绝原本跳过 spec.cleanup；现两项均尝试，单项错误原样返回，多项错误
聚合。纯模拟 child 故障注入不发送 OS 信号，并确认原初始化失败事实仍在事件中。

本轮新增 22 项回归（Core预算/迟到拒绝14、Native6、ZCode2），Windows专项一并运行。
修复前已有隔离复现证据；本轮针对性22项已通过。最终全量 Node 1317 项中 1307 通过、
10 跳过、0 失败，UI 35 通过；typecheck/build、lint、lint:names、format:check 和 diff 空白
检查通过。重新 pack-release 与仓库外 verify-release 通过，含公开 Core、离线安装与卸载
保留 Home；构建来源为 ae0186f dirty=true，未执行真实 Provider/IM。最新提交 CI 待推送验证。

## 初次交付检查（cb2e2dc）

| 命令 | 本次结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 最终通过，锁文件可重复安装；无 Provider 安装。 |
| `pnpm typecheck` | 通过，包含完整 workspace 和 public 构建。 |
| `pnpm lint` | 最终通过。中途与 clean/build 并行时声明暂不存在导致错误，改为构建后运行，不修改检查规则以掩盖问题。 |
| `pnpm lint:names` | 通过；修正 worktree `.git` 指针文件被扫描的问题。 |
| `pnpm format:check` | 通过。 |
| `pnpm test:suites` | UI 35 通过；Node 1274 项中 1264 通过、10 跳过、0 失败；含新 Core 17 项。 |
| `node scripts/pack-release.mjs` | 生成本地 `dist/release/mininglamp-oss-octo-runtime-0.0.0.tgz`，未发布。 |
| `node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-0.0.0.tgz` | 最终通过：offlineInstall、publicTypesChecked、publicExecutorCoreChecked、原 CLI/12 Adapter 与三内置 Extra 加载、卸载保留 Home。 |
| `git diff --check` | 通过。 |
| `uv run --with pyyaml python .octospec/scripts/lint.py` | 仍只有原有 14 处跨仓库链接失效；迁移造成的新失效源码链接已修复，不称全仓检查通过。 |

公开 API 的离线编译/执行见 [外部 fixture](../../../test-support/public-extra/executor.mts)；实际发行验证
明确返回 `dirty=true`、`liveAgentRun=not-run`。测试只创建隔离临时 Home 与本次 child process；退出后回收，
没有重启用户 Runtime，没有读取凭据或重建身份/profile/配置，没有改 Run/Context Schema。

## 评审整改本机检查

最终 Node 1295 项中 1285 通过、10 跳过、0 失败，UI 35 通过；Core 专项 38 项。
完整 typecheck/build、整改后的 Core rebuild、lint、lint:names、format:check、diff 空白检查通过。
重新 pack-release 与仓库外 verify-release 通过，包括公开类型/Core、离线安装及卸载保留 Home；
构建标识仍为旧提交 dirty=true，未执行真实 Provider/IM。知识校验仍只有原 14 处跨仓库链接问题。

原提交 cb2e2dc 的 [CI 39365453742](https://github.com/Mininglamp-OSS/octo-runtime/actions/runs/39365453742)
已通过 Windows、Linux、macOS 和 CI Gate；整改后最新提交的三平台 CI 仍待 GitHub 验证。

## 待完成的证据

- 评审整改后最新提交的三平台 CI 结果；上方旧提交结果不能替代。
- #47/#51 新 Kernel 的最终终态前后 source-lost、ACK/订阅查回共同 fixture（R1）。
- #50 实际维护的 SDK 宿主、版本、启动入口和 im-test/真实 Provider 联验（R2）。
- 用户已授权 Git commit、push 和正式 PR 到 main，使用 `Closes #46`，其余 issue 为 Related；实际 PR 和平台 CI 结果以 GitHub 记录为准。未授权合并或发布。
