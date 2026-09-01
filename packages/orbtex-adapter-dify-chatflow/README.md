# @orbtex-ai/orbtex-adapter-dify-chatflow

Dify Chatbot / Chatflow 远程 provider adapter。

Adapter type：`dify-chatflow`

它调用 `POST /chat-messages`，把 Dify 的 HTTP + SSE 输出转换成 Orbtex `session/message/usage/surface/run` canonical events。Dify Chatbot 与 Chatflow 共用该 endpoint，但终态不同；adapter 默认自动识别：

- Chatbot：`message_end` 是成功终态。
- Chatflow：先出现 `workflow_started`，`message_end` 后继续等待 `workflow_finished`。

官方契约：[Chatflow API](https://docs.dify.ai/zh/api-reference/guides/chatflow)、[发送对话消息](https://docs.dify.ai/zh/api-reference/chat-messages/send-chat-message)、[SSE 指南](https://docs.dify.ai/zh/api-reference/guides/streaming)。

## 配置

API key 只放环境变量：

```bash
export DIFY_CHATFLOW_API_KEY='app-...'
```

默认 base URL 是 `https://api.dify.ai/v1`。仓库的 `config/adapters.json` 已使用 factory 注册：

```json
{
  "type": "dify-chatflow",
  "module": "@orbtex-ai/orbtex-adapter-dify-chatflow",
  "export": "createDifyChatflowAdapter",
  "factory": true,
  "options": {
    "apiKeyEnv": "DIFY_CHATFLOW_API_KEY",
    "baseUrl": "https://api.dify.ai/v1",
    "applicationMode": "auto"
  }
}
```

不要把 key 写进 manifest、Agent config、prompt 或 source。自建 Dify 可改 `baseUrl`；非 localhost 地址必须使用 HTTPS。

## 使用 Orbtex Chat

启动 daemon 前导出环境变量，adapter-host 会继承：

```bash
cd /absolute/path/to/orbtex
export DIFY_CHATFLOW_API_KEY='app-...'
export ORBTEX_HOME=/absolute/path/to/runtime-state
pnpm daemon
```

另一个终端使用相同 `ORBTEX_HOME`：

```bash
pnpm cli adapter probe dify-chatflow

pnpm cli agent create \
  --name dify-assistant \
  --adapter dify-chatflow \
  --workdir "$PWD"

pnpm cli chat create --agent <agent-id> --title "Dify chat"
pnpm cli chat send <session-id> --prompt "你好，请介绍你自己"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

第二次对同一 Orbtex Session 执行 `chat send` 时，Core 会把第一轮 `session.update` 保存的 Dify `conversation_id` 放回 `request.providerSession`。Adapter 同时复用首次请求的 Dify `user`，满足 Dify 对会话和文件的用户隔离要求。

## 事件映射

| Dify event | Orbtex event |
|---|---|
| 首次 `conversation_id` | `session.update`，`sessionId=conversation_id` |
| `message` / `agent_message` | `message.create` + `message.delta` |
| `message_end.metadata.usage` | `usage.update` |
| `workflow_started` | `surface.create(kind=workflow_progress)` |
| node / iteration / loop events | `surface.delta`；只保留 ID、类型、标题、状态、耗时和错误 |
| `message_file` | `surface.create(kind=provider_file)` |
| Chatbot `message_end` | `message.update` + `run.finished` |
| Chatflow `workflow_finished: succeeded` | `surface.update` + `run.finished` |
| `error` / failed workflow | `run.error` |
| `workflow_paused` | `surface.update(status=paused)` + `run.stopped(resumable=true)` |

当前 Orbtex 没有一等 `run.paused` / interaction 状态，因此人工介入暂停只能收敛为可恢复的 `run.stopped`。这不会伪装成正常完成。

## Inputs、控制指令与附件

请求 `inputs` 按以下优先级合并，后者覆盖前者：

1. adapter factory 的 `defaultInputs`；
2. `agentConfig.providerOptions.inputs`；
3. 本轮 `context.workflowInputs`。

Dify `/chat-messages` 没有独立 system/developer carrier。Adapter 默认不会把 `appendInstructions` 偷偷拼进用户 query。若 Chatflow 显式定义了控制输入变量，可在 factory 配置 `instructionInput`，adapter 才把控制指令写入该 input。

当前 v1 附件约定从 `request.context.attachments` 读取，只接受受控远程 URL 或已经上传到 Dify 的 file ID：

```json
{
  "attachments": [
    { "type": "image", "url": "https://example.test/image.png" },
    { "type": "document", "uploadFileId": "dify-file-id" }
  ]
}
```

Adapter 不读取任意本机路径，也不把文件 base64 塞进 event。Orbtex CLI 目前还没有附件参数；完整 artifact bridge 需要由上层先上传到 Dify `/files/upload`，并把 file ID 放入 context。

## Factory options

| 字段 | 默认值 | 说明 |
|---|---|---|
| `type` | `dify-chatflow` | 允许同一 host 注册多个 Dify app，例如 `dify-support` |
| `baseUrl` | `https://api.dify.ai/v1` | Dify API base |
| `apiKeyEnv` | `DIFY_CHATFLOW_API_KEY` | 读取 key 的环境变量名 |
| `userPrefix` | `orbtex` | 默认 Dify user 为 `<prefix>:<sessionId>` |
| `applicationMode` | `auto` | `auto` / `chatbot` / `chatflow` |
| `defaultInputs` | `{}` | 每轮固定输入 |
| `instructionInput` | 无 | 显式承载 Orbtex 控制指令的 Dify input key |
| `workflowId` | 最新发布版本 | Chatflow 指定发布 workflow 版本 |
| `autoGenerateName` | `true` | Dify 是否自动生成会话标题 |
| `exposeWorkflowEvents` | `true` | 是否将节点进度映射为 surface |
| `maxFrameChars` | `1048576` | 单个 SSE frame 字符上限 |

## 取消与限制

收到 Orbtex `AbortSignal` 后，adapter 中断本地 SSE reader，并在已获得 `task_id` 时调用 `POST /chat-messages/{task_id}/stop`。Host 最终只输出一个 `run.stopped`。

当前没有实现 Dify `workflow_run_id` 断线重连，因此不声明 `run.reattach`。`message_file` 暂时保留 provider URL；生产投递前应拉取到 Orbtex artifact store，不能把 Dify 短期 URL 当永久产物。
