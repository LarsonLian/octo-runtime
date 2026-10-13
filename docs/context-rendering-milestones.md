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

## M1.1 每轮输入归属与全局文档同步

日期：2026-10-13。范围：文档约束，不表示旧执行侧链路已退出。

- 每轮模型上下文的内容、顺序和发送时机由业务方决定，selection 等业务项非框架必填。
- 允许空模型上下文、只发送本轮需要的项及显式重复；必要 adapter 等执行配置仍独立校验，且不进入 LLM 上下文块。
- 底层不得按 sessionId、run 序号或 hash 缓存、补齐、合并、去重或省略本轮数据；原 Event 幂等重投仍复用原快照。
- reset、新建 Provider 会话或 resume 失败后，由业务方重新提供必要背景；底层返回真实结果，不自动补齐。
- 更新全局 AGENTS、生态 README/IPD-SE、Harness 架构及全部模块 README、Worker/Loop/Work App README，以及关联架构和历史 Context 文档入口。IPD-SE 增加 AC-21～25，明确三轮输入、重复、不发 selection、恢复失败与执行配置边界。

验证：文档差异与本次新增相对链接检查；本里程碑不修改运行时代码，不以文档同步宣称新增 AC 已通过。
