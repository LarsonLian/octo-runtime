# octo-runtime-extra-sse-demo

仅供演示的原生 Node HTTP Extra。稳定插件名称为 `sse-demo`，默认导出加载 lambda。设计和配置管理见 [Extra 插件说明](../../.octospec/rules/extras.md)。

## CLI模式配置与启动

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

## SDK模式加载

宿主使用已安装的插件路径，明确声明加载配置：

```ts
import { createDaemonRuntime } from "@mininglamp-oss/octo-runtime-daemon";

const runtime = createDaemonRuntime({
  appId: "my-app",
  home: "/absolute/app-owned/runtime-home",
  development: true,
  extras: [{
    name: "sse-demo",
    module: "/absolute/installed-extra/dist/index.js",
    config: { host: "127.0.0.1", port: 3002, token: "local-demo-token" }
  }]
});
await runtime.startAccount({
  subject: { type: "user", id: "local-user" },
  tenants: [{ id: "local-space", name: "Local" }]
});
```

HostApp 决定安装路径和加载哪些插件。SDK 不自行下载安装 Runtime。

## 统一调用

所有 URL 路径接受同样的 POST。body 与 CLI playboard、SDK `invoke(input)`、AdapterHost `invoke(input)` 使用同一份 `InvokeInput` JSON；完整字段与默认值见 [协议](../../.octospec/rules/invoke-input.md)。

```sh
curl -N --fail-with-body 'http://127.0.0.1:3002' \
  -H 'Authorization: Bearer local-demo-token' \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "inputs": [{ "type": "text", "text": "回复 OK，不使用工具。" }],
  "contexts": {
    "schema": "octo.context-envelope/v3",
    "items": [{ "namespace": "octo.execution", "name": "adapter", "payload": { "type": "codex" } }]
  },
  "sessionId": "local-trial",
  "protocol_mode": "canonical"
}
JSON
```

请求经同一协议校验并交给 `invoke(input, {signal})`。signal 由插件本地创建，不可从 body 传入。图片仍使用 inputs 的 image part；其他可选字段、Provider 扩展参数与当前 Context 保留。插件不添加模型背景、不注册设备、不安装 Provider。

每个输出为 `data: <JSON>\n\n`。默认 native 输出 HostFrame；canonical 输出 CanonicalEvent。Host 执行异常使用 `event: error` 和 `HOST_INVOKE_FAILED`，不暴露异常中的凭据。观察真实终态决定执行结果，HTTP 200 不代表执行成功。

| HTTP 状态 | 含义 |
| --- | --- |
| 401 | 缺少或错误的 Bearer Token |
| 405 | 方法不是 POST |
| 400 | JSON 或统一 InvokeInput 无效 |
| 413 | 请求 body 超过 16 MiB |
| 503 | 插件正在停止 |

本例不提供交互响应接口、浏览器 CORS、自动重试或恢复历史。需要审批交互时使用现有运行接口。

## 卸载

```sh
octo-runtime extra unload sse-demo
```

卸载触发 AbortSignal、关闭 HTTP 监听和已有连接，并等待请求任务退出，本地共享 Host 继续存在。重新加载可使用 `extra load sse-demo`；持久停用则写入 `enabled: false` 并重启。
