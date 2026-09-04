import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import {
  buildDifyChatRequest,
  createDifyChatflowAdapter
} from "@mininglamp-oss/octo-harness-adapter-dify-chatflow";
import {
  buildDifyStatelessRequest,
  createDifyWorkflowAdapter
} from "@mininglamp-oss/octo-harness-adapter-dify-workflow";
import { parseDifyEvent, parseSse } from "@mininglamp-oss/octo-harness-dify-client";

const request = {
  invocationId: "inv-dify-1",
  sessionId: "session-dify-1",
  runId: "run-dify-1",
  prompt: "你好",
  workdir: process.cwd(),
  context: {},
  appendInstructions: "只给结论",
  agentConfig: {}
};

test("Dify SSE parser handles ping, CRLF, multiline data, and split UTF-8", async () => {
  const source = [
    "event: ping\r\n\r\n",
    "id: evt-1\r\n",
    "data: {\"event\":\"message\",\r\n",
    "data: \"answer\":\"你好\"}\r\n\r\n"
  ].join("");
  const bytes = new TextEncoder().encode(source);
  const split = bytes.indexOf(0xe5) + 1;
  const body = byteStream([bytes.slice(0, split), bytes.slice(split)]);
  const frames = [];
  for await (const frame of parseSse(body)) frames.push(frame);

  assert.deepEqual(frames[0], { event: "ping" });
  assert.equal(frames[1].id, "evt-1");
  assert.equal(parseDifyEvent(frames[1]).answer, "你好");
});

test("Dify Chatbot stream becomes canonical session, message, usage, and terminal events", async () => {
  const requests = [];
  const adapter = createDifyChatflowAdapter({
    apiKey: "test-key",
    fetch: fakeSseFetch([
      { event: "message", task_id: "task-1", message_id: "message-1", conversation_id: "conversation-1", mode: "chat", answer: "你" },
      { event: "message", task_id: "task-1", message_id: "message-1", conversation_id: "conversation-1", mode: "chat", answer: "好" },
      { event: "message_end", task_id: "task-1", message_id: "message-1", conversation_id: "conversation-1", metadata: { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } }
    ], requests)
  });
  const events = await invokeThroughHost(adapter, "dify-chatflow", request);

  assert.deepEqual(events.map(event => event.type), [
    "session.update", "message.create", "message.delta", "message.delta",
    "usage.update", "message.update", "run.finished"
  ]);
  assert.equal(events.find(event => event.type === "session.update").payload.providerSession.sessionId, "conversation-1");
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "你好");
  assert.equal(events.find(event => event.type === "usage.update").payload.totalTokens, 5);
  assert.equal(JSON.parse(requests[0].init.body).query, "你好");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
});

test("Dify Chat request resumes conversation and user without leaking instructions into query", () => {
  const built = buildDifyChatRequest({
    ...request,
    providerSession: { sessionId: "conversation-existing", user: "octo-harness-user-existing" },
    context: { workflowInputs: { locale: "zh-CN" } },
    agentConfig: { providerOptions: { inputs: { tenant: "tenant-a" } } }
  }, { defaultInputs: { tone: "short" } });

  assert.equal(built.body.conversation_id, "conversation-existing");
  assert.equal(built.body.user, "octo-harness-user-existing");
  assert.equal(built.body.query, "你好");
  assert.equal(String(built.body.query).includes("只给结论"), false);
  assert.deepEqual(built.body.inputs, { tone: "short", tenant: "tenant-a", locale: "zh-CN" });
});

test("Dify request builders send modelInput when a hidden channel context turn exists", () => {
  const exact = { ...request, prompt: "display-current", modelInput: "context-delta\n\ndisplay-current" };
  const chat = buildDifyChatRequest(exact, {});
  const workflow = buildDifyStatelessRequest(exact, {
    applicationMode: "completion",
    promptInput: "query"
  });
  assert.equal(chat.body.query, exact.modelInput);
  assert.equal(workflow.body.query, exact.modelInput);
  assert.equal(workflow.body.inputs.query, exact.modelInput);
});

test("Dify Chatflow waits for workflow_finished after message_end", async () => {
  const adapter = createDifyChatflowAdapter({
    apiKey: "test-key",
    fetch: fakeSseFetch([
      { event: "workflow_started", task_id: "task-2", workflow_run_id: "workflow-run-2", conversation_id: "conversation-2", data: { id: "workflow-run-2" } },
      { event: "node_started", task_id: "task-2", workflow_run_id: "workflow-run-2", data: { node_id: "node-1", node_type: "llm", title: "Answer" } },
      { event: "message", task_id: "task-2", message_id: "message-2", conversation_id: "conversation-2", mode: "advanced-chat", answer: "done" },
      { event: "message_end", task_id: "task-2", message_id: "message-2", conversation_id: "conversation-2" },
      { event: "workflow_finished", task_id: "task-2", workflow_run_id: "workflow-run-2", data: { status: "succeeded", total_tokens: 7, total_steps: 1 } }
    ])
  });
  const events = await invokeThroughHost(adapter, "dify-chatflow", { ...request, invocationId: "inv-dify-chatflow", runId: "run-dify-chatflow" });

  assert.equal(events.filter(event => event.type.startsWith("run.")).length, 1);
  assert.equal(events.at(-1).type, "run.finished");
  assert.equal(events.some(event => event.type === "surface.create"), true);
  assert.equal(events.some(event => event.type === "surface.delta"), true);
  assert.equal(events.find(event => event.type === "run.finished").payload.workflowRunId, "workflow-run-2");
});

