---
type: Task
title: Issue 46：抽取与传输无关的 ExecutorCore
description: 基于当前代码启动执行核心重构方案，明确 API、迁移边界、依赖与验收。
tags: [architecture, executor, invocation, context, testing]
timestamp: 2026-10-20T00:00:00Z
---

# 目标与状态

对应 [GitHub #46](https://github.com/Mininglamp-OSS/octo-runtime/issues/46)，基线为已 fetch 的 GitHub `origin/main`：`7fb81e930675c62897e436828b5a1fcdc8c99f40`，分支 `refactor/46-executor-core`。remote 为 `https://github.com/Mininglamp-OSS/octo-runtime.git`。用户授权后已实施 Core、原 worker 接线及本机发行检查；M0–M3 本机通过，M4 原生跨平台证据及 M5 联验待完成。用户最新授权提交、推送并创建目标为 main 的正式 PR，使用 `Closes #46`，其余任务仅 Related；新 Kernel 与真实宿主联验继续归 #47/#51/#50，不将其写成已完成。未运行真实模型。见 [实施记录](implementation.md)。

标品和 FDE 需要复用一个 AgentExecutor。接入以稳定性为优先：推荐 HostApp 通过 SDK 经 IPC 调用独立 ExecutorKernel，尤其是 Electron 等长期运行的宿主。允许显式选择进程内直接调用，作为 SDK 内嵌简易方案，由宿主管理生命周期并承担同进程故障影响。两种方式使用同一执行实现；业务连接、轮询和编排归 Extra 或项目。LoopDaemon 是另一项目维护的 Go 二进制，本仓只提供通用接入合同。

将现有 `octo-runtime-core` 的输入准备与 `octo-runtime-adapter-host` 的执行实现收敛为 `@mininglamp-oss/octo-runtime-executor-core`。Core 不依赖 Kernel、RPC、Extra 或云端账号。默认隔离执行继续保留 worker 与 stdio NDJSON，包合并不删除进程边界。

## 范围检查

2026-10-20 PR52 后续评审：用户授权直接修复已确认问题，并在 GitHub 用英文回复 reviewer。
本轮修复 Core 清理预算重复计时、Native 后台清理拒绝和串行释放短路、ZCode caller cleanup
短路；不改协议、业务重试或 Provider 安装策略。未成立的 Promise.race 迟到拒绝意见以双模式
取消/超时回归和代码说明回应。验收为故障可见、独立清理均尝试、预算共享及原执行回归。

| 问题 | 本任务的回答 |
| --- | --- |
| 为什么需要 | 当前执行类虽能在进程内使用，但包入口同时导出 socket、RPC 和进程管理；宿主缺少明确的纯执行接入边界。 |
| 谁决定什么 | HostApp 决定安装、加载集合及生命周期；Core 负责通用执行；Adapter 负责 Provider 原生适配；业务方决定每轮内容及业务重试。 |
| 显式输入 | 继续使用 InvokeInput、Context v3、独立 InvokeEnvironment 和宿主注册的 Adapter，不要求 JS class 实例或线上登录。 |
| 合同内动作 | 唯一输入准备、defaults/mandatory、身份/权限/审批校验、固定渲染、调用、交互、取消、预算、清理和真实终态。 |
| 修复归属 | 执行缺口在 Core/Adapter 修复；传输与 worker 故障归 Kernel；不让下游补业务背景或修正上游业务意图。 |
| 其他产品影响 | 保持执行默认值、输出模式、会话与输入语义；不将 IM 固定目录、账号配置或 CLI 清单变成 Core 通用要求。 |
| 自动行为依据 | 仅保留已有合同中的配置默认与取消/清理；不增加隐式安装、请求重试、会话恢复或业务历史补齐。 |

## 交付内容

1. 单一 Core 执行实现、公开 TypeScript 接口及进程内完整示例。
2. 现有隔离 worker 委托 Core，继续使用原 NDJSON 链路，不复制执行引擎。
3. 输入、Context、模式、交互、取消、终态、容量及清理的定向回归；执行失败域文档。
4. 新包依赖/构建/类型接线与当前消费方的最小必要改动；不依赖仓库内部物理路径的导出方案。
5. 向 #47/#51 交付冻结的执行端口和事实语义，最终 Kernel 联验单列，不以旧 worker 冒充新 Kernel。

API、状态与源码归属见 [设计](design.md)，规划时的 94/100 评审及 R1–R3 见 [评估](assessment.md)，M0–M5 的进入/产出/验收/失败处理见 [计划](plan.md)，D01–D18 场景见 [验收](acceptance.md)，规则读取记录见 [context.yaml](context.yaml)。R3 已在实施中落实，R1/R2 仍待联验；评分不等于代码完成率。

## 依赖与开发顺序

| Issue | 本任务的关系 |
| --- | --- |
| [#43](https://github.com/Mininglamp-OSS/octo-runtime/issues/43) | Extra 拆分及其业务生命周期在该项完成，Core 不承接 Extra 管理。 |
| [#47](https://github.com/Mininglamp-OSS/octo-runtime/issues/47) | 消费本任务 Core；最终执行 worker、IPC、窗口与监督归该项。先交付 Core 和旧 worker 最小接线，再联验新 Kernel。 |
| [#51](https://github.com/Mininglamp-OSS/octo-runtime/issues/51) | 共同冻结可序列化 DTO 与行为；不等待 Go 客户端完成，不把 AbortSignal/functions 写入 Schema。 |
| [#48](https://github.com/Mininglamp-OSS/octo-runtime/issues/48)、[#49](https://github.com/Mininglamp-OSS/octo-runtime/issues/49) | 分别负责 SDK 模式/宿主生命周期与 CLI 重设计，不在 Core 中增加账号启动或服务命令。 |
| [#50](https://github.com/Mininglamp-OSS/octo-runtime/issues/50) | 负责整体消费迁移、安装产物和真实 Provider/IM 联验；Core 必须先交付可消费模块，不能把基本导出正确性延期。 |
| [#13](https://github.com/Mininglamp-OSS/octo-runtime/issues/13)、[#14](https://github.com/Mininglamp-OSS/octo-runtime/issues/14) | 核对生命周期整改与 Windows 真实验证，不声称本次已修复或通过。 |

## 范围外与保护要求

不实现 LoopDaemon、Go 客户端、Kernel 服务与监督器、Extra 进程化、CLI 服务管理或跨仓库宿主迁移。最终不再保留独立旧 Core 执行实现；旧 adapter-host 中传输代码在 #47 接管前可以暂留，必须委托同一 Core。临时接线不等于长期承诺旧内部包为公共 API。

Run `schema_version=7`、Context `octo.context-envelope/v3`、Adapter protocolVersion=2 各自保持。不得删除或重新初始化既有身份、Home、profile、配置和 Provider 状态。历史“不兼容切换”不构成本次授权。
