export function createExecutorFixture() {
  const pending = new Map();
  const respond = async (id, response) => {
    const interaction = pending.get(id);
    if (!interaction || (response.requestId ?? response.interactionId) !== "fixture-approval")
      throw new Error("INTERACTION_NOT_ACTIVE");
    pending.delete(id);
    interaction(response);
  };
  return {
    metadata: {
      type: "executor-fixture",
      agentSources: ["provisioned"],
      protocolSupport: {
        protocol: "executor.fixture",
        modes: ["native", "canonical"],
        nativeMethods: []
      }
    },
    probe: () => ({ available: true, command: process.execPath }),
    respondInteraction: respond,
    respondNative: respond,
    async *invoke(request, context) {
      if (request.prompt === "terminate-worker") process.exit(23);
      if (request.prompt === "throw") throw new Error("fixture startup failure");
      if (request.prompt === "invalid") {
        yield { kind: "native", messageKind: "invalid", payload: {} };
        return;
      }
      const { signal, ...snapshot } = request;
      if (request.prompt === "approval") {
        const answered = new Promise((resolve) => pending.set(request.invocationId, resolve));
        try {
          if (context.protocolMode === "native")
            yield {
              kind: "control",
              control: {
                type: "interaction",
                requestId: "fixture-approval",
                status: "pending",
                expiresAt: Date.now() + 60000
              }
            };
          else
            yield {
              protocolVersion: 2,
              type: "interaction.requested",
              payload: {
                interactionId: "fixture-approval",
                kind: "approval",
                executionInstanceId: request.invocationId,
                expiresAt: new Date(Date.now() + 60000).toISOString(),
                request: {
                  schema: "octo.approval-request/v1",
                  policy: { mode: request.approvalMode, hash: `sha256:${"a".repeat(64)}` },
                  operation: { kind: "tool_execution", summary: "Proceed?" },
                  requestedPermissions: [],
                  allowedOutcomes: ["accepted", "declined", "cancelled"],
                  grantScope: "request"
                }
              }
            };
          await answered;
          if (context.protocolMode === "native")
            yield {
              kind: "control",
              control: { type: "interaction", requestId: "fixture-approval", status: "resolved" }
            };
          else
            yield {
              protocolVersion: 2,
              type: "interaction.resolved",
              payload: {
                interactionId: "fixture-approval",
                executionInstanceId: request.invocationId,
                status: "resolved",
                outcome: "accepted"
              }
            };
        } finally {
          pending.delete(request.invocationId);
        }
      }
      if (context.protocolMode === "native")
        yield { kind: "native", messageKind: "notification", payload: snapshot };
      else
        yield {
          protocolVersion: 2,
          type: "message.delta",
          payload: { channel: "final", text: JSON.stringify(snapshot) }
        };
      if (request.prompt === "hold")
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        });
      if (request.prompt === "no-terminal") return;
      if (context.protocolMode === "native")
        yield { kind: "control", control: { type: "state", state: "completed" } };
      else yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  };
}
