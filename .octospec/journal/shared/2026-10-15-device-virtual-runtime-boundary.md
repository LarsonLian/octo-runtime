---
type: Journal
title: 设备与虚拟 Runtime 归属文档验收
description: 记录用户架构图的文档落地、评审定性修正及本次验证范围。
tags: [architecture, runtime, identity, extra]
timestamp: 2026-10-15T00:00:00Z
---

# 设备与虚拟 Runtime 归属文档验收

按用户要求，仅编写设计澄清文档。用户图明确实体设备承载多个虚拟 Runtime，Extra 装配在设备上，虚拟身份分别登记给个人或组织。完整说明见 [任务文档](../../tasks/device-virtual-runtime-boundary/brief.md)。

本次列出旧定义的问题、目标结构、对象责任、Extra 与 Channel 的 Host 级归属、profile 用途拆分、具体修改路径和待实施验收。在基础架构、本地生命周期及 Extra 规则增加最新决策入口，保留现有实现描述并注明适用范围；没有把目标接口写成现有能力。

Alpha review 的 S1 撤回 P1 发布阻断定性：虚拟身份文件问题不能直接推出设备消失或 Gateway 断线。字段校验和已有文件被覆盖的事实仍保留，代码未修复，后续按实际消费者重评。F1 与完整 AdapterHost 改造状态不受本次文档调整影响。

检查 `git diff --check` 通过；OKF 元数据、规则索引和 Markdown 链接检查通过，最终计数以本轮命令输出为准。本次未修改产品代码，未执行 Provider 或线上测试环境联调，未重启进程，未迁移或重置现有身份、Home、profile 和配置。工作树中其他任务的既有改动保留，未提交或推送。
