# Prompt、上下文与 Workdir

> 2026-10-14 新基线：Agent Revision 已移除。系统 instructions 保存到 ContextConfiguration.mandatory；默认 ensure 写入“我是个人助理”。只在底层会话首轮注入，续聊不重复；重置或新建底层会话重新注入。下文涉及 Revision 的内容仅为历史记录。


Provider 输入由 AgentRun 的冻结输入与 Agent revision 共同构造，不从 workdir 文件反推业务状态。

Reference Core 生成：

```json
{
  "schema": "octo-runtime.agent-run-context/v1",
  "agent": { "id": "agent_1", "name": "reviewer" },
  "agent_session": {
    "id": "asess_1",
    "namespace": "loop",
    "session_key": "v1/task/task_42",
    "generation": 1
  },
  "agent_run": {
    "id": "arun_1",
    "run_no": 2,
    "trigger": {
      "kind": "loop_dispatch",
      "occurrenceId": "loop_attempt_2"
    },
    "input": { "prompt": "Review the change" }
  }
}
```

这里没有 Chat、Task 或 Attempt 的通用字段。Loop 若需要 task metadata，应把它作为 namespace-owned input/context 传入，而不是要求 Runtime 查询 Loop 数据库。

Agent Worker Runtime 将 execution envelope 映射为：

- `agent_run_request.input`：本轮冻结输入；
- `agent_revision.definition.instructions`：Agent 固定指令；
- `agent_revision.execution_profile.workdir`：provider cwd；
- `provider_session`：opaque resume data；
- 可选 channel context snapshot：用于 provider model input，但不改变产品可显示 prompt。

`prompt` 是产品可显示的当前请求；`modelInput` 可以额外包含已经冻结的频道上下文。二者分离避免隐藏上下文被重复显示或重复追加。

Workdir 只是子进程 cwd，不是安全边界，也不保存 AgentRun 权威状态。权限由 provider sandbox、容器/VM、宿主账户和最小凭证建立。
