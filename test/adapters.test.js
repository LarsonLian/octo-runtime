import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  createJsonCliAdapter
} from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { createCodeBuddyAdapter } from "@mininglamp-oss/octo-runtime-adapter-codebuddy";
import { acpModelSelectionRequest, createAcpAdapter, normalizeAcpUpdate } from "@mininglamp-oss/octo-runtime-adapter-acp";
import { hermesAdapter } from "@mininglamp-oss/octo-runtime-adapter-hermes";
import { kimiCodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-kimi-code";
import { mcodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-mcode";
import { qoderCliAdapter } from "@mininglamp-oss/octo-runtime-adapter-qodercli";
import { qoderCliCnAdapter } from "@mininglamp-oss/octo-runtime-adapter-qoderclicn";
import {
  buildCodexCommand,
  CodexEventNormalizer,
  createCodexAdapter,
  normalizeCodexEvent
} from "@mininglamp-oss/octo-runtime-adapter-codex";
import {
  buildClaudeCommand,
  ClaudeEventNormalizer,
  createClaudeCodeAdapter,
  normalizeClaudeEvent
} from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { buildOpenCodeCommand, createOpenCodeAdapter, normalizeOpenCodeEvent } from "@mininglamp-oss/octo-runtime-adapter-opencode";
import { contextHash } from "@mininglamp-oss/octo-runtime-protocol";
import {
  buildOpenClawGatewayInvocation,
  createOpenClawDeviceIdentity,
  createOpenClawAdapter,
  OpenClawGatewayClient,
  OpenClawTranscriptNormalizer,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  tryParseOpenClawTranscriptLine
} from "@mininglamp-oss/octo-runtime-adapter-openclaw";

const request = { protocolVersion: 2, invocationId: "inv-1", agentSessionId: "session-1", runId: "run-1", prompt: "work", modelInput: "work", workdir: process.cwd(), context: { schema: "octo.context-envelope/v3", items: [] }, controlInstructions: "CONTROL", approvalMode: "full_access", agentSource: "provisioned", agentConfig: {} };

function acpPermissionFixture(createAdapter, options) {
  let nextRequestId = 1;
  let spawnOptions;
  const state = { responses: [], sideEffects: 0, spawnOptions: undefined };
  const params = {
    toolCall: { toolCallId: "permission-tool", title: "Write the requested file" },
    options
  };
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "permission-session" } : {},
    async *prompt() {
      const response = await spawnOptions.permissionHandler(params);
      state.responses.push(response);
      spawnOptions.onPermissionResponseWritten(params);
      if (response.outcome.optionId === "allow-once") state.sideEffects += 1;
      yield { sessionUpdate: "agent_message_chunk", content: { text: "done" } };
      yield { type: "prompt_result", stopReason: "end_turn" };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAdapter({ acpClientFactory: options => {
    spawnOptions = options;
    state.spawnOptions = options;
    return client;
  } });
  return { adapter, state };
}

const openClawGatewayMethods = ["agents.list", "sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort"];

function openClawGatewayHello() {
  return { type: "hello-ok", protocol: 4, features: { methods: openClawGatewayMethods, events: ["agent"] } };
}

test("Codex native events map to session/message/usage/terminal", () => {
  assert.equal(normalizeCodexEvent({ method: "thread/started", params: { thread: { id: "thread-1" } } })[0].type, "session.update");
  assert.deepEqual(
    normalizeCodexEvent({ method: "thread/compacted", params: { threadId: "thread-1" } }).find(event => event.type === "session.update").payload,
    { providerSession: { sessionId: "thread-1", resumable: true, resumeOutcome: "compacted" } }
  );
  assert.equal(normalizeCodexEvent({ method: "item/agentMessage/delta", params: { itemId: "message-1", delta: "ok" } })[0].type, "message.delta");
  assert.equal(normalizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { last: { inputTokens: 1 }, total: { inputTokens: 2 } } }
  })[0].type, "usage.update");
  assert.deepEqual(
    normalizeCodexEvent({ method: "turn/completed", params: { turn: { status: "completed" } } }).map(x => x.type),
    ["run.completed"]
  );
});

test("Codex maps commentary separately from the final answer and keeps its tools in the same model step", () => {
  const normalizer = new CodexEventNormalizer();
  normalizer.normalize({
    method: "turn/started", params: { turn: { id: "turn-commentary", status: "inProgress" } }
  });

  const started = normalizer.normalize({
    method: "item/started",
    params: {
      turnId: "turn-commentary",
      item: { type: "agentMessage", id: "progress-1", phase: "commentary" }
    }
  });
  assert.deepEqual(started.map(event => event.type), ["model_step.started", "message.create"]);
  assert.equal(started[1].payload.channel, "commentary");

  assert.deepEqual(normalizer.normalize({
    method: "item/agentMessage/delta",
    params: { turnId: "turn-commentary", itemId: "progress-1", delta: "先检查目录" }
  })[0].payload, {
    text: "先检查目录", channel: "commentary", messageId: "progress-1",
    stepId: "codex:turn-commentary:round:1"
  });

  const completed = normalizer.normalize({
    method: "item/completed",
    params: {
      turnId: "turn-commentary",
      item: { type: "agentMessage", id: "progress-1", phase: "commentary", text: "先检查目录" }
    }
  });
  assert.deepEqual(completed.map(event => event.type), ["message.update"]);
  assert.equal(completed[0].payload.channel, "commentary");

  const tool = normalizer.normalize({
    method: "item/started",
    params: {
      turnId: "turn-commentary",
      item: { type: "commandExecution", id: "tool-1", command: "pwd", status: "inProgress" }
    }
  });
  assert.deepEqual(tool.map(event => event.type), ["tool_call.create", "model_step.finished"]);
  assert.equal(tool[0].payload.stepId, "codex:turn-commentary:round:1");

  const answer = normalizer.normalize({
    method: "item/started",
    params: {
      turnId: "turn-commentary",
      item: { type: "agentMessage", id: "answer-1", phase: "final_answer" }
    }
  });
  assert.equal(answer[1].payload.channel, "final");
  assert.equal(answer[1].payload.stepId, "codex:turn-commentary:round:2");
});

test("Codex waits for turn/completed after a non-retry error so ReAct can recover", () => {
  const normalizer = new CodexEventNormalizer();
  normalizer.normalize({
    method: "turn/started", params: { turn: { id: "turn-recovery", status: "inProgress" } }
  });
  normalizer.normalize({
    method: "item/started",
    params: { turnId: "turn-recovery", item: { type: "reasoning", id: "reasoning-before-error" } }
  });

  const diagnostic = normalizer.normalize({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-recovery",
      willRetry: false,
      error: { message: "tool execution failed" }
    }
  });
  assert.deepEqual(diagnostic.map(event => event.type), ["model_step.finished", "run.notice"]);
  assert.equal(diagnostic[1].payload.code, "provider_diagnostic");
  assert.equal(diagnostic.some(event => event.type === "run.failed"), false);

  const recovery = normalizer.normalize({
    method: "item/started",
    params: { turnId: "turn-recovery", item: { type: "reasoning", id: "reasoning-after-error" } }
  });
  assert.equal(recovery[0].type, "model_step.started");
  assert.equal(recovery[0].payload.stepId, "codex:turn-recovery:round:2");
  assert.deepEqual(
    normalizer.normalize({ method: "turn/completed", params: { turn: { id: "turn-recovery", status: "completed" } } }).at(-1),
    { protocolVersion: 2, type: "run.completed", payload: {} }
  );
});

