---
type: Journal
title: Provider 输出容量修复本地交付记录
description: 记录统一流容量策略、错误分类、Channel 边界判断及本地验证证据。
tags: [p0, adapter, stream, capacity, verification]
timestamp: 2026-10-18T08:30:00Z
---

# Provider 输出容量修复本地交付记录

## 结果

- Provider 原始消息默认 16 MiB，完整 HostFrame 默认 20 MiB。
- Adapter/RPC 队列默认 32 MiB / 4096 项；单 Run 重放默认 32 MiB / 4096 帧，全局重放默认 128 MiB。
- 受信 `adapters.<type>.execution.stream_limits` 可覆盖，单项硬上限为默认值 2 倍；策略按 invocation 冻结。
- 容量失败区分 Provider 消息、HostFrame、队列单项、累计字节和条数，公开分类不可重试，只暴露白名单测量值。
- Channel 256 KiB 仅统计公开消息文本，工具原始输出不进入该预算，本次未改 Channel。
- 错误卡主区域和最终失败文本直接显示公共错误码与诊断编号；HostFrame 超限跨 Host 控制帧保留精确原因。
- 多 Adapter 混合重放配置使用活跃策略中的最高受信全局预算，较低覆盖不会淘汰兄弟 Run。

## 验证

- `pnpm build`：通过。
- 专项 Node 测试：62 项，61 通过、1 条件跳过、0 失败。
- `pnpm test:suites`：WebUI 35/35；Node 1158 项，1149 通过、9 条件跳过、0 失败。
- `pnpm lint`、`pnpm lint:names`、`pnpm format:check`、`git diff --check`：通过。
- Octospec lint 可执行，但被 14 个既有跨仓本地链接阻断；错误未指向本任务文件。
- 合并前双轴审查发现并修复 3 个实现问题及 2 份权威规则旧值；修复后新增专项回归通过。

## 未完成（首轮本地交付时）

真实 Codex/Claude/ACP 与 Channel 联调、受控并发内存测量、Windows/macOS/Linux CI 尚未执行，因此 P0 关闭评分为 94/100，不宣称 100 分完成。实现已形成 topic branch 提交；PR/合并状态以 GitHub 为准。

## PR #29 合并前复审整改

- 恢复工作区后确认两笔 topic branch 提交，重新获取并 rebase 最新 `origin/main`，创建 PR #29，按用户要求写入 `Closes #21`。
- Standards 轴发现 SDK 仍按 512 Ki 字符拒绝通知、受信策略晚于重放预算冻结；Spec 轴发现 RPC 包装开销未计入、HostFrame 控制错误丢失安全诊断。四项均补修并增加聚焦回归。
- GitHub 独立评审另发现 Antigravity normalizer 将容量错误改成可重试 Provider 通用失败；改为原样抛回 Host，并通过 Adapter→Host 回归核对公共码、reason、测量和不可重试语义。
- Host RPC 与 SDK 共用中央 HostFrame 硬最大值加 64 KiB 的传输行预算；实际帧仍按 invocation 有效策略校验。SDK 按段累计 UTF-8 字节，避免字符计量和反复扫描完整在途大行。
- HostRunService 在接纳前从宿主回调获取一次受信策略，冻结后向 RPC、Adapter 和重放传递同一快照；公共调用者不能用自己的环境覆盖生产宿主策略。
- 容量控制错误新增可选 `failure`，同步 Schema、生成类型和校验器；仅允许安全测量白名单，并保留诊断编号和时间。旧控制错误仍可读取，消费新增诊断的组件必须同步使用更新后的协议定义。
- 首轮远端 CI 已通过：Linux/macOS 构建、全量测试、打包及安装验证；Windows 构建、打包、安装及 daemon 清理验证。Windows job 不运行完整 Node suite，不将其表述为三平台全量测试。
- 整改后统一构建、lint、命名、根类型检查、格式通过；最终本地全量 UI 35/35，Node 1178 项中 1169 通过、9 条件跳过、0 失败。包含两项 SDK→daemon→子 Host→真实本地 socket 的 canonical/native 大工具输出测试，验证 1,430,765 字节完整保留、单次接纳、零取消、连续序号与唯一完成终态；这些是合成 Provider 接口回归，不是真实模型验收。
- 整改提交仍需新的远端 CI 和独立 GitHub 审批，不绕过分支保护；PR 合并触发 Issue 自动关闭不代表真实 Provider/Channel 和受控并发内存验收已完成。
