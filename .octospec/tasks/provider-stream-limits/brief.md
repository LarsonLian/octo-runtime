---
type: Task
title: Provider 输出流容量与错误分类专项规划
description: 修复合法大输出被 256 KiB 固定阈值中断的问题，统一原始消息、HostFrame、队列和展示边界，并保留有界内存与真实错误语义。
tags: [p0, adapter, stream, capacity, protocol, channel, testing]
timestamp: 2026-10-18T00:00:00Z
---

# Provider 输出流容量与错误分类专项规划

## 1. 状态、基线与结论

状态：**已按用户确认的推荐方案完成代码实施、本地验证和 topic branch 提交；PR/合并状态以 GitHub 为准。**

- 规划基线：`main` commit `4fa5a8a536aa815e6a35872748d39a5e98470d27`。
- 外部问题：[GitHub Issue #21](https://github.com/Mininglamp-OSS/octo-runtime/issues/21)。
- 优先级：P0。依据是维护者报告普通 Codex DM 高频中断，且当前代码能够稳定复现合法 Provider 消息因本地固定阈值失败。
- 当前总体可执行性：**94/100**。D1-D6 已按推荐方案确认并实现，专项自动化已覆盖 1.43 MB 样本、精确容量错误和配置校验；剩余 6 分保留给真实 Provider、受控并发内存和三平台 CI 验证。

本评分表示“方案能否按本文直接实施并验收”，不表示代码完成度、测试通过率或事故已经修复。

## 2. 背景与已验证事实

### 2.1 用户可见事故

`octo-runtime 1.0.0` 的 Codex DM 执行曾显示 `STREAM_EVENT_TOO_LARGE`。只读检查发现两条合法 command-completion 轨迹：

| 时间（Asia/Shanghai） |  序列化轨迹记录 | `stdout` / `aggregated_output` |
| --------------------- | --------------: | -----------------------------: |
| 2026-10-18 05:55:20   |   603,523 bytes |                  275,744 bytes |
| 2026-10-18 05:58:44   | 1,430,765 bytes |                  658,380 bytes |

这些记录证明 Provider 会产生超过 256 KiB 的合法结果，但不是当时 IPC 原始帧的逐字节抓包。规划不得把轨迹文件大小等同于模型 Context、IM 最终正文或网络包大小。

### 2.2 当前 main 的确定性复现

在规划基线构造 412,123 bytes 的有效 Codex `item/completed` JSON 行，会得到：

```json
{
  "internalCode": "STREAM_EVENT_TOO_LARGE",
  "publicCode": "OH-PRV-4099",
  "reasonCode": "PROVIDER_ERROR",
  "retryable": true
}
```

这说明当前实现同时存在两个问题：

1. 合法输出在 Adapter 转换前被 256 KiB 固定阈值终止。
2. Runtime 自己的容量拒绝被误报为未知 Provider 故障，并错误建议重试同一输入。

### 2.3 为什么不能只改 Codex 一处常量

输出经过多个独立边界：

```text
Provider stdout / callback
  -> Adapter 原始协议读取
  -> Adapter 待消费队列
  -> native 或 canonical 转换
  -> AdapterHost HostFrame
  -> daemon/Host RPC 待消费队列
  -> HostRunService 重放窗口
  -> Channel 事件投影
  -> 卡片与最终回复
```

任一后置边界仍保留 256 KiB 单项限制时，提高前置限制只会把失败位置向后移动。单项限制、累计队列预算和重放窗口是不同合同，不能使用一个数值替代全部边界。

## 3. 架构归属检查

### 3.1 业务目标

用户提交正常任务后，合法的大型工具结果或 Provider 完成快照必须继续转换和交付。Runtime 必须保持有界内存，并在真正超限时返回准确、不可自动重试的本地容量错误。

### 3.2 决定权归属

| 决定                                               | 归属                                |
| -------------------------------------------------- | ----------------------------------- |
| Runtime 可接受的原始协议消息、HostFrame 和队列容量 | Runtime / AdapterHost 基础设施      |
| 某个 Adapter 是否需要较小或较大的传输上限          | 受信 Host 装配配置，经 Runtime 校验 |
| Provider 消息如何转换为 canonical/native 输出      | 对应 Adapter                        |
| Channel 如何展示已接纳的公共文本、工具结果和错误   | Channel Extra                       |
| 模型 Context、工具输出内容和 Provider 原生会话     | 不由本专项改变                      |

### 3.3 显式输入与合同内动作

- HostApp 或 Runtime CLI 可以在受信配置中为 Adapter 提供显式 `stream_limits` 覆盖。
- AdapterHost 在执行接纳时解析一次有效策略，并为该 invocation 冻结。
- Adapter、HostFrame、RPC 队列和重放窗口按各自单位校验。
- 超限时保留边界、实测字节数、有效上限、Adapter 类型和执行身份等安全元数据。

### 3.4 禁止的越界动作

- 不从聊天正文、模型输出或普通 Context 读取容量覆盖。
- 不把 `runtime_limits` 的 watchdog 时限字段扩成不受信的内存配额入口。
- 不写 Provider 原生配置，不改变模型选择、工具结果或模型 Context。
- 不静默截断、去重、删除或重排已接纳的逻辑输出。
- 不因本地投递失败自动重新执行模型或工具；外部副作用可能已经发生。
- 不把整请求 32 MiB、图片 2 MiB、配置文件 256 KiB 等输入合同一并修改。

## 4. 当前边界清单

| 边界                                   |                           当前值 | 当前实现                                  | 本专项处理                                                  |
| -------------------------------------- | -------------------------------: | ----------------------------------------- | ----------------------------------------------------------- |
| Codex 原始 JSON 行                     |  256 KiB；图片回显有 32 MiB 特例 | `adapter-codex/src/app-server.ts`         | 是；改为已冻结的 Adapter 原始消息上限，保留精确图片回显规则 |
| Claude Code / 通用 JSON CLI 原始行     |                          256 KiB | `adapter-sdk/src/index.ts#spawnJsonLines` | 是；接收公共策略参数                                        |
| ACP 原始 JSON 行                       | 256 KiB；图片 prompt 临时 32 MiB | `acp-client/src/index.ts`                 | 是；实例级策略隔离，prompt 特例不得污染后续调用             |
| ZCode GUI 原始 JSON 行                 |                          256 KiB | `adapter-zcode-gui/src/app-server.ts`     | 是；使用同一策略类型                                        |
| Antigravity / 其他 JSON CLI            |        通过共享 SDK 继承 256 KiB | `adapter-antigravity`、`adapter-sdk`      | 是；逐个登记实际路径，不按包名猜测覆盖                      |
| Adapter `DriverQueue` 单项             |                          256 KiB | `adapter-sdk/src/native.ts`               | 是；与原始消息、HostFrame 分开配置                          |
| Adapter `DriverQueue` 累计             |                  4096 项 / 4 MiB | 同上                                      | 是；保持条数和字节双重上限                                  |
| AdapterHost 生成 HostFrame             |                          256 KiB | `adapter-host/src/index.ts`               | 是；native envelope 开销必须计入                            |
| daemon/Host RPC `AsyncQueue`           |    256 KiB 单项、4096 项 / 4 MiB | `adapter-host/src/rpc.ts`                 | 是；分别报告单项、字节和条数溢出                            |
| HostRunService 单帧                    |                          256 KiB | `adapter-host/src/host-run-service.ts`    | 是；不得低于已允许的 HostFrame                              |
| HostRunService 每 Run / 全局窗口       |                   4 MiB / 64 MiB | 同上                                      | 是；重新建立与单帧上限的关系并验证淘汰语义                  |
| Octo / WeCom 累计公共消息文本          |                          256 KiB | 两个 `run-projector.ts`                   | 需要核对；只有真实输出链路证明会阻断本事故时才调整          |
| Channel 配置、入站正文、图片和请求总量 |                         独立合同 | Channel / protocol                        | 否；数值相同不代表同一问题                                  |

实现前必须完成生产代码全量搜索并把所有注册 Adapter 标为“独立读取、共享读取、回调队列或无此边界”。清单遗漏视为 M0 不通过。

## 5. 目标合同

### 5.1 统一策略类型

建议新增 Runtime 内部类型 `StreamLimitPolicy`，字段至少区分：

| 建议字段                   | 单位与对象                                            | 约束                                 |
| -------------------------- | ----------------------------------------------------- | ------------------------------------ |
| `rawMessageMaxBytes`       | 单条 Provider 原始协议记录的 UTF-8 JSON bytes         | 正整数；等于上限允许                 |
| `adapterQueueItemMaxBytes` | 单个 Adapter 输出队列项序列化 bytes                   | 不得小于 Adapter 可产生的合法单项    |
| `adapterQueueMaxBytes`     | 单 invocation 待消费 Adapter 输出累计 bytes           | 不得小于单项上限                     |
| `adapterQueueMaxItems`     | 单 invocation 待消费项数                              | 正整数                               |
| `hostFrameMaxBytes`        | 完整 HostFrame envelope + payload 的 UTF-8 JSON bytes | 必须容纳合法 Adapter 输出及 envelope |
| `rpcQueueMaxBytes`         | 单 invocation daemon/Host RPC 待消费累计 bytes        | 不得小于 `hostFrameMaxBytes`         |
| `rpcQueueMaxItems`         | 单 invocation RPC 待消费项数                          | 正整数                               |
| `replayRunMaxBytes`        | 单 Run 重放窗口累计 bytes                             | 不得小于 `hostFrameMaxBytes`         |
| `replayGlobalMaxBytes`     | 当前 HostRunService 全局保留 bytes                    | 不得小于单 Run 上限                  |

不要将 Channel 展示预算直接放进此基础类型。Channel 展示受外部消息平台和产品体验约束，需在 D5 单独决定。

### 5.2 配置优先级与信任边界

推荐优先级：

1. 受信 Host 装配中的某 Adapter 显式覆盖；
2. Runtime 中央默认策略；
3. 不存在 Provider 自行提供或聊天请求临时抬高上限的路径。

推荐把配置放在 HostApp / Runtime CLI 管理的 Adapter execution 配置中，例如 `adapters.<type>.execution.stream_limits`，由 Host 启动和 Adapter 注册链路传入。直接 SDK Host 使用同一强类型选项。不得放入 `agent_config.providerOptions`、模型 Context 或环境变量字符串拼装。

每次 invocation 在 Adapter 类型确定后冻结一份不可变策略。配置更新只影响后续 invocation，不修改在途执行，也不修改其他 Adapter 的策略。

### 5.3 候选默认值

以下数值已由用户确认并用于实现：

| 类别                           |         推荐候选 | 依据与限制                                                                 |
| ------------------------------ | ---------------: | -------------------------------------------------------------------------- |
| 原始 Provider 消息             |           16 MiB | 对已观察 1.43 MB 记录约有 11 倍空间；仍低于整请求 32 MiB                   |
| HostFrame 单帧                 |           20 MiB | 为 16 MiB native payload 的 JSON envelope 和转义留空间；必须用实测替代估算 |
| Adapter/RPC 单 invocation 队列 | 32 MiB / 4096 项 | 能容纳至少一个最大合法单项；慢消费者仍有累计边界                           |
| 单 Run 重放窗口                | 32 MiB / 4096 帧 | 能保留一个最大合法 HostFrame；旧 4 MiB 不能继续作为下游隐藏限制            |
| 全局重放窗口                   |          128 MiB | 候选值；需用并发及复制放大测试确认，不代表进程 RSS 上限                    |

硬最大值建议为每项默认值的 2 倍，但必须由用户确认。实现不得静默 clamp；配置越界应在 Host 启动或 reload 时明确失败。

### 5.4 不采用首版分片

推荐首版采用容量修正，不增加任意 JSON 或 HostFrame 分片。现有消费者没有通用重组合同；直接分片会改变事件身份、顺序、取消、重放和终态语义。

如果测试证明单帧容量无法在目标内存下安全实现，必须先定义 chunk ID、总序号、重组完整性、缺片、取消、重放与兼容行为，再作为独立协议变更评审。不得在本专项中临时 `slice()` 字符串或 JSON。

### 5.5 精确错误分类

至少保留下列内部原因，不再合并为 `STREAM_BUFFER_OVERFLOW`：

- `PROVIDER_MESSAGE_TOO_LARGE`
- `HOST_FRAME_TOO_LARGE`
- `STREAM_QUEUE_ITEM_TOO_LARGE`
- `STREAM_QUEUE_BYTES_EXCEEDED`
- `STREAM_QUEUE_ITEMS_EXCEEDED`

错误必须携带经过白名单校验的 `boundary`、`measuredBytes`、`limitBytes`、可选 `itemCount` 和 `limitItems`。不得附加原始输出、prompt、Context、凭据或完整 Provider 对象。

推荐这些错误 `retryable: false`。在配置和输入不变时重试不会改变同一大型输出，且重新执行工具可能重复副作用。公开错误码分配见 D4。

## 6. 分步实施计划与可执行性评分

评分维度统一为：目标与责任 /20、实现路径 /20、依赖与兼容 /20、失败与安全 /20、测试与交付 /20。

| 步骤                               | 交付物                                                            | 目标与责任 | 实现路径 | 依赖与兼容 | 失败与安全 | 测试与交付 |   总分 |
| ---------------------------------- | ----------------------------------------------------------------- | ---------: | -------: | ---------: | ---------: | ---------: | -----: |
| M0 完整容量清单与样本基线          | 所有 Adapter/Host/daemon/Channel 边界、单位、所有者和现有测试映射 |         20 |       20 |         19 |         20 |         19 | **98** |
| M1 冻结合同与用户决策              | 默认值、硬最大值、配置归属、错误码、Channel 交付策略              |         20 |       16 |         14 |         18 |         14 | **82** |
| M2 共享策略类型与配置校验          | 单一类型、默认值、关系校验、Adapter 隔离、启动失败语义            |         20 |       18 |         17 |         19 |         18 | **92** |
| M3 Adapter 原始读取与队列接线      | Codex、Claude、ACP、ZCode、Antigravity 及全部注册 Adapter         |         20 |       18 |         17 |         18 |         17 | **90** |
| M4 HostFrame、RPC 与重放窗口接线   | 完整 envelope 计量、队列细分错误、窗口关系和淘汰                  |         20 |       17 |         16 |         18 |         17 | **88** |
| M5 错误目录与 Channel 展示         | 稳定公开码、诊断编号、主卡片和最终文本可见                        |         20 |       19 |         18 |         19 |         18 | **94** |
| M6 自动化容量、并发和内存验收      | 精确边界、UTF-8、慢消费、取消、兄弟隔离、GC 趋势                  |         20 |       18 |         17 |         19 |         17 | **91** |
| M7 真实 Provider、三平台与发布闭环 | DM/群、CLI/SDK、Codex/Claude/ACP、Windows/macOS/Linux             |         20 |       16 |         14 |         18 |         15 | **83** |

表中分数保留为实施前的逐步估算；D1-D6 已确认并落地，当前状态与剩余验收以第 1、9、10 节为准。

### M0：清单和样本基线

1. 搜索所有固定字节/条数限制和所有 `STREAM_*` / `IM_RESULT_TOO_LARGE` 路径。
2. 为 12 个默认 Adapter 登记真实传输：Codex、Claude Code、CodeBuddy、Hermes、Kimi Code、MCode、OpenCode、OpenClaw、Qoder CLI、Qoder CN CLI、ZCode GUI、Antigravity。
3. 保存脱敏结构样本，只记录事件类型、字段长度和序列化字节，不保存业务正文。
4. 重放 603,523 bytes 与 1,430,765 bytes 规模的结构化 fixture，并生成 16 MiB 前后边界 fixture。

通过条件：每个生产输出边界都有单位、当前阈值、所有者、上游和下游；不存在“其他 Adapter 应该自动继承”的未验证假设。

### M1：冻结合同

完成 D1-D6 决策，将批准值写入本 brief 和当前规则。为所有关系增加启动期校验，例如：

```text
rawMessageMaxBytes <= adapterQueueItemMaxBytes
adapterQueueItemMaxBytes <= adapterQueueMaxBytes
hostFrameMaxBytes <= rpcQueueMaxBytes
hostFrameMaxBytes <= replayRunMaxBytes
replayRunMaxBytes <= replayGlobalMaxBytes
```

关系表达的是最小可容纳条件，不表示每个原始消息一定生成同等大小的 HostFrame。

### M2：共享策略和配置

1. 在共享包定义默认策略、强类型和验证函数。
2. 扩展 CLI 独立 Host 与 SDK in-process Host 的同一装配入口。
3. Host 启动时校验所有 Adapter 覆盖；无效值阻止该配置生效，不启动半配置 Host。
4. Adapter 类型确定后冻结策略，通过 `AdapterInvocationContext` 或等价内部接口传递。
5. 配置只记录数值和来源，不记录 Provider 输出。

不得修改 Run=7 或 Context=v3，除非实现评审证明内部 Host 配置无法承载。若需要 wire schema 变更，必须单独列出兼容矩阵，不能借本计划自动升级协议。

### M3：Adapter 接线

1. `watchLineLimit` 接收冻结的 `rawMessageMaxBytes`。
2. `spawnJsonLines` 和全部调用方传入策略，不保留默认参数外的散落 256 KiB。
3. Codex 图片输入回显继续只豁免与本轮输入完全相同的 data URL；其余内容使用新原始消息上限。
4. ACP 的图片 prompt 临时上限结束后恢复该实例冻结值，不恢复硬编码常量。
5. `DriverQueue` 接收单项、累计字节和条数配置，并返回不同原因。
6. 一个 Adapter 超限只清理所属 invocation 或所属客户端，不关闭兄弟调用和共享 Host。

### M4：Host 与重放链路

1. AdapterHost 按完整 HostFrame UTF-8 JSON bytes 校验。
2. RPC `AsyncQueue` 存储入队时计算的字节数，出队不再次序列化计量。
3. HostRunService 使用同一已冻结策略；重放窗口可淘汰旧帧，但不能拒绝上游已经批准的单帧。
4. 单项超限、累计字节超限和条数超限分别产生精确原因。
5. 流失败后保留已确认的 Provider 终态证据和首个失败原因；清理失败作为附加原因，不覆盖主因。

### M5：错误与展示

1. 在中央 failure catalog 增加用户批准的公开码和稳定 reason code。
2. Runtime 自身容量失败不得落到 `OH-PRV-4099`。
3. 错误卡片主区域和最终失败文本同时显示公开码及诊断编号。
4. `retryable`、action 和建议文案必须与恢复方式一致；不得诱导用户无条件重跑工具。
5. Octo 和 WeCom 使用相同公共分类，不复制 Provider 专用分支。

### M6：自动化验收

必须覆盖：

- 每个字节/条数限制的 `limit - 1`、`limit`、`limit + 1`。
- ASCII、多字节 UTF-8、JSON 转义、newline 是否计入的精确口径。
- 1.43 MB 结构化 command-completion 不再因旧 256 KiB 限制失败。
- 16 MiB 候选值前后、native envelope 开销和 canonical 转换可能放大/缩小的情况。
- 多个小帧耗尽累计预算，与单个大帧失败使用不同 reason code。
- 消费暂停、提前 return、取消、Provider 退出和清理竞态。
- 两个并发 invocation，一方超限不影响另一方。
- 受控并发下 `heapUsed`、`external`、`arrayBuffers`、RSS 和队列计数；清理后引用归零。
- 既有图片输入、32 MiB 请求、OpenClaw 队列和 Host 重放测试保持通过。

自动化使用 fake Provider。测试不得调用真实模型，也不得用无限随机数据造成不可控内存压力。

### M7：真实验收和发布

1. 在批准的测试环境使用专用 Bot 和一次性 workspace。
2. Codex、Claude Code 和代表性 ACP Adapter 各执行一次有界大输出命令，再要求短总结。
3. 覆盖 DM 与已授权群 @；记录 Provider 版本、事件类型、字节数、有效策略和可见结果，不记录正文。
4. CLI 和 SDK 两个入口均验证；重新构建并重启实际 Runtime，不以全局 link 代替。
5. GitHub PR 的 Linux、macOS、Windows、`CI Gate` 全部通过。
6. 先小范围发布；监控容量错误计数、边界、实测 bytes 和进程内存，不记录内容。

真实 Provider 可能采用多个小事件而不是一个大事件。未复现某 Provider 的事故不等于没有上限；结构 fixture 和真实正常链路必须分别记录。

## 7. 验收矩阵

| 场景                                 | 必须观察的结果                                            |
| ------------------------------------ | --------------------------------------------------------- |
| 1.43 MB 合法 Codex completion        | 正常转换和结束；不出现旧 `STREAM_EVENT_TOO_LARGE`         |
| raw message 恰好上限                 | 接纳；上限 + 1 返回 `PROVIDER_MESSAGE_TOO_LARGE`          |
| native HostFrame 含 envelope         | 按完整序列化 bytes 计量；不因 envelope 隐藏超限           |
| canonical 转换后的大型工具结果       | 内容、顺序、ID 和终态不变；不静默截断或去重               |
| 多个小帧耗尽队列 bytes               | 仅当前 invocation 失败，原因是累计字节，不是单项超限      |
| 4096/4097 项                         | 分别接纳和条数失败；字节预算仍独立生效                    |
| 消费者暂停后取消                     | 无需排空大队列即可在清理预算内释放                        |
| 两个 Adapter 使用不同覆盖            | 各自冻结配置；更新一个不改变另一个或在途调用              |
| 无效、负数、小数、过大或关系矛盾配置 | 启动/reload 明确失败；不得静默 clamp 或回退               |
| Runtime 容量拒绝                     | 公共码、reason、诊断编号和安全测量可见；`retryable=false` |
| DM、群 @、CLI、SDK                   | 合法大输出路径一致；授权、会话和 Provider binding 不改变  |
| Windows/macOS/Linux                  | 构建、测试、清理和内存边界均通过                          |

## 8. 已确认决策

以下决定已由用户批准，本次实现按推荐项执行。

### D1：默认原始消息上限（已确认）

- **推荐：16 MiB。** 已观察样本最大约 1.43 MB，留出约 11 倍空间，同时保持有限上界。
- 备选：8 MiB，内存更保守；对未来大型工具结果余量较小。
- 备选：32 MiB，与整请求预算同值；峰值复制和并发风险更高。

### D2：HostFrame、单队列和重放预算（已确认）

- **推荐候选：20 MiB HostFrame、32 MiB 单队列、32 MiB 单 Run 重放、128 MiB 全局重放。**
- 实施 M0/M6 必须测量 JSON 转义和多份复制；如果峰值不可接受，回到 D1 调低原始消息，不允许让下游继续使用隐藏的 256 KiB。

### D3：覆盖配置放在哪里（已确认）

- **推荐：受信的 `adapters.<type>.execution.stream_limits`，CLI 独立 Host 与 SDK Host 使用同一类型和验证函数。**
- 不推荐：`agent_config.providerOptions`，它把通用资源政策伪装成 Provider 私有参数。
- 不推荐：Context `runtime_limits`，普通业务 invocation 不应获得抬高 Runtime 内存预算的权限。

### D4：公开错误码粒度（已确认）

- **推荐：三个公开类别。** Provider 原始消息、HostFrame、队列容量各一个公开码；队列内部再用 reason code 区分单项/字节/条数。
- 备选：一个统一“输出容量超限”公开码，全部细节放 reason code。优点是目录更小，缺点是用户行动建议不够精确。
- 无论选择哪种，均建议 `retryable=false`，不自动重跑模型或工具。

### D5：Channel 超长公共文本如何交付（已确认）

- **推荐：本专项先证明 256 KiB `IM_RESULT_TOO_LARGE` 是否会被真实大工具输出触发；若只影响模型最终长文本，则另行定义分段消息或附件交付合同。**
- 备选：本专项同时实现完整分段交付。范围显著扩大，必须定义平台单消息限制、分段顺序、失败重试和部分送达状态。
- 不推荐：静默截断到 256 KiB，这违反保留现有输出语义的目标。

### D6：发布门槛（已确认）

- **推荐：Codex 真实 DM + 群 @、Claude Code 真实调用、一个 ACP 真实调用，加三平台 CI 和受控并发内存测试，全部通过后关闭 P0。**
- 备选：Codex 真实链路先修复发布，其他 Adapter 只用 fixture 后作为 P1 跟进。能更快止血，但不满足 Issue #21 当前“所有 Adapter 共享默认与覆盖”的完整验收。

## 9. 风险、回退与完成定义

### 9.1 主要风险

1. 单帧放大导致并发峰值内存上升；JSON 字符串、解析对象、structuredClone、RPC 队列和重放窗口可能同时持有多份内容。
2. 某些 Provider 把大结果重复放在多个字段，原始消息大小不能代表最终公开文本大小。
3. native 模式保留 Provider payload，HostFrame 通常比原始消息更大。
4. 提高单帧而不调整累计预算会产生新的隐藏失败；同时提高所有预算又可能扩大慢消费者风险。
5. Channel 平台可能有独立消息或卡片大小限制；Runtime 接纳成功不等于外部投递成功。

### 9.2 回退

- 配置和默认值变更必须能够通过回退版本恢复旧值，但不得把回退描述为已修复事故。
- 发布后如内存异常，先下调受影响 Adapter 的受信覆盖并停止新增大输出，不改写用户 Home、会话或 Provider 配置。
- 不自动重放已经执行过的模型或工具调用。
- 若发生部分投递，报告交付结果未知或部分完成，不伪造 Provider 执行失败。

### 9.3 P0 完成定义

同时满足以下条件才可关闭 Issue #21：

1. D1-D6 已记录为明确决定，规则与实现一致。
2. 所有默认注册 Adapter 的传输与队列路径有清单和回归；未覆盖项显式列为不适用或阻断。
3. 1.43 MB 代表性输出通过完整 Host 链路，旧 256 KiB 不再中断。
4. 真正超限时使用准确公共码、reason、诊断编号和 `retryable=false`。
5. 慢消费、并发、取消和清理仍有界；兄弟 invocation 不受影响。
6. PR 与 `main` 三平台 CI 通过；用户批准的真实 Provider/Channel 矩阵取得证据。
7. 文档记录最终数值、配置方法、监控和剩余限制；不得用计划评分代替验证结果。

## 10. 总体评分说明

| 维度               |  分数 | 说明                                                                           |
| ------------------ | ----: | ------------------------------------------------------------------------------ |
| 问题证据与目标边界 | 19/20 | 有真实事件、确定性复现及 1.43 MB 回归；缺少原事故 IPC 原始帧                   |
| 架构与责任归属     | 19/20 | Runtime、Adapter、Host、Channel 边界及受信配置归属已实现                       |
| 实现路径           | 19/20 | 共享策略已接入 Provider、Adapter 队列、HostFrame、RPC 与重放                   |
| 兼容与发布         | 19/20 | 不改变 Run/Context；完整构建和全量回归通过，三平台 CI 尚未执行                 |
| 失败与安全         | 19/20 | 保持有界、调用隔离、不可自动重试和白名单诊断；受控并发峰值尚待测量             |
| 测试与交付         | 18/20 | 专项与全量自动化通过；真实 Provider/Channel 和三平台验证尚未执行               |

决策与本地实现完成后当前为 **94/100**。扣除的 6 分对应真实 Provider/Channel、受控并发内存与三平台 CI，不能用本地 fixture 代替；这些证据齐备后才可按 100 分关闭 P0。