test("Codex reasoning and plan deltas are emitted immediately with explicit exposure provenance", () => {
  const cases = [
    ["item/reasoning/summaryTextDelta", "public_summary"],
    ["item/plan/delta", "public_plan"],
    ["item/reasoning/textDelta", "private_reasoning"]
  ];
  for (const [method, exposure] of cases) {
    assert.deepEqual(
      normalizeCodexEvent({ method, params: { itemId: "analysis-1", delta: "step" } }),
      [{ protocolVersion: 2,
        type: "message.delta",
        payload: {
          text: "step",
          channel: "analysis",
          messageId: "analysis-1",
          exposure,
          provenance: { provider: "codex", nativeEvent: method }
        }
      }]
    );
  }

  assert.deepEqual(
    normalizeCodexEvent({
      method: "item/completed",
      params: {
        item: {
          type: "reasoning",
          id: "analysis-1",
          summary: ["Safe summary"],
          content: ["Private reasoning"]
        }
      }
    }),
    [{ protocolVersion: 2,
      type: "message.update",
      payload: {
        role: "assistant",
        status: "completed",
        channel: "analysis",
        exposure: "public_summary",
        provenance: { provider: "codex", nativeEvent: "item/completed" },
        messageId: "analysis-1",
        text: "Safe summary"
      }
    }]
  );
});

test("Codex reconstructs model rounds and associates reasoning, tool batches, and the final answer", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(normalizer.normalize({
    method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress" } }
  }), []);

  const first = normalizer.normalize({
    method: "item/started",
    params: { turnId: "turn-1", item: { type: "reasoning", id: "reasoning-1" } }
  });
  assert.deepEqual(first.map(event => event.type), ["model_step.started", "message.create"]);
  assert.equal(first[0].payload.stepId, "codex:turn-1:round:1");
  assert.equal(first[1].payload.stepId, first[0].payload.stepId);

  const tool = normalizer.normalize({
    method: "item/started",
    params: {
      turnId: "turn-1",
      item: { type: "commandExecution", id: "tool-1", command: "pwd", status: "inProgress" }
    }
  });
  assert.deepEqual(tool.map(event => event.type), ["tool_call.create", "model_step.finished"]);
  assert.equal(tool[0].payload.stepId, "codex:turn-1:round:1");
  assert.deepEqual(tool[1].payload, {
    stepId: "codex:turn-1:round:1", status: "completed", finishReason: "tool-calls"
  });

  const secondTool = normalizer.normalize({
    method: "item/started",
    params: {
      turnId: "turn-1",
      item: { type: "webSearch", id: "tool-2", status: "inProgress" }
    }
  });
  assert.deepEqual(secondTool.map(event => event.type), ["tool_call.create"]);
  assert.equal(secondTool[0].payload.stepId, "codex:turn-1:round:1");

  const answer = normalizer.normalize({
    method: "item/started",
    params: { turnId: "turn-1", item: { type: "agentMessage", id: "answer-1" } }
  });
  assert.deepEqual(answer.map(event => event.type), ["model_step.started", "message.create"]);
  assert.equal(answer[0].payload.stepId, "codex:turn-1:round:2");
  assert.equal(answer[1].payload.stepId, answer[0].payload.stepId);

  const completed = normalizer.normalize({
    method: "item/completed",
    params: { turnId: "turn-1", item: { type: "agentMessage", id: "answer-1", text: "done" } }
  });
  assert.deepEqual(completed.map(event => event.type), ["message.update", "model_step.finished"]);
  assert.deepEqual(completed[1].payload, {
    stepId: "codex:turn-1:round:2", status: "completed", finishReason: "stop"
  });
});

test("Codex command starts app-server over stdio", async () => {
  const command = await buildCodexCommand(request);
  assert.deepEqual(command.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(command.cwd, request.workdir);
  assert.equal(command.env.CODEX_HOME, process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"));
  await command.cleanup();
});

test("Claude native events map to session/message/terminal", () => {
  assert.equal(normalizeClaudeEvent({ type: "system", session_id: "claude-1" })[0].type, "session.update");
  assert.equal(normalizeClaudeEvent({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })[0].payload.text, "ok");
  assert.deepEqual(
    normalizeClaudeEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "permission denied" }] }
    })[0],
    { protocolVersion: 2,
      type: "tool_call.update",
      payload: {
        id: "tool-1",
        status: "failed",
        output: "permission denied",
        error: { message: "permission denied" }
      }
    }
  );
  assert.deepEqual(
    normalizeClaudeEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-2", content: [{ type: "text", text: "done" }] }] }
    })[0],
    { protocolVersion: 2, type: "tool_call.update", payload: { id: "tool-2", status: "completed", output: "done" } }
  );
  assert.equal(normalizeClaudeEvent({ type: "result", session_id: "claude-1", result: "ok", usage: {} }).at(-1).type, "run.completed");
});

test("Claude full_access uses native bypass without inventing a default effort", async () => {
  const claude = await buildClaudeCommand(request);
  assert.equal(claude.args.includes("--include-partial-messages"), true);
  assert.equal(claude.args.includes("--settings"), false);
  assert.equal(claude.args.includes("--effort"), false);
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(claude.args.includes("--dangerously-skip-permissions"), true);
  assert.equal(claude.args.includes("--disallowedTools"), false);
  await claude.cleanup();
});

test("Claude maps explicit effort as the only reasoning strength input", async () => {
  for (const effort of ["low", "medium", "high"]) {
    const tuned = await buildClaudeCommand({ ...request, agentSource: "provisioned", agentConfig: { effort } });
    assert.equal(tuned.args[tuned.args.indexOf("--effort") + 1], effort);
    assert.equal(tuned.args.includes("--settings"), false);
    await tuned.cleanup();
  }
});

test("Claude preserves an empty thinking block as a public reasoning lifecycle", () => {
  const normalizer = new ClaudeEventNormalizer();
  const native = event => ({ type: "stream_event", parent_tool_use_id: null, event });
  assert.deepEqual(normalizer.normalize(native({
    type: "message_start", message: { id: "message-empty-thinking" }
  })), [{ protocolVersion: 2,
    type: "model_step.started",
    payload: { stepId: "message-empty-thinking" }
  }]);
  assert.deepEqual(normalizer.normalize(native({
    type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" }
  })), [{ protocolVersion: 2,
    type: "message.create",
    payload: {
      role: "assistant", status: "streaming", messageId: "claude:message-empty-thinking:thinking:0",
      stepId: "message-empty-thinking",
      channel: "analysis", exposure: "public_reasoning",
      provenance: { provider: "claude-code", nativeEvent: "stream_event.thinking_start" }
    }
  }]);
  assert.deepEqual(normalizer.normalize(native({
    type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" }
  })), []);
  assert.deepEqual(normalizer.normalize(native({ type: "content_block_stop", index: 0 })), [{ protocolVersion: 2,
    type: "message.update",
    payload: {
      role: "assistant", status: "completed", messageId: "claude:message-empty-thinking:thinking:0",
      stepId: "message-empty-thinking",
      channel: "analysis", exposure: "public_reasoning",
      provenance: { provider: "claude-code", nativeEvent: "stream_event.thinking_stop" }
    }
  }]);
  assert.deepEqual(normalizer.normalize(native({
    type: "message_delta", delta: { stop_reason: "end_turn" }
  })), []);
  assert.deepEqual(normalizer.normalize(native({ type: "message_stop" })), [{ protocolVersion: 2,
    type: "model_step.finished",
    payload: { stepId: "message-empty-thinking", status: "completed", finishReason: "end_turn" }
  }]);
});

