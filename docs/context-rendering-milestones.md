# Event Context 改造里程碑

基线：[Event Context IPD-SE](../../docs/event-context-rendering-ipd-se.md)。当前分支直接修改并按里程碑提交；本文件记录本次验证，不引用历史结果作为通过依据。

## M1 共享协议与 Host renderer

日期：2026-10-13。状态：已完成源码与针对性自动验证，尚未完成跨项目和真实环境验收。

- ContextItem 增加可选 guidance，执行配置禁止 guidance；Run 7 / Context v3 保持。
- canonical/hash 保留 items 顺序，guidance 纳入快照身份；共享 fixtures 同步。
- Host 固定请求后统一渲染模型上下文，内部只输出换行纯文本“指引／数据”；执行配置、未知普通 namespace 和控制指令不进入 contexts 块。
- 覆盖文本、parts、fresh fallback 以及 native/canonical；冻结与重复接纳复用原始请求身份。
- 明确内置类型的 LLM 通道，以及 resume 后由发起方决定本轮上下文。

验证：Protocol 与 Adapter Host 构建通过；`node --test test/model-context.test.js test/context-protocol.test.js test/host.test.js test/native-host.test.js` 通过。

后续：Go 同源合同与 Event、Run 快照传递；旧调用方编译前缀退出；Pipeline、材料摘要与扩展投影删除；Work App/Loop 调用方同步；跨项目构建、重启和真实执行验证。
