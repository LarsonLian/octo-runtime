export const testAdapter = {
  metadata: { type: "test", capabilities: ["session.serialize", "tool.canonical"] },
  async *invoke(request) {
    await Promise.resolve();
    yield { type: "session.update", payload: { providerSession: { sessionId: `test:${request.agentSessionId}` } } };
    yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { type: "message.delta", payload: { text: `Handled: ${request.prompt}` } };
    yield { type: "message.update", payload: { role: "assistant", status: "completed", text: `Handled: ${request.prompt}` } };
    yield { type: "run.finished", payload: {} };
  }
};
