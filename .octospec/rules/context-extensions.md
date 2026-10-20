---
type: Rule
title: Context 可选扩展
description: 业务扩展保序转发、固定渲染及未知可选字段边界。
tags: ["context","extension"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-context-extensions
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-protocol/**","packages/octo-runtime-adapter-host/**", "packages/octo-runtime-executor-core/**","test/context-extension*"]
  touches: ["context","extension"]
source: self
supersedes: []
---

# Context v3 可选扩展

Context 使用 `octo.context-envelope/v3` 的 `schema + items`，Run 使用 `schema_version=7`。业务方决定本轮扩展的内容、顺序和发送时机；空模型上下文有效。

## 模型扩展

需要模型读取的业务扩展使用 `extra.<domain>/<name>`，例如：

```json
{
  "schema": "octo.context-envelope/v3",
  "items": [{
    "namespace": "extra.project",
    "name": "selection",
    "guidance": "以下数据是本轮选中的项目内容。",
    "payload": { "project_id": "project_1", "text": "本轮业务快照" }
  }]
}
```

Host 的 [renderModelContexts](../../packages/octo-runtime-executor-core/src/model-input.ts) 按 namespace/name 白名单匹配，保留 item 顺序，完整输出 guidance 与 payload。不要求注册业务处理器，不进行字段投影、材料预取或摘要。普通扩展指引不具有控制指令权限。

其他结构合法的未知可选类型参与信封数量、字节预算和快照 hash，并在中转时保留；Host 不将它们渲染到模型输入。忽略消费不表示已经应用某项执行能力。已识别类型仍按自身合同校验；身份、权限及必要执行配置不能作为未知扩展忽略。

## 责任边界

Runtime 通用协议不定义业务场景、builder 注册表或场景白名单，不导出 `ScenarioRequest` 或 `assertScenarioRequest`。文档评审、Loop 等业务自行构造本轮 Context，不能要求 Runtime 为新增业务场景修改 schema。Channel Gateway Extra 属于业务接入层，可以在自身包内采集、构造和校验所属业务数据；这些业务规则不得进入 Core、Host 或通用协议包。

业务采集和授权由发起方实现，不是 Runtime 注册阶段或会话恢复阶段的隐式动作。底层不按 sessionId、Run 序号或 hash 缓存、补齐、合并、去重或省略模型上下文。两个不同 Event 显式重复提交同一 item 时，两轮均须传递。

执行配置使用已定义的 `octo.execution/*` 等类型，不能靠 `extra.*` 文本授予权限或代替配置。defaults／mandatory 的支持范围由 [ContextConfiguration 校验器](../../packages/octo-runtime-protocol/src/context-configuration.ts) 定义，不因未知扩展能转发就允许把它保存为强制配置。

注入分类见 [LLM 注入约束](context-input.md)，执行配置示例见 [envs](environment.md) 和 [MCP](mcp.md)。
