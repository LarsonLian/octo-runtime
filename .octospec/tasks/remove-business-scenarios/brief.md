---
type: Task
title: 从通用 Runtime 协议删除业务场景
description: 删除场景白名单和 ScenarioRequest 合同，业务接入层自行构造 Context。
tags: [protocol, context, architecture]
timestamp: 2026-10-15T00:00:00Z
---

# 范围

用户明确要求按干净的 Runtime 边界直接删除业务场景合同，不以 Work App 测试程序的依赖作为保留或兼容理由。本任务不迁移或修改 Work App；其旧导入需由测试程序后续调整。Channel Gateway Extra 属于业务接入层，允许保留自身业务语义；核对后它没有依赖此次删除的场景白名单。

删除协议包 scenario 模块、场景常量、assertScenarioRequest、ScenarioRequest schema、生成类型及 Node/browser 导出，删除仅验证这套业务白名单的测试。Context 格式、执行配置、权限和固定渲染继续按既有统一合同处理，不新增场景注册器或替代字段。

## 验收

- Runtime 生产代码和 schema 不含此次业务场景、builder 白名单及相关导出。
- 构建及跨包测试通过；真实执行验证记录与未验证范围明确区分。
- Run=7、Context=v3、Adapter transport=2 不变；既有身份、配置、Home、profile 及 Provider 状态保留。