test("Claude retains public text identity and closes it at the round boundary", () => {
  const normalizer = new ClaudeEventNormalizer();
  const native = event => ({ type: "stream_event", parent_tool_use_id: null, event });
  normalizer.normalize(native({ type: "message_start", message: { id: "message-public-text" } }));
  assert.deepEqual(normalizer.normalize(native({
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll inspect " }
  })), [{ protocolVersion: 2,
    type: "message.delta",
    payload: { text: "I'll inspect ", channel: "final", messageId: "claude:message-public-text:text:0", stepId: "message-public-text" }
  }]);
  normalizer.normalize(native({
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the repository." }
  }));
  normalizer.normalize(native({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
  assert.deepEqual(normalizer.normalize(native({ type: "message_stop" })), [{ protocolVersion: 2,
    type: "message.update",
    payload: { messageId: "claude:message-public-text:text:0", channel: "final", stepId: "message-public-text", status: "completed" }
  }, { protocolVersion: 2,
    type: "model_step.finished",
    payload: {
      stepId: "message-public-text", status: "completed", finishReason: "tool_use",
    }
  }]);
});

test("Claude explicitly maps all permission modes; OpenCode routes human approvals through ACP", async () => {
  for (const [approvalMode, nativeMode] of [["ask", "default"], ["assisted", "auto"], ["full_access", "bypassPermissions"]]) {
    const spec = await buildClaudeCommand({ ...request, approvalMode });
    try {
      assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], nativeMode);
      assert.equal(spec.args.includes("--dangerously-skip-permissions"), approvalMode === "full_access");
      assert.equal(spec.args[spec.args.indexOf("--input-format") + 1], "stream-json");
      assert.equal(spec.args[spec.args.indexOf("--permission-prompt-tool") + 1], "stdio");
    } finally { await spec.cleanup(); }
  }
  assert.equal(createOpenCodeAdapter().metadata.executionFeatures.includes("approval.ask"), true);
  const adapter = createOpenCodeAdapter({ command: "/provider-must-not-launch" });
  await assert.rejects(async () => { for await (const event of adapter.invoke({ ...request, approvalMode: "assisted" })) assert.fail(event.type); }, /APPROVAL_MODE_UNSUPPORTED/);
});

test("OpenCode native events map session/text/reasoning/tool/usage", () => {
  assert.equal(normalizeOpenCodeEvent({ type: "step_start", sessionID: "oc-1", part: {} })[0].type, "session.update");
  assert.equal(normalizeOpenCodeEvent({ type: "text", part: { text: "ok" } })[0].type, "message.delta");
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "reasoning",
    part: { type: "reasoning", text: "checking the repository" }
  }), [{ protocolVersion: 2,
    type: "message.delta",
    payload: {
      text: "checking the repository",
      channel: "analysis",
      exposure: "public_reasoning",
      provenance: { provider: "opencode", nativeEvent: "reasoning" }
    }
  }]);
  assert.equal(normalizeOpenCodeEvent({ type: "step_finish", part: { tokens: { input: 1 } } })[0].type, "usage.update");
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "tool_use",
    part: {
      type: "tool",
      tool: "bash",
      callID: "call-1",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/workspace\n",
        time: { start: 1_000, end: 1_051 }
      }
    }
  }), [
    { protocolVersion: 2,
      type: "tool_call.update",
      payload: {
        id: "call-1",
        name: "bash",
        args: { command: "pwd" },
        status: "completed",
        output: "/workspace\n",
        durationMs: 51
      }
    }
  ]);
  assert.deepEqual([
    ...normalizeOpenCodeEvent({
      type: "tool_use",
      part: { type: "tool", tool: "bash", callID: "call-2", state: { status: "running", input: { command: "false" } } }
    }),
    ...normalizeOpenCodeEvent({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call-2",
        state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 2_000, end: 2_073 } }
      }
    })
  ], [
    { protocolVersion: 2, type: "tool_call.create", payload: { status: "running", id: "call-2", name: "bash", args: { command: "false" } } },
    { protocolVersion: 2,
      type: "tool_call.update",
      payload: {
        id: "call-2",
        name: "bash",
        args: { command: "false" },
        status: "failed",
        output: "exit 1",
        durationMs: 73
      }
    }
  ]);
});

test("OpenCode preserves model rounds and associates their reasoning, tools, and text", () => {
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "step_start", sessionID: "oc-1", timestamp: 1_788_793_000_000,
    part: { type: "step-start", messageID: "message-1" }
  }), [
    { protocolVersion: 2, type: "session.update", payload: { providerSession: { sessionId: "oc-1", resumable: true } } },
    { protocolVersion: 2, type: "model_step.started", payload: { stepId: "message-1", startedAtMs: 1_788_793_000_000 } }
  ]);
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "reasoning", part: { type: "reasoning", messageID: "message-1", text: "checking weather" }
  })[0], { protocolVersion: 2,
    type: "message.delta",
    payload: {
      text: "checking weather", stepId: "message-1", messageId: "opencode:message-1:reasoning",
      channel: "analysis", exposure: "public_reasoning",
      provenance: { provider: "opencode", nativeEvent: "reasoning" }
    }
  });
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "tool_use",
    part: { type: "tool", messageID: "message-1", callID: "call-1", tool: "websearch", state: { status: "running", input: { query: "宁波天气" } } }
  })[0], { protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "call-1", name: "websearch", args: { query: "宁波天气" }, stepId: "message-1" }
  });
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "step_finish", timestamp: 1_788_793_002_000,
    part: { type: "step-finish", messageID: "message-1", reason: "tool-calls", tokens: { input: 10 } }
  }), [
    { protocolVersion: 2,
      type: "model_step.finished",
      payload: { stepId: "message-1", status: "completed", finishReason: "tool-calls", endedAtMs: 1_788_793_002_000 }
    },
    { protocolVersion: 2, type: "usage.update", payload: { input: 10, cost: undefined, stepId: "message-1" } }
  ]);
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "step_finish", timestamp: 1_788_793_003_000,
    part: { type: "step-finish", messageID: "message-2", reason: "stop", tokens: { output: 4 } }
  }), [
    { protocolVersion: 2,
      type: "model_step.finished",
      payload: { stepId: "message-2", status: "completed", finishReason: "stop", endedAtMs: 1_788_793_003_000 }
    },
    { protocolVersion: 2, type: "usage.update", payload: { output: 4, cost: undefined, stepId: "message-2" } },
    { protocolVersion: 2, type: "run.completed", payload: {} }
  ]);
});

test("JSON CLI adapters reap a provider that stays alive after a semantic terminal", async () => {
  const adapter = createJsonCliAdapter({
    metadata: { type: "semantic-terminal", agentSources: ["provisioned"], executionFeatures: [] },
    buildCommand: () => ({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({done:true}));setInterval(()=>{},1000)"]
    }),
    normalize: native => native.done ? [{ protocolVersion: 2, type: "run.completed", payload: {} }] : []
  });
  const events = [];
  const startedAt = Date.now();
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.equal(events.at(-1).type, "run.completed");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("OpenCode full_access uses native auto approval, maps effort to variant, and resumes a provider session", async () => {
  const withoutVariant = await buildOpenCodeCommand(request);
  assert.deepEqual(withoutVariant.args.slice(0, 5), ["run", "--format", "json", "--thinking", "--auto"]);
  assert.equal(withoutVariant.args.filter(arg => arg === "--auto").length, 1);
  assert.equal(withoutVariant.args.includes("--variant"), false);
  await withoutVariant.cleanup();

  const opencode = await buildOpenCodeCommand({
    ...request,
    providerSession: { sessionId: "ses-existing" },
    agentSource: "provisioned", agentConfig: { model: "provider/model", effort: "high" }
  });
  assert.deepEqual(opencode.args, [
    "run", "--format", "json", "--thinking", "--auto",
    "--session", "ses-existing",
    "--model", "provider/model",
    "--variant", "high",
    "work"
  ]);
  assert.equal(opencode.providerSessionId, "ses-existing");
  await opencode.cleanup();
});

test("OpenClaw native NDJSON and pretty final blobs are parsed", () => {
  assert.deepEqual(
    tryParseOpenClawEvent('{"type":"tool_use","tool":"read","callId":"call-1","input":{"path":"README.md"}}'),
    { kind: "tool-call", id: "call-1", name: "read", args: { path: "README.md" } }
  );
  const final = tryParseOpenClawFinalBlob(JSON.stringify({
    payloads: [{ text: "first" }, { text: "second" }],
    meta: { aborted: false, agentMeta: { sessionId: "oc-1", usage: { input: 2, output: 1 } } }
  }));
  assert.equal(final.text, "first\nsecond");
  assert.equal(final.sessionId, "oc-1");
  assert.equal(final.inputTokens, 2);
});

test("OpenClaw transcript maps model rounds, public reasoning, tools, and durations", () => {
  const normalizer = new OpenClawTranscriptNormalizer();
  const assistant = tryParseOpenClawTranscriptLine(JSON.stringify({
    type: "message", id: "assistant-1", timestamp: "2026-09-08T08:00:02.000Z",
    message: {
      role: "assistant", timestamp: 1_788_854_400_000, stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "checking the workspace" },
        { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "pwd" } }
      ]
    }
  }));
  assert.ok(assistant);
  assert.deepEqual(normalizer.normalize(assistant), [
    { protocolVersion: 2,
      type: "model_step.started",
      payload: { stepId: "openclaw:assistant-1", startedAtMs: 1_788_854_400_000 }
    },
    { protocolVersion: 2,
      type: "message.delta",
      payload: {
        text: "checking the workspace", stepId: "openclaw:assistant-1",
        messageId: "openclaw:assistant-1:reasoning", channel: "analysis",
        exposure: "public_reasoning",
        provenance: { provider: "openclaw", nativeEvent: "session.transcript.thinking" }
      }
    },
    { protocolVersion: 2,
      type: "tool_call.create",
      payload: { status: "running", id: "call-1", name: "exec", args: { command: "pwd" }, stepId: "openclaw:assistant-1" }
    },
    { protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: "openclaw:assistant-1", status: "completed", finishReason: "tool-calls",
        endedAtMs: 1_788_854_402_000
      }
    }
  ]);

  const result = tryParseOpenClawTranscriptLine(JSON.stringify({
    type: "message", id: "result-1", timestamp: "2026-09-08T08:00:02.125Z",
    message: {
      role: "toolResult", toolCallId: "call-1", toolName: "exec", isError: false,
      content: [{ type: "text", text: "workspace" }], details: { durationMs: 125 }
    }
  }));
  assert.ok(result);
  assert.deepEqual(normalizer.normalize(result), [{ protocolVersion: 2,
    type: "tool_call.update",
    payload: {
      id: "call-1", name: "exec", status: "completed", output: "workspace",
      stepId: "openclaw:assistant-1", durationMs: 125
    }
  }]);
});

