---
type: Guide
title: Adapter 开发指南
description: 开发 Provider Adapter 的最小接口与验收步骤。
tags: []
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# Adapter 开发指南

## 最小契约

一个 adapter 提供静态元数据 `metadata` 和 `invoke`。元数据包含 `type`、`capabilities`、`agentSources` 和 `executionFeatures`；`defineAdapter` 在未声明输出模式时补 canonical-only 的 `protocolSupport`。`probe` 是可选项；省略时 Host 标记为 `unchecked`，不代表 Provider 已确认可用。

```js
import { defineAdapter, probeCommand } from "@mininglamp-oss/octo-runtime-adapter-sdk";

export const adapter = defineAdapter({
  metadata: {
    type: "my-provider",
    capabilities: ["react"],
    agentSources: ["provisioned"],
    executionFeatures: ["session.serialize"]
  },
  probe: () => probeCommand("my-provider"),
  async *invoke(request) {
    yield { protocolVersion: 2, type: "session.update", payload: { providerSession: { sessionId: "..." } } };
    yield { protocolVersion: 2, type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { protocolVersion: 2, type: "message.delta", payload: { text: "result" } };
    yield { protocolVersion: 2, type: "message.update", payload: { role: "assistant", status: "completed" } };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  }
});
```

在 [`config/adapters.json`](../../config/adapters.json) 中登记 `type`、模块路径和导出名称。导出对象可以直接是 adapter，也可以通过 `factory` 加 `options` 创建实例。Host 会校验导出形状；清单声明了 `type` 时，还会校验它是否与 `metadata.type` 一致。

## 设计规则

1. Provider 原生协议的解析必须留在 adapter 内；core 不得导入任何 provider 专属包。
2. Provider session 必须通过 `session.update` 上报，不得塞进终态事件的 payload，也不得写入工作目录文件来传递。
3. 不得把 provider 的原始事件名直接当作 Octo Runtime 规范事件类型发出。
4. 在可能的情况下，先发出 create 事件，再发出对应的 delta；Host 的补齐逻辑只用于安全兜底。
5. 每次调用只产生一个终态事件；Host 会等异步生成器清理完成后再向上游转发该事件。
6. 必须响应 `request.signal`，把取消请求传递给直接启动的 provider 子进程并完成资源清理。当前 SDK 只负责向直接子进程请求终止，不保证进程一定退出；生产 adapter 必须补齐超时后的 `SIGKILL` 升级，以及整个进程组或后代进程树的回收。
7. 控制指令应优先通过 Provider 原生的 system、developer 或配置通道传递。Provider 没有独立载体时，必须明确记录所用载体；例如 Antigravity 将控制指令和用户输入放入同一 user 消息的不同 text block，不得宣称为原生 system role。OpenClaw 使用原生额外系统提示载体。
8. Token 和其他敏感值不得出现在命令行参数、prompt、事件 payload 或工作目录中。
9. `metadata.capabilities` 表达公开行为；会话、审批等放到 `executionFeatures`，输出模式放到 `protocolSupport`。只能声明已实现的支持范围，并单独记录真实 Provider 验证范围。

上例演示 canonical 事件生成；调用 Host 时显式指定 `{ protocolMode: "canonical" }`。需要 native 时实现 Driver 与独立控制帧，不能直接声明支持后继续只返回 canonical 事件。详情见 [模式合同](../rules/output-protocol.md)。

## Adapter 接入验收清单

- 实现 `probe` 时，覆盖 provider 命令存在和不存在两种情况；不实现时，验证 Host 返回 `unchecked`。
- Provider 支持 session 或 adapter 声明 `session.serialize` 时，原生 session ID 能正确转换为 `session.update`。
- 使用固定样例覆盖文本和 provider 错误；provider 能输出分析过程、工具调用或用量统计时，再覆盖对应事件。
- 覆盖成功退出、非零退出码、缺少终态事件、清理失败和取消调用。
- Provider 支持恢复 session 时，校验新建 session 与恢复 session 两种命令形态。
- 使用文件承载私密 prompt 或控制配置时，文件权限必须是 `0600`，并在调用结束后删除。
- 针对固定版本的 provider 执行只读在线冒烟测试。

[`test/adapters.test.js`](../../test/adapters.test.js) 和 [`test/host.test.js`](../../test/host.test.js) 是基础契约的参考测试套件，并未自动覆盖上述每一种 provider 行为。新增或修改 adapter 时，需要在对应 package 测试、公共契约测试和固定版本在线冒烟测试之间补齐整张验收清单。
