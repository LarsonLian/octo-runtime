# octo-runtime-extra-sse-demo

仅供演示的原生 Node HTTP Extra。稳定插件名称为 `sse-demo`，默认导出加载 lambda。设计和配置管理见 [Extra 插件说明](../../docs/extra-plugins.md)。

## 配置与启动

在已经安装此包的 Runtime 发行物中：

```sh
octo-runtime extraset sse-demo <<'JSON'
{
  "module": "@mininglamp-oss/octo-runtime-extra-sse-demo",
  "enabled": true,
  "config": {
    "host": "127.0.0.1",
    "port": 3002,
    "token": "local-demo-token"
  }
}
JSON

octo-runtime daemon restart
octo-runtime extra status
```

`host` 缺省为 `127.0.0.1`，接受 IP 地址；`port` 缺省为 3002，范围 1–65535。`token` 必填、非空、不含空白。`Authorization` 必须为 `Bearer <token>`；认证失败返回 401 且不调用 Host。

## 完整调用

所有 URL 路径接受同样的 POST，不存在专属路由。以下例子选择 codex 和 canonical 输出；工作目录改为本机实际绝对路径，三个执行/会话 ID 在不同调用间按业务语义生成。

```sh
curl -N --fail-with-body 'http://127.0.0.1:3002' \
  -H 'Authorization: Bearer local-demo-token' \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "adapterType": "codex",
  "options": { "protocolMode": "canonical" },
  "request": {
    "protocolVersion": 2,
    "invocationId": "demo-invocation-1",
    "runId": "demo-run-1",
    "agentSessionId": "demo-session-1",
    "sessionGeneration": 0,
    "agentSource": "provisioned",
    "prompt": "Reply exactly DEMO_OK. Do not call tools.",
    "modelInput": "Reply exactly DEMO_OK. Do not call tools.",
    "controlInstructions": "",
    "context": { "schema": "octo.context-envelope/v3", "items": [] },
    "approvalMode": "full_access",
    "agentConfig": {},
    "workdir": "/absolute/workspace"
  }
}
JSON
```

请求原样交给现有 `invoke()`，只有不能通过 JSON 传递的 `signal` 由插件本地创建。不得从 HTTP body 传入伪造 signal。必要配置、协议及身份由现有执行边界校验。插件不添加模型背景、不注册设备、不安装 Provider。

每个输出为 `data: <JSON>\n\n`。默认 native 输出 HostFrame；canonical 输出 CanonicalEvent。Host 执行异常使用 `event: error` 和 `HOST_INVOKE_FAILED`，不暴露异常中的凭据。观察真实终态决定执行结果，HTTP 200 不代表执行成功。

| HTTP 状态 | 含义 |
| --- | --- |
| 401 | 缺少或错误的 Bearer Token |
| 405 | 方法不是 POST |
| 400 | JSON、InvokeRequest 或 options 无效 |
| 413 | 请求 body 超过 1 MiB |
| 503 | 插件正在停止 |

本例不提供交互响应接口、浏览器 CORS、自动重试或恢复历史。需要审批交互时使用现有运行接口；示例选择 full_access 只是为了演示一轮执行。

## 卸载

```sh
octo-runtime extra unload sse-demo
```

卸载触发 AbortSignal、关闭 HTTP 监听和已有连接，并等待请求任务退出，本地共享 Host 继续存在。重新加载可使用 `extra load sse-demo`；持久停用则写入 `enabled: false` 并重启。