test("control instructions use private provider-native carriers", async () => {
  const claude = await buildClaudeCommand(request);
  const claudePath = claude.args[claude.args.indexOf("--append-system-prompt-file") + 1];
  assert.equal(await readFile(claudePath, "utf8"), "CONTROL");
  assert.equal(claude.args.includes("CONTROL"), false); await claude.cleanup();

  const opencode = await buildOpenCodeCommand(request);
  const config = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(await readFile(config.instructions.at(-1), "utf8"), "CONTROL"); await opencode.cleanup();

  const codex = buildCodexCommand(request, "codex", [], { CODEX_HOME: "/native/codex-home" });
  assert.equal(codex.env.CODEX_HOME, "/native/codex-home");
  assert.equal(codex.args.some(arg => arg.includes("mcp") || arg.includes("skill")), false);

  const openclaw = buildOpenClawGatewayInvocation({
    ...request,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner", model: "provider/model", effort: "medium", timeoutSeconds: 30,
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "SECRET_TOKEN",
        OPENCLAW_GATEWAY_DEVICE_ID: "device-1",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public-key",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private-key"
      }
    }
  });
  assert.equal(openclaw.agentParams.message, "work");
  assert.equal(openclaw.agentParams.extraSystemPrompt, "CONTROL");
  assert.equal(openclaw.agentParams.cwd, undefined);
  assert.equal(openclaw.agentParams.promptMode, undefined);
  assert.equal(openclaw.createParams.cwd, undefined);
  assert.equal(openclaw.createParams.model, "provider/model");
  assert.equal(openclaw.createParams.thinkingLevel, "medium");
  assert.match(openclaw.sessionKey, /^agent:octo-openclaw-runner:octo-run:run-1:/);
});

test("text adapters prefer the exact modelInput over the display prompt", async () => {
  const modelRequest = {
    ...request,
    invocationId: "inv-model-input",
    prompt: "DISPLAY_ONLY_MUST_NOT_REACH_PROVIDER",
    modelInput: "MODEL_INPUT_OK"
  };

  const claude = await buildClaudeCommand(modelRequest);
  assert.equal(JSON.parse(claude.input).message.content, "MODEL_INPUT_OK");
  await claude.cleanup();

  const opencode = await buildOpenCodeCommand(modelRequest);
  assert.equal(opencode.args.at(-1), "MODEL_INPUT_OK");
  await opencode.cleanup();

  const openclaw = buildOpenClawGatewayInvocation({
    ...modelRequest,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  });
  assert.equal(openclaw.agentParams.message, "MODEL_INPUT_OK");
});

test("OpenClaw Gateway client authenticates, handles accepted/final responses, aborts, and rejects malformed JSON", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  const requests = [];
  let connectionRequestId;
  server.on("connection", (socket, request) => {
    connectionRequestId = request.headers["x-request-id"];
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture-nonce", ts: Date.now() } }));
    socket.on("message", data => {
      const frame = JSON.parse(Buffer.from(data).toString("utf8"));
      requests.push(frame);
      if (frame.method === "connect") {
        assert.equal(frame.params.auth.token, "fixture-token");
        assert.ok(frame.params.caps.includes("exec-approvals"), "Gateway must recognize this CLI as an approval recipient");
        assert.match(frame.params.device.signature, /^[A-Za-z0-9_-]+$/);
        socket.send(JSON.stringify({
          type: "res", id: frame.id, ok: true,
          payload: { type: "hello-ok", protocol: 4, features: { methods: [], events: [] } }
        }));
      } else if (frame.method === "stream") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "accepted", runId: "run-fixture" } }));
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "ok", runId: "run-fixture" } }));
      } else if (frame.method === "malformed") {
        socket.send("{");
      }
    });
  });

  const client = new OpenClawGatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: "fixture-token",
    device: createOpenClawDeviceIdentity()
  });
  t.after(() => client.close());
  assert.equal((await client.connect()).protocol, 4);
  assert.match(connectionRequestId, /^req_[0-9a-f]{32}$/);

  const abort = new AbortController();
  const pending = client.request("never", {}, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /request never aborted/);

  const accepted = [];
  assert.deepEqual(await client.request("stream", {}, {
    expectFinal: true,
    onAccepted: value => accepted.push(value)
  }), { status: "ok", runId: "run-fixture" });
  assert.deepEqual(accepted, [{ status: "accepted", runId: "run-fixture" }]);

  await assert.rejects(client.request("malformed", {}), /malformed JSON/);
  assert.deepEqual(requests.map(frame => frame.method), ["connect", "never", "stream", "malformed"]);
});

