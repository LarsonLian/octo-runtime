import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../apps/daemon/dist/agent-work-runtime.js";
import { contextEnvelope, executionContext, resolvedRuntimeSelection, wire, waitFor } from "./agent-work-runtime-fixture.js";

// 真实 HTTP/WS 准备和派发链路，仅替换 Provider，验证总时限不会在阶段切换时重置。
async function exercise({ timeout = 150, sealDelay = 0, invoke, admission, task = false, compactionPort }, verify) {
  const directory = await mkdtemp(join(tmpdir(), "octo-run-deadline-"));
  const frames = [];
  const calls = [];
  const timers = new Set();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume HTTP body. */ }
    if (request.url === "/v1/runtime/context/prepare" || request.url === "/task-mcp") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      }, request.url === "/task-mcp" ? 1_000 : sealDelay);
      timers.add(timer);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-deadline", protocol_version: 2 } }));
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, websocket => websocketServer.emit("connection", websocket));
  });
  const plan = { agent_source: "provisioned", adapter_type: "fake", approval_mode: "full_access",
    workspace: { mode: "fixed", path: directory }, workdir: directory,
    runtime_limits: { run_timeout_ms: timeout, enforcement: "enforce" } };
  const envelope = {
    schema_version: 7, context_configuration_version: 1,
    effective_context: executionContext(plan, compactionPort ? [{ namespace: "octo.content", name: "inline",
      payload: { entries: [{ text: "material to measure" }] } }] : []), resolved_execution_plan: plan,
    resolved_runtime_selection: resolvedRuntimeSelection("runtime-deadline"),
    run_id: "run-deadline", agent_session_id: "session-deadline",
    agent_run_request: { context: contextEnvelope(), namespace: "test", agent_id: "agent-deadline",
      agent_revision_id: "revision-deadline", session_key: "deadline",
      trigger: { kind: "test", occurrence_id: "deadline" }, input: { prompt: "Return done" } },
    agent_revision: { definition: { instructions: "Return done" } }
  };
  websocketServer.on("connection", websocket => websocket.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    if (frame.type === "runtime.hello") {
      websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
      websocket.send(wire("runtime.command", { server_seq: 1, command_id: "command-deadline", run_id: "run-deadline",
        type: "run.start", payload: envelope, lease_id: "lease-deadline", fencing_token: 1 }));
    }
  }));
  let runtime;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    if (task) {
      const content = Buffer.from("deadline output");
      await writeFile(join(directory, "output.txt"), content);
      await mkdir(join(directory, ".octo/task-outputs"), { recursive: true });
      await writeFile(join(directory, ".octo/task-outputs/run-deadline.json"), JSON.stringify({
        schema: "octo.task-output-manifest/v1", outputs: [{ output_id: "proof", relative_path: "output.txt",
          name: "output.txt", media_type: "text/plain", size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"), role: "output" }]
      }));
      plan.mcp_servers = { octo_task: { type: "streamable_http", url: `http://127.0.0.1:${server.address().port}/task-mcp` } };
    }
    runtime = new AgentWorkRuntime({ profile: "default", baseUrl: `http://127.0.0.1:${server.address().port}`,
      token: "fixture-only", runtimeName: "runtime-deadline", storePath: join(directory, "state.db"),
      ...(compactionPort ? { createMaterialCompactionPort: compactionPort } : {}) }, {
      list: async () => [{ type: "fake", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: [], available: true }],
      cancel: async () => ({ cancelled: true }),
      async *invoke(_type, request) {
        calls.push(request);
        if (task) request.runMetadata.taskMaterials = [{ task_id: "task-deadline" }];
        yield* invoke(request);
      }
    }, undefined, admission);
    await runtime.start();
    const events = () => frames.filter(frame => frame.type === "run.event_batch").flatMap(frame => frame.payload.events);
    const ack = () => frames.find(frame => frame.type === "command.ack")?.payload;
    await verify({ calls, frames, events, ack });
  } finally {
    await runtime?.close();
    for (const timer of timers) clearTimeout(timer);
    for (const client of websocketServer.clients) client.terminate();
    await new Promise(resolve => websocketServer.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("Run deadline includes HTTP context preparation and prevents provider dispatch", async () => {
  await exercise({ sealDelay: 400, invoke: async function* () { throw Error("unexpected dispatch"); } }, async ({ calls, ack }) => {
    await waitFor(() => ack(), 3_000);
    assert.equal(ack().accepted, false);
    assert.equal(ack().error.code, "ADAPTER_RUN_DEADLINE", JSON.stringify(ack()));
    assert.equal(ack().error.timeoutStage, "context.preparation");
    assert.equal(calls.length, 0);
  });
});

test("Run deadline subtracts preparation time from provider watchdog", async () => {
  await exercise({ timeout: 800, sealDelay: 120, invoke: async function* () {
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  } }, async ({ calls, events }) => {
    await waitFor(() => events().some(event => event.type === "run.completed"), 3_000);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].runtimeLimits.runTimeoutMs < 700);
    assert.ok(calls[0].runtimeLimits.runTimeoutMs >= 100);
  });
});

test("Run deadline preserves classification when compaction transport throws AbortError", async () => {
  await exercise({ compactionPort: async ({ signal }) => ({ model: "fixture", contextWindow: 100_000,
    outputReserveTokens: 1000, summaryInputLimit: 10_000, toolsDisabled: true,
    measureInputTokens: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }), countTokens: async () => 10, summarize: async () => { throw Error("unexpected summary"); }
  }), invoke: async function* () { throw Error("unexpected dispatch"); } }, async ({ ack, calls }) => {
    await waitFor(() => ack(), 3_000);
    assert.equal(ack().accepted, false);
    assert.equal(ack().error.code, "ADAPTER_RUN_DEADLINE", JSON.stringify(ack()));
    assert.equal(calls.length, 0);
  });
});

