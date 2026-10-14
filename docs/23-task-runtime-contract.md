# 任务 Runtime 契约与验收

日期：2026-10-10。任务业务权威属于独立 Loop；Access 负责 Event/Trigger/Context/Team，Worker 执行原子 Run。Runtime 仅执行受控材料读取与文件归档，不推断任务完成或处理权。

## M0：冻结运行合同

固定 `octo.context-envelope/v3`、Run schema 7、普通 Conversation/provider session。任务材料使用 `octo.content/references`：

```json
{
  "resource_ref": "task:task_id/materials",
  "resolver": "mcp",
  "locator": {"server_ref": "octo_task", "tool": "task_get_materials"},
  "params": {"task_id": "task_id", "handler_epoch": 2}
}
```

Worker 从服务配置物化 `resolved_execution_plan.mcp_servers.octo_task` 为 Loop 的 `/mcp/task`，Team 的 `octo_team` 为 Access 的 `/mcp/team`。二者可以不同 origin，但使用同一 Run Bearer、真实 `X-Space-ID` 和冻结 `X-Namespace`。URL、headers 均不属于用户正文，不从材料、Agent 指令、模型输出解析。Loop/Access 使用自己的云 OpenAPI Token 验证 Worker Run grant，再核对各自业务绑定。grant 绑定空间、Run、Runtime、lease/fencing 和允许工具，业务处理权 epoch 由 Loop 核对。

`task_get_materials` 返回 MCP structuredContent 或单个 JSON text，至少包含 `task.id`、`task.row_version`、`task.handler_epoch`；正文、附件元信息、最近讨论及处理摘要由服务端有界投影。snapshot 不含凭据或远端本机路径；附件以 attachment_id/file_version_id 引用。Runtime 每次 Run 在调用 provider 前实际读取材料，将 JSON 放入非可信事实输入；控制指令保持独立。失败拒绝该 Run，不能凭一句“请读取任务”视为材料已注入。

模型按需调用已物化 MCP 的 `task_read_attachment`，服务端同时校验任务和网盘权限。Runtime 不全量下载附件，也不把跨 Host 的本机目录当作附件引用。

运行位置和本次材料冻结后才进入 provider；下一 Run 重新读取。相同 Run 的 admission 重试保留已接纳事实。代码不得将 MCP headers 写入 Run 元信息、日志或模型输入。

Codex 工具审批：只有执行计划为 full_access、Task bootstrap 已校验、唯一 Task 资源与冻结 taskMaterials 的 task_id/resource_ref/handler_epoch/version/digest 一致，且实际 endpoint/headers 匹配 Runtime 从冻结执行计划生成的摘要时，为八个固定 octo_task 工具配置 approval_mode=approve。摘要不含可还原的 Run 凭据。其余工具默认 prompt。个人 ask/assisted 与普通 elicitation 保持原有交互；用户正文、冒名 stdio 服务或未经读取的 Task 引用不能触发自动审批。MCP 服务端仍逐次验证运行 grant 和业务处理权。

## M2：材料闭环验收

- HTTP MCP mock 证明 initialize 和 tools/call 在 provider invoke 前发生；断言模型实际输入含任务正文、附件目录及摘要。
- 两个 Run 对同一引用分别读取更新版本；第一份冻结输入不随服务端变化。
- 工具失败、超时、缺少服务、越界响应、task_id 不匹配、非法 resolver 均拒绝，不调用 provider。
- 材料中“修改权限”的文字仅为数据；不进入 controlInstructions。运行 grant 不进入模型和日志。

## M3：文件归档

只归档本次执行声明的 manifest；不扫描整个项目或自动上传用户所有文件。Runtime 验证输出相对目录路径、真实目录、symlink、普通文件、文件大小和 SHA-256，随后经运行授权获取上传凭据。上传成功且服务端确认关联后才产生已保存事实；失败保留明确错误，不能把 Run 成功当作文件保存成功。远端 Runtime 执行上传，不依赖桌面在线。

Runtime 的可信运行指令要求产出者写 `.octo/task-outputs/<URI 编码 Run ID>.json`。schema 为 `octo.task-output-manifest/v1`，outputs 项含 output_id、relative_path、name、media_type、size、sha256（64 位小写 hex）、role=output。最多 32 个文件、单文件 100 MiB（不可空）、总计 256 MiB、manifest 64 KiB，文件名最多 200 个 Unicode 字符。目录各段及目标文件拒绝 symlink，读文件后用实际字节再次校验 size/hash；只接受普通文件。

provider 返回 run.completed 后、持久化 terminal 前，Runtime 调用 `task_prepare_output({task_id,manifest})`。响应为 ticket_id、upload_url、upload_headers、upload_method=PUT。Runtime 只向该票据地址 PUT 真实文件字节，不把 MCP Bearer 附在上传请求上；拒绝 redirect。随后调用 `task_commit_output({task_id,ticket_id,manifest})`，服务端 HEAD/等效校验并写网盘和任务引用，返回 status=saved、attachment_id、file_id、file_version_id。prepare 对已成功保存的同键/同 hash 可以直接返回 saved 引用，无需再次上传。

