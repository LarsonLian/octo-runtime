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

启动前设置 `OCTO_RUNTIME_DEBUG=1` 可开启 Host 本地诊断，检查有效 Home 的 `logs/adapter-host.log`。改变终端环境不会改变已运行进程，需重启受影响实例。日志可能包含调用内容，分享前检查凭据及业务数据。

本版没有 Runtime SQLite outbox 或逐事件 durable ACK，不采用清 outbox／修 ACK 水位作为运维步骤。分别记录 IPC 就绪、扩展连接、真实 Provider 终态及业务保存／投递结果。fixture 测试不能替代 im-test 与真实桌面 renderer 验收；文档修改本身不产生新的实测证据。