test("OpenClaw Gateway adapter isolates run events, deduplicates seq, and streams tools", async () => {
  let listener = () => {};
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => { listener = () => {}; }; },
    async request(method, params, options = {}) {
      requests.push({ method, params });
      if (method === "agents.list") return { agents: [{ id: "octo-openclaw-runner" }] };
      if (method === "sessions.create") return { ok: true, key: params.key, sessionId: "gateway-session" };
      if (method === "agent.wait") return { status: "ok", runId: params.runId };
      if (method !== "agent") return { status: "completed" };
      const runId = params.idempotencyKey;
      options.onAccepted?.({ status: "accepted", runId });
      listener({ event: "agent", payload: { runId: "another-run", seq: 1, stream: "assistant", data: { text: "LEAK" } } });
      listener({ event: "agent", payload: { runId, seq: 1, stream: "lifecycle", data: { phase: "start" } } });
      listener({ event: "agent", payload: { runId, seq: 2, stream: "assistant", data: { text: "hel" } } });
      listener({ event: "agent", payload: { runId, seq: 2, stream: "assistant", data: { text: "duplicate" } } });
      listener({ event: "agent", payload: { runId, seq: 3, stream: "tool", data: { phase: "start", toolCallId: "tool-1", name: "exec", args: { command: "pwd" } } } });
      listener({ event: "agent", payload: { runId, seq: 4, stream: "tool", data: { phase: "result", toolCallId: "tool-1", name: "exec", result: "ok", isError: false } } });
      listener({ event: "agent", payload: { runId, seq: 5, stream: "assistant", data: { text: "hello" } } });
      listener({ event: "agent", payload: { runId, seq: 7, stream: "lifecycle", data: { phase: "end", stopReason: "stop" } } });
      return { status: "ok" };
    },
    close: async () => {}
  };
  const adapter = createOpenClawAdapter({ clientFactory: () => client });
  const events = [];
  for await (const event of adapter.invoke({
    ...request,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.equal(events.some(event => JSON.stringify(event).includes("LEAK")), false);
  assert.equal(events.filter(event => event.type === "message.delta" && event.payload.channel === "final").map(event => event.payload.text).join(""), "hello");
  assert.deepEqual(events.filter(event => event.type.startsWith("tool_call.")).map(event => event.type), ["tool_call.create", "tool_call.update"]);
  assert.equal(events.at(-1).type, "run.completed");
  assert.deepEqual(requests.slice(0, 4).map(entry => entry.method), ["agents.list", "sessions.create", "sessions.messages.subscribe", "agent"]);
  assert.equal(requests[1].params.cwd, undefined);
  assert.equal(requests[3].params.cwd, undefined);
  assert.ok(requests.some(entry => entry.method === "agent.wait"));

});

test("OpenClaw preset treats the provider Agent as a black box", async () => {
  let listener = () => {};
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => { listener = () => {}; }; },
    async request(method, params, options = {}) {
      requests.push({ method, params });
      if (method === "agents.list") return { agents: [{ id: "external-agent" }] };
      if (method === "sessions.create") return { key: params.key };
      if (method === "agent.wait") return { status: "ok", runId: params.runId };
      if (method === "agent") {
        const runId = params.idempotencyKey;
        options.onAccepted?.({ status: "accepted", runId });
        listener({ event: "agent", payload: { runId, seq: 1, stream: "lifecycle", data: { phase: "start" } } });
        listener({ event: "agent", payload: { runId, seq: 2, stream: "assistant", data: { text: "external result" } } });
        listener({ event: "agent", payload: { runId, seq: 3, stream: "lifecycle", data: { phase: "end", stopReason: "stop" } } });
        return { status: "ok", runId };
      }
      return { ok: true };
    },
    close: async () => {}
  };
  const adapter = createOpenClawAdapter({ clientFactory: () => client });
  const events = [];
  for await (const event of adapter.invoke({
    ...request,
    agentSource: "preset", workdir: "", agentConfig: {
      providerAgentId: "external-agent",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private",
        OPENCLAW_RUNNER_WORKSPACE: "/remote/openclaw",
        OCTO_EXTERNAL_BINDING_ID: "binding-external"
      }
    }
  })) events.push(event);

  assert.equal(requests.some(entry => entry.method === "config.get"), false);
  assert.deepEqual(requests.slice(0, 5).map(entry => entry.method), ["agents.list", "sessions.create", "sessions.messages.subscribe", "agent", "agent.wait"]);
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "external result");
  assert.equal(events.at(-1).type, "run.completed");
});