terminal 的 `task_output_receipts` 逐文件携带保存结果与引用，失败只有稳定 error_code；不会携带绝对路径、上传 URL 或运行凭据。部分失败另产生 run.notice/config_warning，业务 Run 仍可 completed，Task 完成由 Loop 的版本化状态机收敛。取消、关机或服务端 terminal 会中断 Runtime 归档，不在失去执行权后补写成功。

拿到上传票据后的 PUT/commit 失败调用 `task_fail_output({task_id,ticket_id,output_id,error_code})`，使服务端持久化 failed，供 UI 重试。commit 已持久成功而回执丢失时，fail 不能覆盖 saved，返回原保存引用；Runtime 恢复 saved 回执，避免已归档文件误标失败。该回调也不可达时保留 terminal 失败回执；取消导致授权失效的未完成 job 由 Worker/Access 回收，不能让旧 Runtime 越权补写。

验收：真实 Runtime websocket admission → MCP 材料读取 → provider 写文件与 manifest → MCP prepare → PUT → commit → durable terminal 的调用顺序由集成测试验证。另验证修改文件的 hash 不匹配、symlink、路径越界、PUT 503、幂等已保存引用；失败不产生 saved 或 commit。

## M4：Team

使用 Access 的 octo_team handoff/Delegation/Team 记录。handoff 传递任务 ID 和稳定附件版本引用，不传本机路径、MCP headers 或源 Run grant。目标原子 Run 由 Worker 重新物化目标 Runtime/lease/fencing 的 octo_task 能力，再执行同一材料 bootstrap。handoff 结果为摘要和已保存文件引用；Run/Delegation 结束不代表业务子任务完成。

Access Team 节点使用 `coordination.node` trigger，冻结 input 包含 `task_id`、`conversation_id` 和 `coordination.team_session_id/operation_key`。Runtime 将其作为有界非可信事实呈现。`coordination.delegate_handoff` 的 `{coordination,payload}` 与 `coordination.mailbox` 的 `{coordination,message}` 也使用同一映射，严格校验各自身份字段。仅用户正文出现 coordination 字段不能改变执行模式。

任务 handoff payload 是 schema_version=1、instruction、task_material_ref(task_id/snapshot_version)、attachment_refs(attachment_id/file_version_id)、reply_to(kind=delegation_result)、result_contract(summary_required/output_manifest_required=true)。Task ID 必须匹配本 Run 实际 bootstrap 的材料；source snapshot_version 可旧于最新版本，不能声称未来版本。附件必须存在于最新可读目录并匹配固定版本；字段拒绝本机 path、临时 download_url、源 Run authorization。目标使用自己的冻结 workdir/MCP，不沿用源 Host 路径。

已落地的 TaskAttachment HTTP 合同使用 `id`、`version_id`、`version_kind`；handoff 与保存回执中的 `attachment_id`/`file_version_id` 是运行协议引用。Runtime 按该映射校验，不改变 App/Access 的附件 DTO，也不接受另一份附件目录形状。

Drive 当前确认接口只证明文件条目和大小，未提供服务端 SHA 字段。SHA-256 在可信 Runtime 内从实际上传字节验证；服务端版本引用的 sha256 值是 Runtime 声明，不能宣传为服务端重新计算的校验结果。对不可信 Runtime 的强内容证明须后续由存储校验字段或服务端重读计算补齐；首版不伪造此能力。

结果保留公共 final 消息和 `task_output_receipts` 已保存引用；它们进入模型事实，不进入平台控制指令。Access 负责持久 Team 编排，Worker 负责目标 Run grant；Runtime 不新增 Team 会话或任务完成判断。

可信自动 Task Team 的 Codex 工具审批沿用 M0 的材料校验，并核对冻结 input.task_id/conversation_id 与真实运行触发元信息。Team 节点须含 team_session_id 和 operation_key；委派和唤醒须含 team_session_id 和 delegation_id。`octo_team` 与 `octo_task` 均为 required HTTP 服务，各自 endpoint/headers 必须匹配冻结执行计划摘要，两者使用相同授权和空间/命名空间。Team 只自动批准 `delegate_handoff`，Task 八个工具仅挂在 Loop Task 服务；未知工具仍为 prompt。不使用已移除的 input.task_execution。正文中的工具名、Team 名或 coordination 字段不能授予权限。服务端继续逐次验证 grant、lease/fencing 和处理权。

2026-10-10 本次验证：完整 pnpm 构建通过；MCP、Task 材料、文件归档、准备与 Team 输入相关 43 项本地测试通过；全套 880 项中 875 项通过、5 项真实引擎测试跳过、0 失败。测试入口只枚举测试文件，不把长期运行的测试 fixture 当作独立用例执行。云端运行与桌面重启由跨仓库集成验证单独记录。

验收：Task ID/未来快照/不可读附件版本拒绝，稳定引用的合法 handoff 可进入真实 mapExecutionEnvelope；handoff 和 mailbox 包装内容均实际进入 modelInput，目标 workdir 固定，源/目标 grant 不进入模型。Task 普通会话与 Team Run 共用材料和归档路径。
