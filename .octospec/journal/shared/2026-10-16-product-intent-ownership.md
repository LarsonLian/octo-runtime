---
type: Journal
title: Runtime 不代替产品决策与两次职责越界纠偏
description: 记录 actmode 会话策略和 mention 兜底的共同错误，将产品意图归属提升为强制需求检查。
tags: [architecture, protocol, decision, context]
timestamp: 2026-10-16T00:00:00Z
---

# Runtime 不代替产品决策

## 错误与根因

本轮 Plan 方案曾推荐“Runtime 每轮显式应用模式、Plan 后省略强制恢复 default”，并将新建/继承会话作为基础层需要统一决定的选项。虽然出发点是消除残留模式，这仍然把不同产品的体验选择变成共享 Runtime 行为。先前应用层 Codex 私有开关已被指出越界，这次却从相反方向把产品策略下沉到基础层，说明只修字段位置没有修正架构定位。

用户再次明确：SDK 和 CLI 的调用方可服务多个产品；模式、思考强度及会话默认/继承/新建由产品确定后输入。IM Channel Gateway 不配置或使用 Plan，始终按其普通/default 产品策略运行。Runtime 不需要为了这项能力改变该入口，也不能替桌面和自研 App 统一体验。

此错误与 mention 缺失时让接收端猜正文兜底属于同一类：以“完整体验/尽量可用”为理由，接收或执行层补造生产方没有表达的意图。应在意图拥有方或最先违反合同的模块修复，不能用下游补丁遮住错误。已有[协议责任决策](2026-10-16-contract-responsibility-decision.md)继续有效，本次补充产品策略归属。

## 当前决定

- 采用 Context v3 的 `octo.execution/actmode`，显式 mode 由 adapter 映射；不另开 Provider 私有宿主入口。
- 撤回每轮强制模式重设、按省略强制恢复 default、自动新建/继承/重置 session 的建议。调用方未指定可选控制时，不补造产品策略；原生行为如实返回。
- 已有明确 defaults / mandatory、身份、权限等合同仍执行；不得以此为由新增全产品默认。用户先前允许的“不支持 actmode 时降级 default”仅是该能力的明确例外，不是基础层通用兜底权限。
- 由产品决定是否展示不支持的选项，Runtime 不能代替 UI 决策；收到不支持请求时按该明确合同处理并返回事实。
- 不把前一版 82 分或增加文字当作正确架构的证明。原评分建立在包含越界职责的方案上，撤回其作为当前完整性结论的资格，待范围修正后按执行合同重新评审。

## 强制落点与验证

原则进入[基础架构](../../rules/architecture.md)，后续需求范围检查进入[工程规则](../../rules/engineering.md)，[actmode 计划](../../tasks/adapter-plan-interaction-exploration/brief.md)按新边界重写。

本次只修改 OctoSpec 文档，未改运行代码、配置、身份或 Provider 会话；不重新运行真实模型或声称完成接入。文档校验与链接检查结果在本轮交付说明中报告。
