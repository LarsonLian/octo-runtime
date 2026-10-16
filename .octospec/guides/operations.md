---
type: Guide
title: 本地 Runtime 运维
description: 按身份、就绪、Provider 与扩展状态排障。
tags: []
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# Runtime 运维

先区分本地身份、IPC 就绪、Provider 可用、扩展业务连接和执行终态，见 [Runtime 合同](../rules/runtime-lifecycle.md)。涉及真实服务的调试使用 `https://im-test.deepminer.com.cn/`。

## 启动与检查

HostApp 明确准备发行物及 Provider，本地 SDK 使用 `createDaemonRuntime → startAccount → invoke`。CLI 前台诊断：

```sh
octo-runtime --home /absolute/runtime/state daemon run
octo-runtime --home /absolute/runtime/state status
octo-runtime --home /absolute/runtime/state adapter list
octo-runtime --home /absolute/runtime/state adapter probe codex
```

SDK 查看 `health.local.ready`、`adapterHostReady`、profiles 和扩展状态。socket 文件、历史 connected 值或扩展初始化成功均不能替代实际就绪／连接证据。Worker 接入包已移除，不再使用旧 worker-access 模块状态排障。

## 排障

| 故障 | 检查与恢复 |
| --- | --- |
| IPC 不可用 | 检查有效响应、runner／Host 入口、owner lock、进程与日志 |
| Host 就绪但无法执行 | 检查 probe、Provider 安装／认证、执行配置、工作目录和权限 |
| 扩展缺失或初始化失败 | 检查宿主提供的包、入口与配置；缺失不触发自动安装 |
| 业务连接断线 | 按对应扩展协议检查地址、TLS、鉴权和实际连接状态 |
| 输出断流 | 沿原 run／stream 游标修复；缺口或过期明确失败，不重新 invoke |
| 取消已受理 | 继续观察真实终态与 Provider 清理 |
| 历史缺失 | 检查消费应用存储；Host 内存窗口不是完整历史库 |

不要因外部离线删除本地身份或重装 Provider。聊天 reset、身份重建和执行取消是不同操作。

## 日志与验收

统一日志默认关闭。SDK 宿主显式传 `logging: { directory: "/absolute/logs" }`；Runtime CLI 使用 `octo-runtime daemon run --logs-dir /absolute/logs`，后台服务用 `daemon install --logs-dir /absolute/logs` 更新定义后重启。旧 OCTO_RUNTIME_DEBUG 不再创建独立 Host debug 文件；普通 start 不改已安装的服务定义。

文件按 UTC 小时命名：内核 `<directory>/kernel-YYYYMMDDTHH.log`，Extra `<directory>/extras/<extra_type>-YYYYMMDDTHH.log`。每个序列保留最近 3 个实际日志文件，包含当前文件，单文件最多 100 MiB；没有新日志的小时不创建空文件。停机或空闲跨天不按时间年龄删除这 3 个文件，产生第四个文件后淘汰最旧归档。启动、首条小时写入及每 60 秒执行本序列清理，停止后不清理；其他类别、用户文件和旧固定文件不受影响。时钟回拨时保留当前活动文件，再按文件名时间保留两个最新归档。见[逐项实施记录](../tasks/gateway-august-feature-assessment/implementation.md)。

格式为 `time/level/source/event/extra_type?/data`。data 只允许既有调用/Run/session 标识、Adapter 类型/模型、状态/稳定错误码、耗时、输入/非 Adapter Context 项数及帧/转换计数等元数据；不保存正文、原始错误、完整配置、环境值、图片、地址、预览或内容哈希。ExtraContext 的 log 由加载器绑定真实 extra_type，插件不管理文件，也不能通过 data 覆盖来源。日志关闭不建立目录、文件或日志 Worker。

专用 Worker 隔离同步磁盘操作，每进程最多 128 条在途、最多 128 个文件序列，满额或写入失败丢弃诊断；关闭最多等 1 秒，不阻断 Agent。文件写入沿用非等待互斥、容量和符号链接检查，锁冲突可能丢日志；它不是审计账本。SDK/launcher 不再将任意原始 stdout/stderr 落入另一套日志，必要 stderr 仍交宿主终端或系统服务管理器。Provider 原生日志、用户重定向和系统日志不由该策略管理；真实跨平台服务安装仍需各平台验收。

本版没有 Runtime SQLite outbox 或逐事件 durable ACK，不采用清 outbox／修 ACK 水位作为运维步骤。分别记录 IPC 就绪、扩展连接、真实 Provider 终态及业务保存／投递结果。fixture 测试不能替代 im-test 与真实桌面 renderer 验收；文档修改本身不产生新的实测证据。
