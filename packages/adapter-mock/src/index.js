import { defineAdapter } from "@orbtex-ai/adapter-sdk";

export const mockAdapter = defineAdapter({
  metadata: { type: "mock", capabilities: ["session.serialize", "tool.canonical"] },
  async *invoke(req) {
    yield { type: "session.update", payload: { providerSession: { sessionId: `mock:${req.sessionId}` } } };
    yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { type: "message.delta", payload: { text: `Handled: ${req.prompt}` } };
    yield { type: "message.update", payload: { role: "assistant", status: "completed", text: `Handled: ${req.prompt}` } };
    yield { type: "run.finished", payload: {} };
  }
});
