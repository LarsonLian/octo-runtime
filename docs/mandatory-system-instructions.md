# mandatory 系统提示词

2026-10-14：`ContextConfiguration.mandatory` 允许 `octo.control/instructions`，entries 的 source 必须为 `agent_configuration`。defaults 仍禁止控制指令，普通请求不得通过伪造来源获得控制权限。

Worker 新建配置的系统提示词为“我是个人助理”。协议校验与 JSON Schema 使用同一限制，生成类型由 schema 重建。运行时从有效 Context 提取控制指令，经已有 `controlInstructions` 通道送到 Host/Adapter；模型上下文 renderer 仍不把控制项串入普通 contexts 块。

本次保持 Run=7、Context=v3。Runtime 映射回归覆盖空业务 Context 和空 Revision instructions 时，mandatory 文本仍完整进入独立通道。真实接口与执行证据、已有记录保持规则及未验证项见 [Worker 验证记录](../../octo-agent-worker/docs/mandatory-system-instructions.md)。
