---
type: Rule
title: 思考强度映射与未应用提示
description: 四挡选择、原生映射、降档与未实现 setter 的诚实回执。
tags: ["reasoning","adapter"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-reasoning
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-adapter-*/**", "packages/octo-runtime-executor-core/**","test/*reasoning*"]
  touches: ["reasoning","adapter"]
source: self
supersedes: []
---

# Runtime 思考强度默认映射

2026-10-11 决定：Runtime 对外固定 `low / medium / high / xhigh`。用户选择与实际原生参数分开保存；不因某个 adapter 缺少原生档位而隐藏选择器或拒绝整次运行。

## 默认表

唯一维护点为 `packages/octo-runtime-adapter-sdk/src/reasoning.ts`。表随代码发布，不增加远端配置服务、UI 设置、运行时能力准入或协议协商。

| Adapter / 执行通道 | low | medium | high | xhigh |
| --- | --- | --- | --- | --- |
| Codex | low | medium | high | xhigh |
| Claude Code | low | medium | high | xhigh |
| Antigravity | low | medium | high | xhigh |
| OpenClaw Gateway | low | medium | high | high |
| OpenCode CLI（full_access） | low | medium | high | high |
| ACP（含 OpenCode ask）、CodeBuddy、ZCode | 原生默认 | 原生默认 | 原生默认 | 原生默认 |

OpenClaw、OpenCode 使用保守的三挡默认基线；这不声明所有底层模型只有三挡。其高级档位依赖底层模型，当前不动态发现、探测或重试切换档位。本机 Claude Code 帮助已列出 `xhigh`，因此保留四挡映射。

ACP 路径包含 Hermes、Kimi Code、MiniMax Code、Qoder 与 Qoder CN。目前 Runtime 未实现这些通道的原生强度 setter；“原生默认”不代表提供方产品永远不支持强度。

## 数据与执行边界

- UI 和 Context 继续保留统一档位。转换不改写 InvokeRequest 或执行快照。
- 各 adapter 在现有原生载体处调用共同 mapper：Codex `turn/start.effort`，Claude / Antigravity `--effort`，OpenCode `--variant`，OpenClaw `sessions.create.thinkingLevel` 和 `agent.thinking`。
- 缺少 effort 时不传参数，不产生额外提示。非法已知值（包括 `max`、拼错的 `xhight`、空字符串）在 adapter 边界拒绝，不当作“无接口”。公共 Context 类型暂仍使用 string，四挡检查在 Adapter SDK 执行边界完成。
- 无 setter 时，按用户授权保留选择、使用原生默认执行，不注入虚构 CLI 参数，不向提示词追加“请多思考”。
- 无 setter 时额外产生现有 `run.notice/config_warning`，`warningCode=REASONING_EFFORT_NOT_APPLIED`。降档时使用 `REASONING_EFFORT_DOWNGRADED`。Work App 展示具体说明；默认执行不冒充强度已应用。
- 不改变 Run schema_version=7、Context octo.context-envelope/v3、身份、授权、租约、fencing 或 mandatory 合并规则。

## 核对入口

[映射唯一维护点](../../packages/octo-runtime-adapter-sdk/src/reasoning.ts)、[Adapter SDK](../../packages/octo-runtime-adapter-sdk/src/index.ts)。表描述当前代码的稳定默认映射，不推断外部 Provider 新版本的能力。历史真实验证及失败项见 [验证摘要](../journal/shared/provider-validation-history.md)。