test("OpenClaw Gateway adapter reconciles a final RPC result when live events are absent", async () => {
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent() { return () => {}; },
    async request(method, params, options = {}) {
      requests.push({ method, params });
      if (method === "agents.list") return { agents: [{ id: "octo-openclaw-runner" }] };
      if (method === "sessions.create") return { ok: true, key: params.key };
      if (method === "sessions.messages.subscribe") return { status: "subscribed" };
      if (method === "agent") {
        options.onAccepted?.({ status: "accepted", runId: params.idempotencyKey });
        return {
          runId: params.idempotencyKey,
          status: "ok",
          summary: "completed",
          result: {
            payloads: [{ text: "fallback result" }],
            meta: {
              aborted: false,
              stopReason: "stop",
              agentMeta: { provider: "anthropic", model: "tencent/glm-5.3", usage: { input: 3, output: 2 } }
            }
          }
        };
      }
      return { status: "completed" };
    },
    close: async () => {}
  };
  const adapter = createOpenClawAdapter({ clientFactory: () => client });
  const events = [];
  for await (const event of adapter.invoke({
    ...request,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.deepEqual(requests.slice(0, 4).map(entry => entry.method), ["agents.list", "sessions.create", "sessions.messages.subscribe", "agent"]);
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "fallback result");
  assert.deepEqual(events.find(event => event.type === "usage.update")?.payload, {
    inputTokens: 3, outputTokens: 2, provider: "anthropic", model: "tencent/glm-5.3"
  });
  assert.equal(events.at(-1).type, "run.completed");
});

test("OpenClaw Gateway adapter refuses success when agent.wait confirms a different terminal", async () => {
  let listener = () => {};
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => {}; },
    async request(method, params, options = {}) {
      if (method === "agents.list") return { agents: [{ id: "octo-openclaw-runner" }] };
      if (method === "sessions.create") return { key: params.key };
      if (method === "sessions.messages.subscribe") return { status: "subscribed" };
      if (method === "agent.wait") return { runId: params.runId, status: "error", endedAt: Date.now(), error: "failed" };
      if (method === "agent") {
        const runId = params.idempotencyKey;
        options.onAccepted?.({ status: "accepted", runId });
        listener({ event: "agent", payload: { runId, seq: 1, stream: "lifecycle", data: { phase: "start" } } });
        listener({ event: "agent", payload: { runId, seq: 2, stream: "lifecycle", data: { phase: "end", stopReason: "stop" } } });
        return { status: "ok" };
      }
      return {};
    },
    close: async () => {}
  };
  const events = [];
  for await (const event of createOpenClawAdapter({ clientFactory: () => client }).invoke({
    ...request,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.equal(events.some(event => event.type === "run.completed"), false);
  assert.match(events.at(-1).payload.message, /confirmed failed, not completed/);
});

test("OpenClaw Gateway adapter confirms abort before emitting run.cancelled", async () => {
  let listener = () => {};
  const controller = new AbortController();
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => {}; },
    request(method, params, options = {}) {
      requests.push(method);
      if (method === "agents.list") return Promise.resolve({ agents: [{ id: "octo-openclaw-runner" }] });
      if (method === "sessions.create") return Promise.resolve({ key: params.key });
      if (method === "sessions.messages.subscribe") return Promise.resolve({ status: "subscribed" });
      if (method === "sessions.abort") return Promise.resolve({ aborted: true });
      if (method === "agent.wait") {
        return Promise.resolve({ runId: params.runId, status: "timeout", endedAt: Date.now(), stopReason: "aborted" });
      }
      if (method === "agent") {
        const runId = params.idempotencyKey;
        options.onAccepted?.({ status: "accepted", runId });
        listener({ event: "agent", payload: { runId, seq: 1, stream: "lifecycle", data: { phase: "start" } } });
        setImmediate(() => controller.abort("test-cancel"));
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Promise.resolve({});
    },
    close: async () => {}
  };
  const events = [];
  for await (const event of createOpenClawAdapter({ clientFactory: () => client }).invoke({
    ...request,
    signal: controller.signal,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.deepEqual(requests.slice(-2), ["sessions.abort", "agent.wait"]);
  assert.equal(events.at(-1).type, "run.cancelled");
  assert.equal(events.some(event => event.type === "run.completed"), false);
});

test("OpenClaw Gateway adapter stops without abort RPC when cancelled before agent acceptance", async () => {
  const controller = new AbortController();
  controller.abort("cancel-before-dispatch");
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent() { return () => {}; },
    async request(method) {
      requests.push(method);
      if (method === "agents.list") throw new Error("aborted");
      throw new Error(`unexpected request ${method}`);
    },
    close: async () => {}
  };
  const events = [];
  for await (const event of createOpenClawAdapter({ clientFactory: () => client }).invoke({
    ...request,
    signal: controller.signal,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.deepEqual(requests, ["agents.list"]);
  assert.equal(events.at(-1).type, "run.cancelled");
  assert.equal(events.some(event => event.type === "run.failed"), false);
});

test("OpenClaw Gateway adapter reconnects and reconciles an accepted run after socket loss", async () => {
  let listener = () => {};
  let factoryCalls = 0;
  let waitCalls = 0;
  const hello = openClawGatewayHello();
  const primary = {
    connect: async () => hello,
    onEvent(next) { listener = next; return () => { listener = () => {}; }; },
    async request(method, params, options = {}) {
      if (method === "agents.list") return { agents: [{ id: "octo-openclaw-runner" }] };
      if (method === "sessions.create") return { key: params.key };
      if (method === "sessions.messages.subscribe") return { status: "subscribed" };
      if (method === "agent") {
        options.onAccepted?.({ status: "accepted", runId: params.idempotencyKey });
        throw new Error("OpenClaw Gateway closed (1006)");
      }
      return {};
    },
    close: async () => {}
  };
  const recovery = {
    connect: async () => hello,
    onEvent() { return () => {}; },
    async request(method, params) {
      assert.equal(method, "agent.wait");
      waitCalls += 1;
      if (waitCalls === 1) return { runId: params.runId, status: "timeout" };
      if (waitCalls === 2) return { runId: params.runId, status: "pending" };
      return { runId: params.runId, status: "ok", endedAt: Date.now(), stopReason: "stop" };
    },
    close: async () => {}
  };
  const adapter = createOpenClawAdapter({
    clientFactory: () => factoryCalls++ === 0 ? primary : recovery
  });
  const events = [];
  for await (const event of adapter.invoke({
    ...request,
    agentSource: "provisioned", agentConfig: {
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.equal(factoryCalls, 2);
  assert.equal(waitCalls, 3);
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(events.some(event => event.type === "run.failed"), false);
});

test("OpenClaw Gateway adapter fails reconciliation when non-terminal timeouts reach the invocation deadline", async () => {
  let factoryCalls = 0;
  let waitCalls = 0;
  const hello = openClawGatewayHello();
  const primary = {
    connect: async () => hello,
    onEvent() { return () => {}; },
    async request(method, params, options = {}) {
      if (method === "agents.list") return { agents: [{ id: "octo-openclaw-runner" }] };
      if (method === "sessions.create") return { key: params.key };
      if (method === "sessions.messages.subscribe") return { status: "subscribed" };
      if (method === "agent") {
        options.onAccepted?.({ status: "accepted", runId: params.idempotencyKey });
        throw new Error("OpenClaw Gateway closed (1006)");
      }
      return {};
    },
    close: async () => {}
  };
  const recovery = {
    connect: async () => hello,
    onEvent() { return () => {}; },
    async request(method, params) {
      assert.equal(method, "agent.wait");
      waitCalls += 1;
      return { runId: params.runId, status: "timeout" };
    },
    close: async () => {}
  };
  const events = [];
  for await (const event of createOpenClawAdapter({
    clientFactory: () => factoryCalls++ === 0 ? primary : recovery
  }).invoke({
    ...request,
    agentSource: "provisioned", agentConfig: {
      timeoutSeconds: 0.2,
      providerAgentId: "octo-openclaw-runner",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.equal(factoryCalls, 2);
  assert.ok(waitCalls >= 1);
  assert.equal(events.at(-1).type, "run.failed");
  assert.match(events.at(-1).payload.message, /invocation deadline/);
  assert.equal(events.some(event => event.type === "run.completed"), false);
});

test("only Codex declares append-only continuity recovery", () => {
  assert.equal(createCodexAdapter().metadata.executionFeatures.includes("session.resume_recovery"), true);
  assert.equal(createClaudeCodeAdapter().metadata.executionFeatures.includes("session.resume_recovery"), false);
  assert.equal(createCodeBuddyAdapter().metadata.executionFeatures.includes("session.resume_recovery"), false);
});

test("generic ACP and CodeBuddy full_access audit allow_once and cancel allow_always-only requests", { timeout: 5_000 }, async testContext => {
  for (const [provider, createAdapter] of [
    ["generic ACP", options => createAcpAdapter({ type: "fixture-acp", provider: "fixture-acp", command: "fixture" }, options)],
    ["CodeBuddy", createCodeBuddyAdapter]
  ]) {
    for (const allowOnce of [true, false]) {
      await testContext.test(`${provider} ${allowOnce ? "allow_once" : "allow_always-only"}`, async () => {
        const { adapter, state } = acpPermissionFixture(createAdapter, [
          { optionId: "allow-always", kind: "allow_always" },
          ...(allowOnce ? [{ optionId: "allow-once", kind: "allow_once" }] : [])
        ]);
        const events = [];
        for await (const event of adapter.invoke(request)) events.push(event);
        assert.deepEqual(state.responses, [allowOnce
          ? { outcome: { outcome: "selected", optionId: "allow-once" } }
          : { outcome: { outcome: "cancelled" } }]);
        assert.equal(state.sideEffects, allowOnce ? 1 : 0);
        if (provider === "CodeBuddy") {
          assert.deepEqual(state.spawnOptions.args, ["--acp", "--permission-mode", "bypassPermissions"]);
          assert.equal(adapter.metadata.executionFeatures.includes("interaction.response"), true);
        }
        const interactions = events.filter(event => event.type.startsWith("interaction."));
        assert.deepEqual(interactions.map(event => event.type), ["interaction.requested", "interaction.resolved"]);
        assert.equal(interactions[0].payload.request.schema, "octo.approval-request/v1");
        assert.deepEqual(interactions[0].payload.request.policy, { mode: "full_access", hash: contextHash(request.context) });
        assert.equal(interactions[0].payload.request.grantScope, "request");
        assert.deepEqual(interactions[0].payload.request.allowedOutcomes, allowOnce ? ["accepted", "cancelled"] : ["cancelled"]);
        assert.deepEqual(interactions[1].payload, {
          interactionId: interactions[0].payload.interactionId,
          executionInstanceId: request.invocationId,
          status: "resolved",
          outcome: allowOnce ? "accepted" : "cancelled",
          reasonCode: "full_access_policy"
        });
        assert.equal(events.at(-1).type, "run.completed");
      });
    }
  }
});

test("generic ACP ask waits for actual respondInteraction before continuing the original permission request", { timeout: 5_000 }, async testContext => {
  for (const outcome of ["accepted", "declined", "cancelled"]) {
    await testContext.test(outcome, async () => {
      const { adapter, state } = acpPermissionFixture(
        options => createAcpAdapter({ type: "fixture-acp", provider: "fixture-acp", command: "fixture" }, options),
        [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }]
      );
      assert.equal(adapter.metadata.executionFeatures.includes("interaction.response"), true);
      assert.equal(typeof adapter.respondInteraction, "function");
      const events = [];
      for await (const event of adapter.invoke({ ...request, approvalMode: "ask" })) {
        events.push(event);
        if (event.type !== "interaction.requested") continue;
        assert.equal(state.sideEffects, 0);
        assert.deepEqual(state.responses, []);
        assert.equal(event.payload.executionInstanceId, request.invocationId);
        assert.deepEqual(event.payload.request.policy, { mode: "ask", hash: contextHash(request.context) });
        assert.deepEqual(event.payload.request.allowedOutcomes, ["accepted", "declined", "cancelled"]);
        await assert.rejects(adapter.respondInteraction("other-invocation", {
          interactionId: event.payload.interactionId, outcome
        }), /INTERACTION_NOT_ACTIVE/);
        await adapter.respondInteraction(request.invocationId, { interactionId: event.payload.interactionId, outcome });
        await assert.rejects(adapter.respondInteraction(request.invocationId, {
          interactionId: event.payload.interactionId, outcome
        }), /INTERACTION_NOT_ACTIVE/);
      }
      assert.deepEqual(state.responses, [outcome === "cancelled"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: outcome === "accepted" ? "allow-once" : "reject-once" } }]);
      assert.equal(state.sideEffects, outcome === "accepted" ? 1 : 0);
      const interactions = events.filter(event => event.type.startsWith("interaction."));
      assert.deepEqual(interactions.map(event => event.type), ["interaction.requested", "interaction.resolved"]);
      assert.deepEqual(interactions[1].payload, {
        interactionId: interactions[0].payload.interactionId, executionInstanceId: request.invocationId, status: "resolved", outcome
      });
      assert.equal(events.at(-1).type, "run.completed");
    });
  }
});

test("generic ACP and CodeBuddy keep explicit effort and continue with a not-applied notice", async () => {
  for (const factory of [
    options => createAcpAdapter({ type: "fixture-acp", provider: "fixture-acp", command: "fixture" }, options),
    createCodeBuddyAdapter
  ]) {
    const { adapter } = acpPermissionFixture(factory, [{ optionId: "allow-once", kind: "allow_once" }]);
    const input = { ...request, approvalMode: "full_access", agentSource: "provisioned", agentConfig: { effort: "xhigh" } };
    const events = [];
    for await (const event of adapter.invoke(input)) events.push(event);
    assert.equal(input.agentConfig.effort, "xhigh");
    assert.equal(events[0].payload.params.warningCode, "REASONING_EFFORT_NOT_APPLIED");
    assert.equal(events.at(-1).type, "run.completed");
  }
});

test("CodeBuddy ask and assisted map native modes and wait for the original invocation's human response", async () => {
  for (const [approvalMode, nativeMode] of [["ask", "default"], ["assisted", "auto"]]) {
    const { adapter, state } = acpPermissionFixture(createCodeBuddyAdapter,
      [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }]);
    const events = [];
    for await (const event of adapter.invoke({ ...request, approvalMode })) {
      events.push(event);
      if (event.type === "interaction.requested") {
        assert.equal(state.sideEffects, 0);
        await assert.rejects(adapter.respondInteraction("wrong-invocation", { interactionId: event.payload.interactionId, outcome: "accepted" }), /INTERACTION_NOT_ACTIVE/);
        await adapter.respondInteraction(request.invocationId, { interactionId: event.payload.interactionId, outcome: "accepted" });
      }
    }
    assert.deepEqual(state.spawnOptions.args, ["--acp", "--permission-mode", nativeMode]);
    assert.equal(state.sideEffects, 1);
    assert.equal(events.at(-1).type, "run.completed");
  }
});

test("CodeBuddy preserves a cancelled ACP prompt as an interrupted run", async () => {
  let nextRequestId = 1;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "codebuddy-session" } : {},
    async *prompt() {
      yield { sessionUpdate: "agent_thought_chunk", content: { text: "checking sources" } };
      yield { sessionUpdate: "tool_call", toolCallId: "fetch-1", name: "WebFetch", rawInput: { url: "https://example.com" } };
      yield { type: "prompt_result", stopReason: "cancelled", finishReason: "tool_calls" };
    },
    close: async () => {}
  };
  const adapter = createCodeBuddyAdapter({ acpClientFactory: () => client });
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.equal(events.some(event => event.type === "run.completed"), false);
  assert.deepEqual(events.at(-1), { protocolVersion: 2,
    type: "run.cancelled",
    payload: { reason: "cancelled", finishReason: "tool_calls" }
  });
  assert.ok(events.some(event => event.type === "tool_call.update"
    && event.payload.id === "fetch-1"
    && event.payload.status === "cancelled"));
  assert.ok(events.some(event => event.type === "message.update" && event.payload.status === "stopped"));
});

test("CodeBuddy keeps an end_turn ACP prompt as a completed run", async () => {
  let nextRequestId = 1;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "codebuddy-session" } : {},
    async *prompt() {
      yield { sessionUpdate: "agent_message_chunk", content: { text: "done" } };
      yield { type: "prompt_result", stopReason: "end_turn", finishReason: "stop" };
    },
    close: async () => {}
  };
  const adapter = createCodeBuddyAdapter({ acpClientFactory: () => client });
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(events.some(event => event.type === "run.cancelled"), false);
});

test("generic ACP adapters expose a model step when the provider only sends public answer chunks", async () => {
  let nextRequestId = 1;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "acp-session" } : {},
    async *prompt() {
      yield { sessionUpdate: "agent_message_chunk", content: { text: "done" } };
      yield { type: "prompt_result", stopReason: "end_turn" };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture" },
    { acpClientFactory: () => client }
  );
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.deepEqual(events.filter(event => event.type.startsWith("model_step.")), [
    { protocolVersion: 2, type: "model_step.started", payload: { stepId: "fixture-acp:step:1" } },
    { protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: "fixture-acp:step:1",
        status: "completed",
        finishReason: "end_turn",
      }
    }
  ]);
  assert.ok(events.some(event => event.type === "message.delta"
    && event.payload.text === "done"
    && event.payload.stepId === "fixture-acp:step:1"));
  assert.equal(events.at(-1).type, "run.completed");
});

test("generic ACP adapters select a requested model through standard config options", async () => {
  let nextRequestId = 1;
  const requests = [];
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "session/new") {
        return {
          sessionId: "provider-session",
          configOptions: [{ id: "model", category: "model", currentValue: "default-model", options: [
            { value: "default-model", name: "Default" },
            { value: "requested-model", name: "Requested" }
          ] }]
        };
      }
      return {};
    },
    async *prompt() {
      yield { sessionUpdate: "agent_message_chunk", content: { text: "done" } };
      yield { type: "prompt_result", stopReason: "end_turn" };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture" },
    { acpClientFactory: () => client }
  );
  const events = [];
  for await (const event of adapter.invoke({
    ...request,
    agentSource: "provisioned", agentConfig: { model: "requested-model" }
  })) events.push(event);

  assert.deepEqual(requests.slice(0, 2), [
    { method: "session/new", params: { cwd: request.workdir, mcpServers: [] } },
    { method: "session/set_config_option", params: { sessionId: "provider-session", configId: "model", value: "requested-model" } }
  ]);
  assert.deepEqual(events.find(event => event.type === "session.update"), { protocolVersion: 2,
    type: "session.update",
    payload: {
      providerSession: {
        sessionId: "provider-session",
        resumable: true,
        model: "requested-model"
      }
    }
  });
});

test("generic ACP model selection supports legacy model state and rejects unavailable models", () => {
  const session = {
    models: {
      currentModelId: "custom:default",
      availableModels: [{ modelId: "custom:default" }, { modelId: "custom:tencent/glm-5.3" }]
    }
  };
  assert.deepEqual(acpModelSelectionRequest(session, "session-1", "custom:tencent/glm-5.3"), {
    method: "session/set_model",
    params: { sessionId: "session-1", modelId: "custom:tencent/glm-5.3" }
  });
  assert.equal(acpModelSelectionRequest(session, "session-1", "custom:default"), undefined);
  assert.throws(() => acpModelSelectionRequest(session, "session-1", "missing"), /does not offer model missing/);
  assert.throws(() => acpModelSelectionRequest({}, "session-1", "missing"), /does not advertise/);
});

test("generic ACP adapters start fresh when session/load reports a missing session", async () => {
  let nextRequestId = 1;
  const requests = [];
  let promptInput;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "session/load" ? {} : { sessionId: "fresh-session", model: "provider-model" };
    },
    async *prompt(sessionId, input) {
      promptInput = { sessionId, input };
      yield { sessionUpdate: "agent_message_chunk", content: { text: "recovered" } };
      yield { type: "prompt_result", stopReason: "end_turn" };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture", emptyLoadResultMeansMissing: true },
    { acpClientFactory: () => client }
  );
  const events = [];
  for await (const event of adapter.invoke({
    ...request,
    providerSession: { sessionId: "missing-session" },
    modelInput: "delta input",
    freshFallbackModelInput: "recovery input"
  })) events.push(event);

  assert.deepEqual(requests.map(item => item.method), ["session/load", "session/new"]);
  assert.deepEqual(promptInput, { sessionId: "fresh-session", input: "recovery input\n\nCONTROL" });
  assert.deepEqual(events.find(event => event.type === "session.update"), { protocolVersion: 2,
    type: "session.update",
    payload: {
      providerSession: {
        sessionId: "fresh-session",
        resumable: true,
        resumeOutcome: "fresh_fallback",
        resumeFallback: "session_load_not_found",
        contextInputVariant: "recovery",
        model: "provider-model"
      }
    }
  });
  assert.equal(events.at(-1).type, "run.completed");
});

test("generic ACP adapters recover public text carried by the prompt response", async () => {
  let nextRequestId = 1;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "acp-session" } : {},
    async *prompt() {
      yield { type: "prompt_result", stopReason: "end_turn", output: { text: "response fallback" } };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture" },
    { acpClientFactory: () => client }
  );
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.ok(events.some(event => event.type === "message.delta"
    && event.payload.text === "response fallback"
    && event.payload.stepId === "fixture-acp:step:1"));
  assert.ok(events.some(event => event.type === "model_step.finished"
    && event.payload.status === "completed" && !("publicText" in event.payload)));
  assert.equal(events.at(-1).type, "run.completed");
});

