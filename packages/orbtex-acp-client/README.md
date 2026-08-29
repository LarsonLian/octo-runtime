# @orbtex-ai/orbtex-acp-client

Orbtex 使用的轻量 ACP stdio client。目前主要服务于 CodeBuddy adapter，把 ACP JSON-RPC request/response、session update 和反向权限请求封装成可消费的 TypeScript API。

## 作用

- 启动支持 ACP 的本地 CLI 子进程并通过 NDJSON stdio 通信。
- 关联并发 JSON-RPC request/response，管理超时和 provider 退出错误。
- 支持 `initialize`、`session/new`、`session/load`、`session/prompt` 与 `session/cancel`。
- 把 `session/update` notification 转换成 `AsyncGenerator<AcpUpdate>`。
- 处理 provider -> client 的权限反向请求。

## 设计原则

1. **协议与 adapter 分层**：本包不生成 Orbtex canonical event，映射由 CodeBuddy adapter 完成。
2. **默认拒绝权限**：未配置 permission handler 时优先选择 reject/deny option，避免静默提权。
3. **Session ID 原样传递**：ACP session 由 provider 拥有，client 只负责创建、恢复和路由 update。
4. **流式消费**：prompt response 与 session updates 汇合为 async iterable，不要求调用方缓存完整输出。
5. **失败统一传播**：无效 JSON、超时、stderr/进程退出会终止 pending request 和 update queue。

## 适用场景

- 为 CodeBuddy 或其他兼容 ACP stdio 的本地 Agent CLI 编写 Orbtex adapter。
- 在合同测试中使用 fake ACP 子进程验证 session、usage、权限和取消。
- 需要比完整 ACP SDK 更小的 Node.js 客户端边界时。

本实现不是通用 ACP 全能力 SDK；当前没有暴露文件系统、terminal、MCP server 或所有 capability 协商扩展。

## 使用示例

```ts
import { spawnAcpClient } from "@orbtex-ai/orbtex-acp-client";

const client = spawnAcpClient({
  command: "codebuddy",
  args: ["--acp"],
  cwd: process.cwd()
});

try {
  await client.initialize();
  const session = await client.newSession({ cwd: process.cwd() });
  for await (const update of client.prompt(session.id, "Inspect this repository")) {
    console.log(update);
  }
} finally {
  await client.close();
}
```

CodeBuddy 的完整接入教程见 [CodeBuddy Adapter](../orbtex-adapter-codebuddy/README.md)。
