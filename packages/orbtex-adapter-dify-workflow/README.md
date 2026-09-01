# @orbtex-ai/orbtex-adapter-dify-workflow

Dify 固定参数应用的远程 provider adapter。默认接入 Workflow 的 `POST /workflows/run`；同一 factory 也能用 `applicationMode: "completion"` 接入文本生成应用的 `POST /completion-messages`。

默认 Adapter type：`dify-workflow`。Completion 模式默认 type：`dify-completion`。

官方契约：[Workflow API](https://docs.dify.ai/zh/api-reference/guides/workflow)、[执行工作流](https://docs.dify.ai/zh/api-reference/workflow-runs/run-workflow)、[文本生成应用](https://docs.dify.ai/zh/api-reference/guides/completion)。

## 为什么它与 Chatflow 分开

- Chatflow 有长期 `conversation_id`，适合普通多轮 query，声明 `session.serialize`。
- Workflow / Completion 每次调用独立，没有 provider conversation；它们的核心输入是固定 schema 的 `inputs`。
- 因此 stateless adapter 不制造 `session.update`，即使上层入口是 Orbtex Chat，也只复用 Harness Session，不宣称 Dify 侧有对话记忆。

## 单输入：直接把 Chat prompt 填入一个槽位

如果 Dify Workflow 只有一个主要文本参数，可以在 manifest 配置 `promptInput`：

```json
{
  "type": "dify-workflow",
  "module": "@orbtex-ai/orbtex-adapter-dify-workflow",
  "export": "createDifyWorkflowAdapter",
  "factory": true,
  "options": {
    "apiKeyEnv": "DIFY_WORKFLOW_API_KEY",
    "baseUrl": "https://api.dify.ai/v1",
    "promptInput": "query",
    "outputKey": "result",
    "defaultInputs": {
      "language": "zh-CN",
      "tone": "concise"
    }
  }
}
```

每次 Orbtex `request.prompt` 会写入 `inputs.query`。`defaultInputs` 适合真正固定且非敏感的值；本轮 `context.workflowInputs` 可以覆盖默认值。

## 多输入：小模型槽位提取

可以使用小模型，但应当是 adapter 之前的显式 **Input Resolver**：

```text
用户 Chat query
  -> 读取 Dify GET /parameters 的 user_input_form
  -> 小模型按 JSON Schema 提取槽位
  -> 确定性校验 required / type / enum / range
  -> 缺少关键槽位时向用户追问
  -> 写入 InvokeRequest.context.workflowInputs
  -> dify-workflow adapter
```

不要在 adapter 内部隐藏地再调用一次模型，原因是：

- 会产生不可见的成本、延迟和失败点；
- 同一个 Run 的审计无法解释 inputs 从何而来；
- 槽位缺失时应该进入用户澄清，而不是猜值后执行有副作用的 workflow；
- adapter 应保持 `structured inputs -> provider request` 的确定性。

建议 Input Resolver 输出：

```json
{
  "workflowInputs": {
    "customer_id": "C-1024",
    "date_from": "2026-08-01",
    "date_to": "2026-08-31",
    "format": "markdown"
  },
  "missingRequired": [],
  "evidence": {
    "customer_id": "用户原话中的 C-1024"
  }
}
```

其中 `evidence` 留在 resolver 审计记录，不发送给 Dify。API key、tenant ID 等可信控制字段必须由服务端补齐，禁止让模型从自然语言生成。

## Workflow 使用

```bash
export DIFY_WORKFLOW_API_KEY='app-...'
export ORBTEX_HOME=/absolute/path/to/runtime-state
pnpm daemon
```

```bash
pnpm cli adapter probe dify-workflow
pnpm cli agent create --name report-workflow --adapter dify-workflow --workdir "$PWD"
pnpm cli chat create --agent <agent-id> --title "Report workflow"
pnpm cli chat send <session-id> --prompt "生成 8 月客户报告"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

若没有配置 `promptInput`，普通 `chat send` 的 prompt 不会自动进入任意 Dify input；调用方必须提供 `context.workflowInputs`。当前 Orbtex CLI 尚未提供 `--input key=value`，多槽位流程需要 control plane / Input Resolver 调用 Core。

## Completion 模式

文本生成 App 使用同一个 package 的另一个 factory 配置：

```json
{
  "type": "dify-completion",
  "module": "@orbtex-ai/orbtex-adapter-dify-workflow",
  "export": "createDifyWorkflowAdapter",
  "factory": true,
  "options": {
    "type": "dify-completion",
    "applicationMode": "completion",
    "apiKeyEnv": "DIFY_COMPLETION_API_KEY",
    "promptInput": "topic"
  }
}
```

Completion 会把 prompt 同时作为兼容 `query` 发送；新应用仍应通过 `promptInput` 把它放入明确的 input key。

## 输出与事件

- `workflow_started` 和节点事件 -> `surface.*(kind=workflow_progress)`。
- `text_chunk` -> `message.delta`。
- `workflow_finished.data.outputs` 优先按 `outputKey` 选择文本；未配置时依次尝试 `text`、`answer`、`result`、`output` 或唯一输出。
- 无法选成单一文本的多字段 outputs -> `surface.create(kind=structured_output)`。
- `workflow_finished` -> 唯一 `run.finished/error/stopped`。
- Completion 的 `message/message_end` -> `message.*` + `run.finished`。

大型或含文件的 outputs 后续应进入 artifact store；当前 structured output 会直接进入开放 canonical payload，需要由部署方限制结果大小。

## 取消与能力边界

Workflow 收到取消时调用 `/workflows/tasks/{task_id}/stop`；Completion 调用 `/completion-messages/{task_id}/stop`。当前没有实现基于 `workflow_run_id` 的断线恢复，因此不声明 `run.reattach`。
