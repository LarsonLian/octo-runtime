# Agent 业务身份与 Runtime 注册边界

日期：2026-10-14。旧“注册 Runtime 自动创建 Agent”方案已退出。现行设计见 [Runtime 合同](runtime-local-and-online-contract.md)及[本地 IPC IPD-SE](../../docs/local-runtime-ipc-on-demand-ipd-se.md)。

## 现行决定

- Runtime 在本地初始化时先取得稳定身份，注册沿用该身份。
- Agent 定义、业务 identity、名称、Target、defaults／mandatory 由业务方管理。
- 注册、启动和执行不创建默认 main，不执行 Agent ensure／prepare，不等待 Worker Agent 记录。
- Worker 已退出 Agent registry、Agent Context 配置及业务 Event／ActionExecution 四表职责。
- IM 是本轮 Event 发起方，选择并构造业务 Context；通用接入和 Host 只校验、转发与固定渲染。
- Runtime ID、Agent ID 和 Provider Agent ID 不可互换；本地身份也不能替代远程授权。
- 每轮 Context 由业务明确选择，允许空模型上下文和显式重复；底层不做首轮自动注入或会话补齐。
- Run 保持 7，Context 保持 v3；不保留旧自动创建路径、兼容转换或双写。

业务应用可显式管理自己的 Agent，但不能把该能力放入设备注册、副作用恢复或底层执行门槛。业务 Target 无效由业务层拒绝，Runtime 和资源越权由执行边界拒绝。

当前 SDK 与可选模块见 [接入指南](../INTEGRATION.md)。旧需求、接口和当时验证范围保存在 [历史快照](agent-identity-runtime-registration-historical-2026-10-14.md)，不再是实施基线。