test("Dify HTTP 200 error event becomes run.error", async () => {
  const adapter = createDifyChatflowAdapter({
    apiKey: "test-key",
    fetch: fakeSseFetch([{ event: "error", task_id: "task-error", status: 500, code: "provider_error", message: "node failed" }])
  });
  const events = await invokeThroughHost(adapter, "dify-chatflow", { ...request, invocationId: "inv-dify-error" });
  assert.equal(events.at(-1).type, "run.error");
  assert.equal(events.at(-1).payload.code, "provider_error");
  assert.equal(events.at(-1).payload.providerStatus, 500);
});

test("Dify Chat cancellation aborts SSE and calls provider stop once", async () => {
  const requests = [];
  const adapter = createDifyChatflowAdapter({
    apiKey: "test-key",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      if (String(input).endsWith("/stop")) return new Response(null, { status: 200 });
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            event: "message",
            task_id: "task-cancel",
            message_id: "message-cancel",
            conversation_id: "conversation-cancel",
            mode: "chat",
            answer: "started"
          })}\n\n`));
          init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  const host = new AdapterHost();
  host.register(adapter);
  const events = [];
  const invocation = { ...request, invocationId: "inv-dify-cancel" };
  for await (const event of host.invoke("dify-chatflow", invocation)) {
    events.push(event);
    if (event.type === "message.delta") assert.equal(host.cancel(invocation.invocationId, "test_cancel"), true);
  }

  assert.equal(events.at(-1).type, "run.stopped");
  assert.equal(events.filter(event => event.type.startsWith("run.")).length, 1);
  assert.equal(requests.some(item => item.input.endsWith("/chat-messages/task-cancel/stop")), true);
});

test("Dify Workflow merges fixed inputs, prompt slot, and resolver output deterministically", () => {
  const built = buildDifyStatelessRequest({
    ...request,
    context: { workflowInputs: { format: "markdown", query: "resolver override" } },
    agentConfig: { providerOptions: { inputs: { tenant: "tenant-a" } } }
  }, {
    applicationMode: "workflow",
    defaultInputs: { language: "zh-CN", format: "text" },
    promptInput: "query"
  });

  assert.equal(built.path, "/workflows/run");
  assert.deepEqual(built.body.inputs, {
    language: "zh-CN",
    format: "markdown",
    tenant: "tenant-a",
    query: "resolver override"
  });
});

test("Dify Workflow output becomes canonical final message and terminal", async () => {
  const adapter = createDifyWorkflowAdapter({
    apiKey: "test-key",
    promptInput: "query",
    outputKey: "result",
    fetch: fakeSseFetch([
      { event: "workflow_started", task_id: "task-wf", workflow_run_id: "run-wf", data: { id: "run-wf" } },
      { event: "workflow_finished", task_id: "task-wf", workflow_run_id: "run-wf", data: { status: "succeeded", outputs: { result: "workflow result" }, total_tokens: 9, total_steps: 2 } }
    ])
  });
  const events = await invokeThroughHost(adapter, "dify-workflow", { ...request, invocationId: "inv-workflow", runId: "run-workflow" });

  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "workflow result");
  assert.equal(events.at(-1).type, "run.finished");
  assert.equal(events.some(event => event.type === "session.update"), false);
});

test("Dify Completion mode uses completion endpoint and message_end terminal", async () => {
  const requests = [];
  const adapter = createDifyWorkflowAdapter({
    type: "dify-completion-test",
    applicationMode: "completion",
    apiKey: "test-key",
    promptInput: "topic",
    fetch: fakeSseFetch([
      { event: "message", task_id: "task-completion", message_id: "message-completion", mode: "completion", answer: "generated" },
      { event: "message_end", task_id: "task-completion", message_id: "message-completion", metadata: { usage: { total_tokens: 4 } } }
    ], requests)
  });
  const events = await invokeThroughHost(adapter, "dify-completion-test", { ...request, invocationId: "inv-completion" });

  assert.equal(new URL(requests[0].input).pathname, "/v1/completion-messages");
  assert.equal(JSON.parse(requests[0].init.body).inputs.topic, "你好");
  assert.equal(events.at(-1).type, "run.finished");
});

function fakeSseFetch(nativeEvents, requests = []) {
  return async (input, init = {}) => {
    requests.push({ input: String(input), init });
    const payload = ["event: ping\n\n", ...nativeEvents.map(event => `data: ${JSON.stringify(event)}\n\n`)].join("");
    return new Response(byteStream([new TextEncoder().encode(payload)]), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  };
}

function byteStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

async function invokeThroughHost(adapter, type, invocation) {
  const host = new AdapterHost();
  host.register(adapter);
  const events = [];
  for await (const event of host.invoke(type, invocation)) events.push(event);
  return events;
}
