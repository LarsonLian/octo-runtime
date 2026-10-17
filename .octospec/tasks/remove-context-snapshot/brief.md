---
type: Task
title: 删除通用执行协议的渠道快照引用
description: 删除 contextSnapshot 和 ChannelContextSnapshotRef，业务自行保存材料并提交本轮输入。
tags: [protocol, context, architecture]
timestamp: 2026-10-15T00:00:00Z
---

# 范围

用户明确要求直接删除通用执行协议的 `contextSnapshot`。同步删除 `ChannelContextSnapshotRef` schema、生成类型、导出、InvokeInput 声明和专用校验、InvokeRequest wire 属性以及 Core 转发。业务自行保存所需数据，不建立替代快照协议，不改变调用方显式提交的本轮 Context。

Channel Gateway Extra 属于业务接入层，经核对不依赖此次删除字段，不修改其业务逻辑。Work App 是测试程序，本次不维护其旧依赖；业务中同名但不同用途的配置保存不在删除范围内。

未知可选输入仍按通用规则忽略；旧字段不再校验或应用，不增加专用兼容处理，也不转发进执行请求。Run=7、Context=v3、Adapter transport=2 保持不变。Home、身份、profile、配置及 Provider 状态保留。

## 调用链澄清

用户进一步明确：AdapterHost.invoke 与 RpcClient.invoke 只接收输入，Host 内部不维护多套执行链。当前它们均使用 createInputInvoke，但 RPC 仍传 adapterType、InvokeRequest 和 options，服务端走 prepare / invokeFrames；这是当前实现，不等于已完成目标收敛。本次仅删除快照字段，后续统一链路应由 Host 统一解析，RPC 负责传输；native/canonical 是输出模式，不是两套输入解析。

## 验收

- 生产定义、导出、生成类型、校验及 Core 转发不再包含删除字段。
- 回归验证旧未知字段不影响模型输入、不进入执行请求，业务输入对象保持原值。
- 类型、构建和全量跨包测试通过；真实新进程执行及未验证范围独立记录。
