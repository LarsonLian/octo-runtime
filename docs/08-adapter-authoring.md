# 08 Adapter 开发指南

## 最小契约

一个 adapter 的必需部分只有两项：静态元数据 `metadata`，以及把 provider 原生输出转换成 Orbtex 规范事件流的 `invoke`。`metadata` 必须包含字符串 `type` 和能力数组 `capabilities`，没有额外能力时也要传空数组。`probe` 是建议实现的可选项；如果省略，Host 会把探测结果标记为 `unchecked`，不代表 provider 已经确认可用。

```js
import { defineAdapter, probeCommand } from "@orbtex-ai/orbtex-adapter-sdk";

export const adapter = defineAdapter({
  metadata: {
    type: "my-provider",
    capabilities: ["session.serialize"]
  },
  probe: () => probeCommand("my-provider"),
  async *invoke(request) {
    yield { type: "session.update", payload: { providerSession: { sessionId: "..." } } };
    yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { type: "message.delta", payload: { text: "result" } };
    yield { type: "message.update", payload: { role: "assistant", status: "completed" } };
    yield { type: "run.finished", payload: {} };
  }
});
```

在 [`config/adapters.json`](../config/adapters.json) 中登记 `type`、模块路径和导出名称。导出对象可以直接是 adapter，也可以通过 `factory` 加 `options` 创建实例。Host 会校验导出形状；清单声明了 `type` 时，还会校验它是否与 `metadata.type` 一致。

## 设计规则

1. Provider 原生协议的解析必须留在 adapter 内；core 不得导入任何 provider 专属包。
2. Provider session 必须通过 `session.update` 上报，不得塞进终态事件的 payload，也不得写入工作目录文件来传递。
3. 不得把 provider 的原始事件名直接当作 Orbtex 规范事件类型发出。
4. 在可能的情况下，先发出 create 事件，再发出对应的 delta；Host 的补齐逻辑只用于安全兜底。
5. 每次调用只产生一个终态事件；Host 会等异步生成器清理完成后再向上游转发该事件。
6. 必须响应 `request.signal`，把取消请求传递给直接启动的 provider 子进程并完成资源清理。当前 SDK 只负责向直接子进程请求终止，不保证进程一定退出；生产 adapter 必须补齐超时后的 `SIGKILL` 升级，以及整个进程组或后代进程树的回收。
7. 控制指令应优先通过 provider 原生的 system、developer 或配置通道传递。Provider 没有独立载体时，可以使用明确记录的兼容降级；例如 OpenClaw local 会把控制指令与用户输入分段放入同一个 user message，但不得把这种降级宣称为原生 system role。
8. Token 和其他敏感值不得出现在命令行参数、prompt、事件 payload 或工作目录中。
9. `metadata.capabilities` 只能声明已经端到端实现并验证过的能力，不能把规划中的能力提前写入。

## Adapter 接入验收清单

- 实现 `probe` 时，覆盖 provider 命令存在和不存在两种情况；不实现时，验证 Host 返回 `unchecked`。
- Provider 支持 session 或 adapter 声明 `session.serialize` 时，原生 session ID 能正确转换为 `session.update`。
- 使用固定样例覆盖文本和 provider 错误；provider 能输出分析过程、工具调用或用量统计时，再覆盖对应事件。
- 覆盖成功退出、非零退出码、缺少终态事件、清理失败和取消调用。
- Provider 支持恢复 session 时，校验新建 session 与恢复 session 两种命令形态。
- 使用文件承载私密 prompt 或控制配置时，文件权限必须是 `0600`，并在调用结束后删除。
- 针对固定版本的 provider 执行只读在线冒烟测试。

[`test/adapters.test.js`](../test/adapters.test.js) 和 [`test/host.test.js`](../test/host.test.js) 是基础契约的参考测试套件，并未自动覆盖上述每一种 provider 行为。新增或修改 adapter 时，需要在对应 package 测试、公共契约测试和固定版本在线冒烟测试之间补齐整张验收清单。
