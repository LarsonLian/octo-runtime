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

2026-10-15 用户对 Channel Gateway 再次确认：不新增 Context、聊天正文、输入图片、业务 Provider binding 或投递账本的本地持久化，不在 Adapter 建业务状态库；在途与连接状态保持有界内存。需要新会话背景时由 Channel 调用 API 获取当前频道此前 15 条并显式提交 extra Context；此策略于 2026-10-16 实施，一次资格保存在现有有界 binding 中。Provider 原生存储、现有身份和配置不因本决策删除或重置。依据、代价与验收见[不持久化决策](../tasks/channel-no-context-persistence/brief.md)及[历史 Context 专项](../tasks/channel-new-session-history/brief.md)。

## 保留的文件

配置、受保护凭据、machine/Runtime 身份、PID/socket、监督状态和 `invocations.json` 可以保留。后者用于孤儿进程清理，不保存 Run 输入或事件历史。Provider 自身的数据库及原生会话文件仍由 Provider 管理。

旧数据库不读取、不迁移，也不自动删除用户文件。应用可以保存自己的完整业务历史，但该存储不能反过来成为 Host 的 durable ACK 或历史恢复合同。

## 受管日志

F31 已实施可选的统一内核与 Extra 元数据日志。宿主显式指定 logging.directory/--logs-dir；默认不创建日志资源。Extra 经加载器绑定来源的 ctx.log 输出事件，内核只记生命周期、身份、稳定错误码和本轮输入/非 Adapter Context 项数，Adapter 只记安全执行选择。正文、原始错误、完整配置、凭据、预览及内容哈希均不记录。SDK/launcher 停止原始进程输出重复落盘，必要 stderr 继续可见。

当前暂沿用 UTC 当前及前两小时桶、每序列最多 3 个文件、单文件 100 MiB；固定活动文件名和“最近三个文件”口径尚未定稿。专用 Worker 隔离磁盘写入，每进程最多 128 条在途和 128 个序列，满额、锁竞争或写入失败可丢诊断，不保证审计完整性；关闭最多等待 1 秒，不影响 Agent 执行。轮转沿用非等待互斥和普通文件校验，不删除身份、Provider 文件、用户文件或旧固定日志。详情与原生服务定义更新见[运维](../guides/operations.md)及[实施记录](../tasks/gateway-august-feature-assessment/implementation.md#f31-核心改造已实施)。

## 核对入口

[Core 导出](../../packages/octo-runtime-core/src/index.ts)、[HostRunService](../../packages/octo-runtime-adapter-host/src/host-run-service.ts)、[进程清理清单](../../packages/octo-runtime-daemon/src/invocation-manifest.ts)、[无数据库回归](../../test/stateless-executor.test.js)。

SQLite 移除时的测试数量与真实执行仅保留为 [历史验证摘要](../journal/shared/provider-validation-history.md)，不作为当前工作树的新验收。
