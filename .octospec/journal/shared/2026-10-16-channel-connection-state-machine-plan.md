---
type: Journal
title: Bot 连接状态机开发计划与文档检查
description: 记录首次启动与断线恢复的需求归属、计划交付和实际检查限制。
tags: [channel, extra, lifecycle, testing]
timestamp: 2026-10-16T00:00:00Z
---

# Bot 连接状态机开发计划与文档检查

用户要求按 octospec 整理详细开发计划，并将讨论中的状态机逻辑写入。已建立[任务简报](../../tasks/channel-connection-state-machine/brief.md)和对应 context.yaml，在知识目录添加入口。计划包含五态图、事件转换表、固定退避、成功清错误和计数、终端错误、资源清理与代次竞争、宿主接入及 im-test/CDP 验收。

需求明确区分首次尝试失败与曾上线后的恢复；Bot 连接状态由插件管理，loader 的 loaded 不代表 Bot 在线。沿用 state/error/connected 字段，错误码不能代替连接阶段，任务与投递诊断不得污染连接错误。服务端 Bot 占用的真实错误合同仍需核实，不把推测写成事实。

本次仅更新知识文件，没有修改代码、运行配置或进程，没有连接线上测试 Bot。实现和线上验收全部待执行，不构成已支持状态机的证据。

已执行 `uv run --with pyyaml python .octospec/scripts/lint.py`。检查未通过，报告其他 7 个文档指向缺失的 `2026-10-16-channel-features-delivery.md`：channel-integration、session-reset 两条规则，以及 channel-fixed-workdir-decision、channel-image-input、channel-new-session-history、channel-no-context-persistence、channel-rate-limit-retry 五个任务。本次没有修改这些文件或补造交付记录；报错未涉及本次新增文件。索引的 `git diff --check` 通过。
