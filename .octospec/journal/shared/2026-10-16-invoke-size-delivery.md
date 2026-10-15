---
type: Journal
title: 32 MiB 调用预算与独立 Host 图片链交付
tags: [invoke, protocol, multimodal, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 决定与实现

用户在实施中明确将整个请求上限由 5 MiB 调整为 32 MiB。单图 2 MiB、每组 4 张保留；主输入和 fallback 中的重复图片按实际 JSON 分别计入。UTF-8 完整 JSON 帧在写入前检查，可信环境和包装不能遗漏。Direct Host、RunService、daemon 发送、stdio/Socket Host、CLI playboard 与 SSE 统一限额。

接收器逐块有界读取，超长行停止保存并丢弃到换行；未结束的故障行有 5 秒终止期限。合法客户端超限在发送前拒绝，Provider 不启动；共享 Host 和其他在途调用保持运行。RPC ACK 等待有 30 秒期限，返回行的错误同时由 input 与 readline 处理。SSE 在有界丢弃中排空已发正文后返回 413，避免提前返回破坏 HTTP 响应。

真实大图发现第二处约束：Codex 会回显输入图片。canonical 仅对已知输入回显、已提交的完全相同图片 URL 做计量豁免，扣除后仍限定 256 KiB，原生行最多 32 MiB。事件转换后仍维持原输出和队列上限，native 不改写载荷、不扩大 256 KiB 事件限额。恢复 canonical 会话按本机导出的 ThreadResumeParams 使用 excludeTurns，防止整段图片历史回传。

# 验证

- workspace 构建通过；定向请求边界、SSE 与 Codex 回显共 20 项通过。
- InvokeInput、传输一致性、native、Codex、daemon、playboard 和 RunService 联合回归 82 项通过；改动源文件 ESLint 通过。
- 完整 RPC 帧 32 MiB - 1、恰好上限、+1；超限零写入、零 Provider 启动；后续请求成功。
- 超长行和在途调用并行、分块 UTF-8、超长无换行、响应行错误受控。
- Codex 1/2/4 张单图恰好 2 MiB 的输入与回显通过；图片外的大字段仍失败；恢复请求验证 excludeTurns。
- im-test 隔离群 c1b5a912686c43e9abc8789c8923ff36：687958 字节 PNG，daemon -> 真正独立 Host -> 真实 Codex 正确识别蓝/黄；后续同会话文本成功，成员查询 5 个工具事件、最终真人 mention 元数据落库成功。未 @ 为零调用、ais、reset 历史和话题范围同时通过。卡片不可用诊断沿用文本降级。

测试只在临时 Home 重启自己的 daemon/Host，不删除既有身份、Provider 原生会话或用户文件。Run=7、Context=v3 未变；没有新增 wire 字段，不要求其他产品升级协议。历史图按时间筛选仍归具备来源信息的业务调用方，IM 没有新增历史图片下载。