test("generic ACP adapters reject an empty end_turn instead of reporting a false success", async () => {
  let nextRequestId = 1;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "acp-session" } : {},
    async *prompt() {
      yield { type: "prompt_result", stopReason: "end_turn" };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture" },
    { acpClientFactory: () => client }
  );
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.deepEqual(events.at(-2), { protocolVersion: 2, type: "message.update", payload: { role: "assistant", status: "failed" } });
  assert.deepEqual(events.at(-1), { protocolVersion: 2,
    type: "run.failed",
    payload: {
      code: "ACP_NO_FINAL_OUTPUT",
      message: "fixture-acp completed without assistant output",
      adapterType: "fixture-acp"
    }
  });
});

test("generic ACP adapters keep a failed tool local and accept the prompt response as the run terminal", async () => {
  let nextRequestId = 1;
  let spawnOptions;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "acp-session" } : {},
    async *prompt() {
      yield { sessionUpdate: "tool_call", toolCallId: "tool-failed", name: "shell", rawInput: { command: "false" } };
      yield { sessionUpdate: "tool_call_update", toolCallId: "tool-failed", status: "failed", rawOutput: "exit 1" };
      yield { sessionUpdate: "agent_thought_chunk", content: { text: "trying another approach" } };
      yield { sessionUpdate: "agent_message_chunk", content: { text: "recovered" } };
      yield { type: "prompt_result", stopReason: "end_turn" };
    },
    cancel: () => {},
    close: async () => {}
  };
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture", args: ["acp"] },
    { acpClientFactory: options => { spawnOptions = options; return client; } }
  );
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.equal(typeof spawnOptions.permissionHandler, "function");
  assert.deepEqual(events.filter(event => event.type.startsWith("run.")), [
    { protocolVersion: 2, type: "run.completed", payload: {} }
  ]);
  assert.ok(events.some(event => event.type === "tool_call.update"
    && event.payload.id === "tool-failed"
    && event.payload.status === "failed"));
  assert.ok(events.some(event => event.type === "message.delta"
    && event.payload.text === "trying another approach"
    && event.payload.stepId === "fixture-acp:step:2"
    && event.payload.messageId === "fixture-acp:step:2:reasoning"));
  assert.ok(events.some(event => event.type === "message.delta"
    && event.payload.text === "recovered"
    && event.payload.stepId === "fixture-acp:step:2"));
  assert.deepEqual(events.filter(event => event.type.startsWith("model_step.")), [
    { protocolVersion: 2, type: "model_step.started", payload: { stepId: "fixture-acp:step:1" } },
    { protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: "fixture-acp:step:1",
        status: "completed",
        finishReason: "tool-calls"
      }
    },
    { protocolVersion: 2, type: "model_step.started", payload: { stepId: "fixture-acp:step:2" } },
    { protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: "fixture-acp:step:2",
        status: "completed",
        finishReason: "end_turn",
      }
    }
  ]);
});

