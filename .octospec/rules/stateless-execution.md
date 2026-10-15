---
type: Rule
title: 纯执行与有界状态
description: 不持久化业务历史，只保留有界执行窗口和运行配置。
tags: ["storage","stream","stateless"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-stateless
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-core/**","packages/octo-runtime-daemon/**","packages/octo-runtime-adapter-host/**","packages/octo-runtime-extra-channel-*/**","test/stateless-*"]
  touches: ["storage","stream","stateless"]
source: self
supersedes: []
---

# 纯执行与有界状态

Runtime 接收已准备的请求、校验执行配置、调用 Provider、传递事件、处理交互和取消。业务 Agent 定义、Session/Run 历史、Provider binding 和重启后的业务恢复由调用方保存与决定。

当前 Core 导出本轮配置解析及 InvokeInput 准备函数，不导出领域 store、SQLite 或业务调度引擎。不得以无限增长的 Map 或 Run JSON 归档替代已删除的数据库。

## 源流窗口

以 [HostRunService](../../packages/octo-runtime-adapter-host/src/host-run-service.ts) 常量及容量检查为准：

| 项目 | 当前上限 |
| --- | --- |
| Run 数量，含正在接纳的调用 | 128 |
| 每 Run 帧数 / 序列化大小 | 4096 / 4 MiB |
| 总帧序列化大小 | 64 MiB |
| 单帧大小 | 256 KiB |
| TTL | 120 秒 |
| 同时订阅 / 每页帧数 | 16 / 32 |

超过窗口淘汰旧帧，游标缺口和过期明确报错。保留不依赖消费者 ACK；不能用慢连接固定占住无限旧帧。字节上限不是进程 RSS 上限，Provider、对象、队列和复制还有额外开销。

daemon/Host 重启后旧 stream 不恢复，不自动重放业务请求，不从历史补模型上下文。终态和过期状态必须按窗口合同释放；停止时回收执行资源。

## 插件状态

Octo 和 WeCom 各自使用有界内存会话映射，具体容量及 reset 见 [会话合同](session-reset.md)。这些业务映射不属于通用 Host 的持久历史。映射失效后创建新会话，不能声称已恢复旧 Provider 会话。

## 保留的文件

配置、受保护凭据、machine/Runtime 身份、PID/socket、监督状态和 `invocations.json` 可以保留。后者用于孤儿进程清理，不保存 Run 输入或事件历史。Provider 自身的数据库及原生会话文件仍由 Provider 管理。

旧数据库不读取、不迁移，也不自动删除用户文件。应用可以保存自己的完整业务历史，但该存储不能反过来成为 Host 的 durable ACK 或历史恢复合同。

## 核对入口

[Core 导出](../../packages/octo-runtime-core/src/index.ts)、[HostRunService](../../packages/octo-runtime-adapter-host/src/host-run-service.ts)、[进程清理清单](../../packages/octo-runtime-daemon/src/invocation-manifest.ts)、[无数据库回归](../../test/stateless-executor.test.js)。

SQLite 移除时的测试数量与真实执行仅保留为 [历史验证摘要](../journal/shared/provider-validation-history.md)，不作为当前工作树的新验收。
