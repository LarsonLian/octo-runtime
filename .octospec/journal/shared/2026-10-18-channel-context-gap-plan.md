---
type: Journal
title: Issue 32 上下文缺口规划
description: 基于最新main建立独立worktree，定案体验和改动清单，仅规划未实施。
tags: [channel, context, history, planning]
timestamp: 2026-10-18T00:00:00Z
---

# 规划结果

从最新 main `65728c1` 建立 `plan/channel-context-gap` 与独立 worktree。需求和全部文档入口见 [brief](../../tasks/channel-context-gap/brief.md)。

选择服务端位置优先、绑定内有界元数据及自适应取材Context；不采集增长的聊天正文，不让普通未 @ 消息进入执行，也不把提示、投递或任务成功当成读历史证明。保留现有cold 15条/1500码点，warm未知基线建议5条，已知缺口按范围取至多10条；长缺口明确遗漏。

规划补充了原提案易遗漏的三点：自身回复也占序号；观察写binding不能延长其TTL；执行默认项合并后可能再次裁掉提示，只有最终快照能决定提示边界。

本地 CLI 0.18.0 确认所需flags；本地server/IM源码明确 start包含、end排除、down方向和more。部署环境可见性、同域序号、自身ACK/卡片位置和真实Agent取材仍待受控im-test验收，不以源码阅读替代。

可执行性91/100，非完成度。已拆分12项改动、M0..M5里程碑及29项验收矩阵；本轮不改业务代码，不提交/推送或建PR，不调用线上模型，不向当前生产频道发送探针。

# 文档验证

本次7个新增/修改Markdown文件的frontmatter、135个本地链接及任务context.yaml检查通过，source路径均存在，`git diff --check`通过。系统Python缺少PyYAML，使用`uv run --with pyyaml python .octospec/scripts/lint.py`运行原检查器，不改仓库依赖。

全仓文档检查仍有14条既有跨仓文件链接失效，所涉文件均与HEAD一致，不属于本次规划新增问题；未为通过检查修改这些历史文件。业务构建、单元测试和真实im-test尚未执行，本轮不将待验矩阵写成通过记录。
