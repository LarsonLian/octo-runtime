---
type: Task
title: 宿主配置来源与 SDK 配置值边界
description: 移除 Channel 凭据文件字段，架构规则约束后续配置定义。
tags: [architecture, extra, configuration]
timestamp: 2026-10-16T00:00:00Z
---

# 目标与责任

用户指出 bf_token_file 属于过度设计：SDK 宿主可以从 JSON、SQLite、Nacos 等来源拼装对象，SDK 无须管理来源。本次将此决定写为通用架构约束，并清理 Gateway 的 bf_token_file 与同类 WeCom app_secret_file。

宿主拥有来源选择、读取、组合、解密、持久化及更新责任；SDK/Extra 只校验和消费实际业务值。显式注入的凭据回调保留，返回已解析值。不新增来源适配器、兼容回退或配置中心抽象。CLI 自有文件读取仍属于 CLI 宿主；workdir、资源地址、会话状态路径及 Runtime 内部存储各归原合同。

原实现把宿主的凭据文件读取放进 Extra，应在这两个插件修复，并同步类型、schema、说明和调用样例。既有文件字段不再用于取值：Gateway 按原合同忽略未知可选字段；WeCom 按原合同拒绝未知 Bot 字段。使用者自行迁移为凭据值，不自动改写实际配置或重置 Runtime。Run=7、Context=v3、其他产品策略及 Provider 安装合同均不变。

# 验收

- 用户进一步明确不考虑旧配置兼容：删除旧 file-config 模块及文件权限错误分支，不保留路径转发、兼容读取、迁移或回退。
- 两个 Channel 的公开类型、schema 与运行逻辑不再提供凭据文件取值；保留凭据值的格式校验及缺失凭据的原有失败状态。
- 宿主可读取自己的来源后传值；传文件字段不会触发 SDK 文件读取。
- 架构、Extra 规则和配置指南明确新增配置的责任判断标准。
- 构建、类型、lint、跨包回归和发行物检查通过。真实接口调试仅连接 im-test，不接管既有 Bot 连接或修改已有配置。

# 结果

后续清理已完成：删除两个 file-config 模块和旧文件权限错误分支，现有配置模块承接业务值处理与校验，旧路径不转发。重跑全量测试、类型、lint、发行包残留检查和 im-test 只读认证均通过。

已实施并验证。Node 1018 通过、8 跳过，WebUI 35 通过，构建、类型、lint 和发行物检查通过；im-test 两账号只读认证匹配，无效凭据正常拒绝。没有发送消息或进行 WeCom 实际建联验证。详见[交付记录](../../journal/shared/2026-10-16-host-config-source-boundary.md)。
