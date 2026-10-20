import assert from "node:assert/strict";
import {
  AgentExecutor,
  type HostedAdapter,
  type InvokeInput,
  type HostFrame,
  type InteractionResponse,
  type ExecutorShutdownResult
} from "@mininglamp-oss/octo-runtime/executor-core";
import type { CanonicalEvent } from "@mininglamp-oss/octo-runtime/protocol";

export async function verifyExecutorCore(): Promise<void> {
  const replies = new Map<string, () => void>();
  const adapter: HostedAdapter = {
    metadata: {
      type: "release-fixture",
      agentSources: ["provisioned"],
      protocolSupport: {
        protocol: "release.fixture",
        modes: ["native", "canonical"],
        nativeMethods: []
      }
    },
    probe: () => ({ available: true, command: process.execPath }),
    async *invoke(request, context) {
      if (context?.protocolMode === "canonical") {
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
        return;
      }
      let reply!: () => void;
      const answered = new Promise<void>((resolve) => {
        reply = resolve;
      });
      replies.set(request.invocationId, reply);
      try {
        yield {
          kind: "control",
          control: {
            type: "interaction",
            requestId: 7,
            status: "pending",
            expiresAt: Date.now() + 60000
          }
        };
        await answered;
        yield {
          kind: "control",
          control: { type: "interaction", requestId: 7, status: "resolved" }
        };
        yield { kind: "native", messageKind: "notification", payload: { answer: "public core" } };
        yield { kind: "control", control: { type: "state", state: "completed" } };
      } finally {
        replies.delete(request.invocationId);
      }
    },
    async respondNative(id, response) {
      const reply = replies.get(id);
      assert.equal(response.requestId, 7);
      assert.ok(reply);
      reply();
    }
  };
  const executor = new AgentExecutor();
  executor.register(adapter);
  assert.equal(executor.list()[0].type, "release-fixture");
  assert.equal((await executor.describe())[0].available, true);
  const input = {
    inputs: [{ type: "text", text: "public" }],
    contexts: {
      schema: "octo.context-envelope/v3",
      items: [
        { namespace: "octo.execution", name: "adapter", payload: { type: "release-fixture" } },
        { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } }
      ]
    },
    invocationId: "public-native",
    runId: "public-native-run"
  } satisfies InvokeInput;
  const frames: HostFrame[] = [];
  for await (const frame of executor.invoke(input)) {
    frames.push(frame);
    if (
      frame.kind === "control" &&
      frame.control.type === "interaction" &&
      frame.control.status === "pending"
    )
      await executor.respondNative("public-native", {
        requestId: 7,
        payload: { result: "accepted" }
      });
  }
  const terminal = frames.at(-1);
  assert.ok(terminal?.kind === "control" && terminal.control.type === "state");
  assert.equal(terminal.control.state, "completed");
  const events: CanonicalEvent[] = [];
  for await (const event of executor.invoke({
    ...input,
    invocationId: "public-canonical",
    runId: "public-canonical-run",
    protocol_mode: "canonical"
  })) {
    events.push(event);
    // @ts-expect-error Canonical overload must not collapse into HostFrame.
    const wrong: HostFrame = event;
    void wrong;
  }
  assert.equal(events.at(-1)?.type, "run.completed");
  const cancel = executor.invokeFrames({
    ...input,
    invocationId: "public-cancel",
    runId: "public-cancel-run"
  });
  await cancel.next();
  assert.equal(executor.cancel("public-cancel"), true);
  const cancelled: HostFrame[] = [];
  for await (const frame of cancel) cancelled.push(frame);
  assert.equal(cancelled.at(-1)?.kind, "control");
  const result: ExecutorShutdownResult = await executor.shutdown();
  assert.equal(result.cleanup, "complete");
  await assert.rejects(
    executor.invokeFrames({ ...input, invocationId: "after-close" }).next(),
    /EXECUTOR_CLOSED/
  );
}

export async function checkResponses(executor: AgentExecutor, response: InteractionResponse) {
  await executor.respondInteraction("id", response);
  // @ts-expect-error Responses require an interaction ID.
  await executor.respondInteraction("id", { outcome: "accepted" });
}
