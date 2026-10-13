export const testAdapter = {
  metadata: { protocolSupport: { protocol: "test.canonical", modes: ["canonical"], nativeMethods: [] }, type: "test", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["session.serialize", "tool.canonical", "approval.ask", "approval.assisted", "approval.full_access"] },
  async *invoke(request) {
    if (request.prompt === "wait-for-host-exit") await new Promise(() => {});
    await Promise.resolve();
    yield { protocolVersion: 2, type: "session.update", payload: { providerSession: { sessionId: `test:${request.agentSessionId}` } } };
    yield { protocolVersion: 2, type: "message.create", payload: { role: "assistant", status: "streaming" } };
    yield { protocolVersion: 2, type: "message.delta", payload: { text: `Handled: ${request.prompt}` } };
    yield { protocolVersion: 2, type: "message.update", payload: { role: "assistant", status: "completed", text: `Handled: ${request.prompt}` } };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  }
};