test("Hermes and Kimi Code expose distinct ACP adapter types", () => {
  assert.deepEqual(
    [hermesAdapter.metadata.type, kimiCodeAdapter.metadata.type],
    ["hermes", "kimi-code"]
  );
  assert.equal(normalizeAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "failed"
  }, "fixture")[0].type, "tool_call.update");
});

test("MiniMax Code exposes an ACP adapter with default session and tool capabilities", () => {
  assert.equal(mcodeAdapter.metadata.type, "mcode");
  assert.deepEqual([...mcodeAdapter.metadata.executionFeatures].sort(), ["approval.ask", "approval.full_access", "input.image", "interaction.response", "session.serialize", "tool.canonical"]);
  assert.equal(typeof mcodeAdapter.respondInteraction, "function");
  // MiniMax Code manages model selection itself, so it must not claim Codex's
  // append-only continuity recovery capability.
  assert.equal(mcodeAdapter.metadata.executionFeatures.includes("session.resume_recovery"), false);
});

test("Qoder CLI exposes an ACP adapter with default session and tool capabilities", () => {
  assert.equal(qoderCliAdapter.metadata.type, "qodercli");
  assert.deepEqual([...qoderCliAdapter.metadata.executionFeatures].sort(), ["approval.ask", "approval.full_access", "input.image", "interaction.response", "session.serialize", "tool.canonical"]);
  assert.equal(typeof qoderCliAdapter.respondInteraction, "function");
  assert.equal(qoderCliAdapter.metadata.executionFeatures.includes("session.resume_recovery"), false);
});

test("Qoder CN CLI exposes a distinct ACP adapter type from Qoder CLI", () => {
  assert.equal(qoderCliCnAdapter.metadata.type, "qoderclicn");
  assert.notEqual(qoderCliCnAdapter.metadata.type, qoderCliAdapter.metadata.type);
  assert.deepEqual([...qoderCliCnAdapter.metadata.executionFeatures].sort(), ["approval.ask", "approval.full_access", "input.image", "interaction.response", "session.serialize", "tool.canonical"]);
  assert.equal(typeof qoderCliCnAdapter.respondInteraction, "function");
  assert.equal(qoderCliCnAdapter.metadata.executionFeatures.includes("session.resume_recovery"), false);
});

test("generic ACP cancellation sends session/cancel and converges to run.cancelled", async () => {
  let nextRequestId = 1;
  let releasePrompt;
  const promptCancelled = new Promise(resolve => { releasePrompt = resolve; });
  const calls = [];
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async method => method === "session/new" ? { sessionId: "cancel-session" } : {},
    async *prompt() {
      yield { sessionUpdate: "agent_thought_chunk", content: { text: "working" } };
      await promptCancelled;
      yield { type: "prompt_result", stopReason: "cancelled" };
    },
    cancel: sessionId => {
      calls.push(["cancel", sessionId]);
      releasePrompt?.();
    },
    close: async () => { calls.push(["close"]); }
  };
  const controller = new AbortController();
  const adapter = createAcpAdapter(
    { type: "fixture-acp", provider: "fixture-acp", command: "fixture" },
    { acpClientFactory: () => client }
  );
  const events = [];
  for await (const event of adapter.invoke({ ...request, signal: controller.signal })) {
    events.push(event);
    if (event.type === "message.delta") controller.abort("user_stop");
  }

  assert.deepEqual(calls, [["cancel", "cancel-session"], ["close"], ["close"]]);
  assert.equal(events.filter(event => event.type.startsWith("run.")).length, 1);
  assert.deepEqual(events.filter(event => event.type === "model_step.finished"), [{ protocolVersion: 2,
    type: "model_step.finished",
    payload: {
      stepId: "fixture-acp:step:1",
      status: "cancelled",
      finishReason: "cancelled"
    }
  }]);
  assert.deepEqual(events.at(-1), { protocolVersion: 2, type: "run.cancelled", payload: { reason: "cancelled" } });
});
