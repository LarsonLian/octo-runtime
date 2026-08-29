import { defineAdapter } from "@orbtex-ai/orbtex-adapter-sdk";

export const mockAdapter = defineAdapter({
  metadata: { type: "mock", capabilities: ["session.serialize", "tool.canonical"] },
  async *invoke(req) {
    // 保持与真实 provider 相同的异步边界，测试不会依赖同步生成器的偶然行为。
    await Promise.resolve();
    yield { type: "session.update", payload: { providerSession: { sessionId: `mock:${req.sessionId}` } } };
    yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { type: "message.delta", payload: { text: `Handled: ${req.prompt}` } };
    yield { type: "message.update", payload: { role: "assistant", status: "completed", text: `Handled: ${req.prompt}` } };
    yield { type: "run.finished", payload: {} };
  }
});