test("Run deadline cancels admission before dispatch", async () => {
  const admission = { acquire: signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) };
  await exercise({ admission, invoke: async function* () { throw Error("unexpected dispatch"); } }, async ({ calls, ack }) => {
    await waitFor(() => ack(), 3_000);
    assert.equal(ack().accepted, false);
    assert.equal(ack().error.code, "ADAPTER_RUN_DEADLINE");
    assert.equal(ack().error.timeoutStage, "runtime.admission");
    assert.equal(calls.length, 0);
  });
});

for (const terminal of ["run.cancelled", "run.completed"]) {
  test(`Run deadline overrides provider ${terminal} after abort`, async () => {
    await exercise({ invoke: async function* (request) {
      await new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }));
      yield { protocolVersion: 2, type: terminal, payload: {} };
    } }, async ({ events }) => {
      await waitFor(() => events().some(event => event.type === "run.failed"), 3_000);
      const failed = events().find(event => event.type === "run.failed");
      assert.equal(failed.payload.code, "ADAPTER_RUN_DEADLINE");
      assert.equal(failed.payload.timeoutReason, "run_deadline");
      assert.equal(failed.payload.timeoutStage, "adapter.invoke");
      assert.ok(!events().some(event => event.type === "run.completed" || event.type === "run.cancelled"));
    });
  });
}

test("Run deadline classifies thrown provider errors after cancellation", async () => {
  await exercise({ invoke: async function* (request) {
    await new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }));
    throw Error("provider transport ended");
  } }, async ({ events }) => {
    await waitFor(() => events().some(event => event.type === "run.failed"), 3_000);
    assert.equal(events().find(event => event.type === "run.failed").payload.code, "ADAPTER_RUN_DEADLINE");
  });
});

test("Run deadline remains active through task output archiving", async () => {
  await exercise({ task: true, invoke: async function* () {
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  } }, async ({ events }) => {
    await waitFor(() => events().some(event => event.type === "run.failed"), 3_000);
    const failure = events().find(event => event.type === "run.failed");
    assert.equal(failure.payload.code, "ADAPTER_RUN_DEADLINE");
    assert.equal(failure.payload.timeoutStage, "task.output.archive");
    assert.ok(!events().some(event => event.type === "run.completed"));
  });
});
