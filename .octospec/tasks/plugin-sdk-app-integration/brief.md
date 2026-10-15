---
type: Task
title: 统一 Extra 的 SDK 与桌面接入
description: 补齐插件动态配置、业务查询和恢复，迁移 Work App 并修正文档。
tags: [extra, integration, lifecycle]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与合同

SDK 提供 configureExtra/loadExtra/unloadExtra/extraStatus/requestExtra；插件保留默认函数入口，可登记配置更新和业务请求处理器。框架不理解 Bot、租户或外部连接协议。IM 插件接受完整 bots 和可选 authorized_space_ids，在内部增量应用并提供 status。宿主保存配置，SDK 保留最新声明用于 runner 恢复；不隐式安装、不扫描宿主存储。Run=7、Context=v3 保持。

Work App 使用统一 Extra，保留 SQLite、逐 Bot 编辑/停用/删除、连接状态、授权、账号切换和重启恢复。显式 Bot 启用不受历史 connectionsEnabled 字段阻止，保留现有测试确认的行为。仅迁移当前业务装配，不回退其他工作区修改。

# 验收

配置更新不重启 Host 或无变化 Bot；业务失败可观察；关闭清理与并发操作有序；声明和配置不泄漏到公共健康。SDK/插件/App 测试与构建通过；真实 renderer 使用 im-test 验证并记录实际边界。同步接入指南、Extra 规则与配置指南。

# 实施状态

SDK、IM Extra、Work App 接线和接入文档已修正；自动检查及实际 renderer/im-test 鉴权失败路径、真实 Codex 执行已通过。缺少有效 Bot 凭据的成功在线和 IM 收发路径仍未验证，不作为已完成事实。详见 [验证记录](../../journal/shared/2026-10-15-plugin-sdk-app-integration.md)。
