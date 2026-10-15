export const playboardAdapter = {
  metadata: {
    type: "playboard-test",
    protocolSupport: {
      protocol: "playboard-test.canonical",
      modes: ["canonical"],
      nativeMethods: []
    },

    agentSources: ["provisioned", "preset"],
    executionFeatures: [
      "approval.ask",
      "approval.full_access",
      "interaction.response",
      "input.image"
    ]
  },
  async respondInteraction() {},
  async *invoke(request) {
    process.stderr.write("playboard fixture diagnostic\n");
    const { signal, ...wire } = request;
    yield {
      protocolVersion: 2,
      type: "message.delta",
      payload: { text: JSON.stringify({ ...wire, hostPid: process.pid, daemonPid: process.ppid }) }
    };
    if (request.prompt === "broken-pipe") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: { text: "after consumer closed" }
      };
      if (!signal.aborted)
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return;
    }
    if (request.prompt === "hang") {
      if (!signal.aborted)
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return;
    }
    yield {
      protocolVersion: 2,
      type: "session.update",
      payload: { providerSession: { sessionId: "playboard-provider", resumable: true } }
    };
    yield {
      protocolVersion: 2,
      type: request.prompt === "fail" ? "run.failed" : "run.completed",
      payload: {}
    };
  }
};
