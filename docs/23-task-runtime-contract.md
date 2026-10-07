# 任务 Runtime 契约与验收

日期：2026-10-07。任务业务权威属于 Agent Access；Harness 仅执行受控材料读取与文件归档，不推断任务完成或处理权。

## M0：冻结运行合同

沿用 `octo.context-envelope/v1`、ExecutionEnvelope schema 3、普通 Conversation/provider session。任务材料使用 `octo.content/resources`：

```json
{
  "resource_ref": "task:task_id/materials",
  "resolver": "mcp",
  "locator": {"server_ref": "octo_task", "tool": "task_get_materials"},
  "params": {"task_id": "task_id"}
}
```

Access/Worker 物化 `resolved_execution_plan.mcp_servers.octo_task` 为受限 Streamable HTTP MCP 地址和运行 grant。URL、headers 均不属于用户正文，不从材料、Agent 指令、模型输出解析。grant 绑定空间、任务、Conversation、Run、Runtime、lease/fencing 和处理权 epoch。服务端每次工具调用重新校验。

`task_get_materials` 返回 MCP structuredContent 或单个 JSON text，至少包含 `task.id`、`task.row_version`、`task.handler_epoch`；正文、附件元信息、最近讨论及处理摘要由服务端有界投影。snapshot 不含凭据或远端本机路径；附件以 attachment_id/file_version_id 引用。Harness 每次 Run 在调用 provider 前实际读取材料，将 JSON 放入非可信事实输入；控制指令保持独立。失败拒绝该 Run，不能凭一句“请读取任务”视为材料已注入。

模型按需调用已物化 MCP 的 `task_read_attachment`，服务端同时校验任务和网盘权限。Harness 不全量下载附件，也不把跨 Host 的本机目录当作附件引用。

运行位置和本次材料冻结后才进入 provider；下一 Run 重新读取。相同 Run 的 admission 重试保留已接纳事实。代码不得将 MCP headers 写入 Run 元信息、日志或模型输入。

## M2：材料闭环验收

- HTTP MCP mock 证明 initialize 和 tools/call 在 provider invoke 前发生；断言模型实际输入含任务正文、附件目录及摘要。
- 两个 Run 对同一引用分别读取更新版本；第一份冻结输入不随服务端变化。
- 工具失败、超时、缺少服务、越界响应、task_id 不匹配、非法 resolver 均拒绝，不调用 provider。
- 材料中“修改权限”的文字仅为数据；不进入 controlInstructions。运行 grant 不进入模型和日志。

## M3：文件归档

只归档本次执行声明的 manifest；不扫描整个项目或自动上传用户所有文件。Runtime 验证输出相对目录路径、真实目录、symlink、普通文件、文件大小和 SHA-256，随后经运行授权获取上传凭据。上传成功且服务端确认关联后才产生已保存事实；失败保留明确错误，不能把 Run 成功当作文件保存成功。远端 Runtime 执行上传，不依赖桌面在线。

## M4：Team

继续使用 Worker 的 octo_team handoff/Delegation/Mailbox。handoff 传递任务 ID 和稳定附件版本引用，不传本机路径、MCP headers 或源 Run grant。目标 Run 由 Worker 重新物化目标 Runtime/lease/fencing 的 octo_task 能力，再执行同一材料 bootstrap。handoff 结果为摘要和已保存文件引用；Run/Delegation 结束不代表业务子任务完成。
