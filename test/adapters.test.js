import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  createJsonCliAdapter,
  observeBestEffort,
  observeProviderOutput
} from "../packages/octo-harness-adapter-sdk/dist/index.js";
import { createCodeBuddyAdapter } from "@mininglamp-oss/octo-harness-adapter-codebuddy";
import { createAcpAdapter, normalizeAcpUpdate } from "@mininglamp-oss/octo-harness-adapter-acp";
import { hermesAdapter } from "@mininglamp-oss/octo-harness-adapter-hermes";
import { kiroAdapter } from "@mininglamp-oss/octo-harness-adapter-kiro";
import { kimiCodeAdapter } from "@mininglamp-oss/octo-harness-adapter-kimi-code";
import {
  buildCodexCommand,
  CodexEventNormalizer,
  createCodexAdapter,
  createCodexInvocationHome,
  normalizeCodexEvent
} from "@mininglamp-oss/octo-harness-adapter-codex";
import {
  buildClaudeCommand,
  ClaudeEventNormalizer,
  createClaudeCodeAdapter,
  normalizeClaudeEvent
} from "@mininglamp-oss/octo-harness-adapter-claude-code";
import { buildOpenCodeCommand, normalizeOpenCodeEvent } from "@mininglamp-oss/octo-harness-adapter-opencode";
import {
  buildOpenClawGatewayInvocation,
  createOpenClawDeviceIdentity,
  createOpenClawAdapter,
  OpenClawGatewayClient,
  OpenClawTranscriptNormalizer,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  tryParseOpenClawTranscriptLine
} from "@mininglamp-oss/octo-harness-adapter-openclaw";

const request = { invocationId: "inv-1", agentSessionId: "session-1", runId: "run-1", prompt: "work", workdir: process.cwd(), context: {}, appendInstructions: "CONTROL", agentConfig: {} };

const openClawGatewayMethods = ["config.get", "sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort"];

function openClawGatewayHello() {
  return { type: "hello-ok", protocol: 4, features: { methods: openClawGatewayMethods, events: ["agent"] } };
}

function openClawIsolationConfig(agentId = "octo-openclaw-runner") {
  return {
    config: {
      agents: {
        defaults: { skipBootstrap: true },
        entries: {
          [agentId]: {
            workspace: "/managed/openclaw-runner",
            contextInjection: "never",
            skills: [],
            tools: { deny: ["group:memory"] },
            memory: { search: { rememberAcrossConversations: false } }
          }
        }
      }
    }
  };
}

test("best-effort observations handle rejection and provider output excludes private reasoning", async () => {
  observeBestEffort({
    observe: async () => { throw new Error("logger closed"); }
  }, {
    event: "provider.output.first",
    rpcMethod: "process.stdout"
  });

  const observations = [];
  observeProviderOutput({
    observe: async observation => {
      observations.push(observation);
      return { captureId: "output-test", state: "accepted", complete: true };
    }
  }, [
    {
      type: "message.delta",
      payload: {
        text: "PRIVATE_REASONING_CANARY",
        channel: "analysis",
        exposure: "private_reasoning",
        provenance: { provider: "fixture", nativeEvent: "reasoning.delta" }
      }
    },
    {
      type: "message.delta",
      payload: {
        text: "safe summary",
        channel: "analysis",
        exposure: "public_summary",
        provenance: { provider: "fixture", nativeEvent: "summary.delta" }
      }
    },
    { type: "message.delta", payload: { text: "final answer", channel: "final" } },
    {
      type: "tool_call.update",
      payload: {
        id: "tool-1",
        status: "completed",
        output: {
          safe: "done",
          password: "CREDENTIAL_CANARY",
          OPENAI_API_KEY: "sk-abcdefghijklmnopCREDENTIAL_CANARY"
        }
      }
    },
    { type: "usage.update", payload: { inputTokens: 1, outputTokens: 2 } },
    { type: "run.error", payload: { message: "provider error Bearer TOKEN_CANARY" } },
    { type: "session.update", payload: { providerSession: { sessionId: "not-output" } } }
  ], {
    rpcMethod: "fixture.stdout",
    native: {
      type: "mixed-frame",
      subtype: "content",
      provider: "fixture",
      model: "fixture-model"
    }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(observations.length, 1);
  assert.equal(observations[0].event, "provider.output");
  assert.equal(observations[0].data.native.type, "mixed-frame");
  assert.equal(observations[0].data.native.subtype, "content");
  assert.equal(observations[0].data.native.provider, "fixture");
  assert.equal(observations[0].data.native.model, "fixture-model");
  assert.ok(observations[0].data.native.public.some(projection =>
    projection.kind === "message" && projection.content.text === "final answer"
  ));
  assert.ok(observations[0].data.native.public.some(projection =>
    projection.kind === "tool" && projection.content.status === "completed"
  ));
  assert.deepEqual(observations[0].data.canonical.map(event => event.type), [
    "message.delta",
    "message.delta",
    "tool_call.update",
    "usage.update",
    "run.error"
  ]);
  assert.doesNotMatch(
    JSON.stringify(observations),
    /PRIVATE_REASONING_CANARY|CREDENTIAL_CANARY|TOKEN_CANARY|not-output/
  );
});

test("Codex native events map to session/message/usage/terminal", () => {
  assert.equal(normalizeCodexEvent({ method: "thread/started", params: { thread: { id: "thread-1" } } })[0].type, "session.update");
  assert.deepEqual(
    normalizeCodexEvent({ method: "thread/compacted", params: { threadId: "thread-1" } })[0].payload,
    { providerSession: { sessionId: "thread-1", resumable: true, resumeOutcome: "compacted" } }
  );
  assert.equal(normalizeCodexEvent({ method: "item/agentMessage/delta", params: { itemId: "message-1", delta: "ok" } })[0].type, "message.delta");
  assert.equal(normalizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { last: { inputTokens: 1 }, total: { inputTokens: 2 } } }
  })[0].type, "usage.update");
  assert.deepEqual(
    normalizeCodexEvent({ method: "turn/completed", params: { turn: { status: "completed" } } }).map(x => x.type),
    ["run.finished"]
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
  assert.deepEqual(diagnostic.map(event => event.type), ["model_step.finished"]);
  assert.equal(diagnostic.some(event => event.type === "run.error"), false);

  const recovery = normalizer.normalize({
    method: "item/started",
    params: { turnId: "turn-recovery", item: { type: "reasoning", id: "reasoning-after-error" } }
  });
  assert.equal(recovery[0].type, "model_step.started");
  assert.equal(recovery[0].payload.stepId, "codex:turn-recovery:round:2");
  assert.deepEqual(
    normalizer.normalize({ method: "turn/completed", params: { turn: { id: "turn-recovery", status: "completed" } } }).at(-1),
    { type: "run.finished", payload: {} }
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
      [{
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
    [{
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
    {
      type: "tool_call.update",
      payload: {
        id: "tool-1",
        status: "error",
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
    { type: "tool_call.update", payload: { id: "tool-2", status: "completed", output: "done" } }
  );
  assert.equal(normalizeClaudeEvent({ type: "result", session_id: "claude-1", result: "ok", usage: {} }).at(-1).type, "run.finished");
});

test("Claude defaults to unattended bypass without restricting its tool catalog", async () => {
  const claude = await buildClaudeCommand(request);
  assert.equal(claude.args.includes("--include-partial-messages"), true);
  assert.equal(claude.args.includes("--settings"), false);
  assert.equal(claude.args[claude.args.indexOf("--effort") + 1], "medium");
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(claude.args.includes("--dangerously-skip-permissions"), true);
  assert.equal(claude.args.includes("--disallowedTools"), false);
  await claude.cleanup();
});

test("Claude enables thinking explicitly and defaults optional effort to medium", async () => {
  const thinking = await buildClaudeCommand({
    ...request,
    agentConfig: { thinking: true }
  });
  assert.deepEqual(
    JSON.parse(thinking.args[thinking.args.indexOf("--settings") + 1]),
    { alwaysThinkingEnabled: true }
  );
  assert.equal(thinking.args[thinking.args.indexOf("--effort") + 1], "medium");
  assert.equal(thinking.providerInput.content.thinking, true);
  assert.equal(thinking.providerInput.content.effort, "medium");
  await thinking.cleanup();

  const tuned = await buildClaudeCommand({
    ...request,
    agentConfig: { thinking: true, effort: "high" }
  });
  assert.equal(tuned.args[tuned.args.indexOf("--effort") + 1], "high");
  assert.equal(tuned.providerInput.content.effort, "high");
  await tuned.cleanup();

  const disabled = await buildClaudeCommand({
    ...request,
    agentConfig: { thinking: false }
  });
  assert.deepEqual(
    JSON.parse(disabled.args[disabled.args.indexOf("--settings") + 1]),
    { alwaysThinkingEnabled: false }
  );
  await disabled.cleanup();
});

test("Claude preserves an empty thinking block as a public reasoning lifecycle", () => {
  const normalizer = new ClaudeEventNormalizer();
  const native = event => ({ type: "stream_event", parent_tool_use_id: null, event });
  assert.deepEqual(normalizer.normalize(native({
    type: "message_start", message: { id: "message-empty-thinking" }
  })), [{
    type: "model_step.started",
    payload: { stepId: "message-empty-thinking" }
  }]);
  assert.deepEqual(normalizer.normalize(native({
    type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" }
  })), [{
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
  assert.deepEqual(normalizer.normalize(native({ type: "content_block_stop", index: 0 })), [{
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
  assert.deepEqual(normalizer.normalize(native({ type: "message_stop" })), [{
    type: "model_step.finished",
    payload: { stepId: "message-empty-thinking", status: "completed", finishReason: "end_turn" }
  }]);
});

test("Claude carries bounded public round text without classifying it as reasoning", () => {
  const normalizer = new ClaudeEventNormalizer();
  const native = event => ({ type: "stream_event", parent_tool_use_id: null, event });
  normalizer.normalize(native({ type: "message_start", message: { id: "message-public-text" } }));
  assert.deepEqual(normalizer.normalize(native({
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll inspect " }
  })), [{
    type: "message.delta",
    payload: { text: "I'll inspect ", channel: "final", stepId: "message-public-text" }
  }]);
  normalizer.normalize(native({
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the repository." }
  }));
  normalizer.normalize(native({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
  assert.deepEqual(normalizer.normalize(native({ type: "message_stop" })), [{
    type: "model_step.finished",
    payload: {
      stepId: "message-public-text", status: "completed", finishReason: "tool_use",
      publicText: "I'll inspect the repository."
    }
  }]);
});

test("Claude preserves an explicit restricted permission mode", async () => {
  const claude = await buildClaudeCommand({ ...request, agentConfig: { permissionMode: "dontAsk" } });
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(claude.args.includes("--dangerously-skip-permissions"), false);
  await claude.cleanup();

  const forced = await buildClaudeCommand({
    ...request,
    agentConfig: { permissionMode: "dontAsk", dangerouslyBypassPermissions: true }
  });
  assert.equal(forced.args[forced.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(forced.args.includes("--dangerously-skip-permissions"), true);
  await forced.cleanup();
});

test("OpenCode native events map session/text/reasoning/tool/usage", () => {
  assert.equal(normalizeOpenCodeEvent({ type: "step_start", sessionID: "oc-1", part: {} })[0].type, "session.update");
  assert.equal(normalizeOpenCodeEvent({ type: "text", part: { text: "ok" } })[0].type, "message.delta");
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "reasoning",
    part: { type: "reasoning", text: "checking the repository" }
  }), [{
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
    {
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
    { type: "tool_call.create", payload: { id: "call-2", name: "bash", args: { command: "false" } } },
    {
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
    { type: "session.update", payload: { providerSession: { sessionId: "oc-1", resumable: true } } },
    { type: "model_step.started", payload: { stepId: "message-1", startedAtMs: 1_788_793_000_000 } }
  ]);
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "reasoning", part: { type: "reasoning", messageID: "message-1", text: "checking weather" }
  })[0], {
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
  })[0], {
    type: "tool_call.create",
    payload: { id: "call-1", name: "websearch", args: { query: "宁波天气" }, stepId: "message-1" }
  });
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "step_finish", timestamp: 1_788_793_002_000,
    part: { type: "step-finish", messageID: "message-1", reason: "tool-calls", tokens: { input: 10 } }
  }), [
    {
      type: "model_step.finished",
      payload: { stepId: "message-1", status: "completed", finishReason: "tool-calls", endedAtMs: 1_788_793_002_000 }
    },
    { type: "usage.update", payload: { input: 10, cost: undefined, stepId: "message-1" } }
  ]);
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "step_finish", timestamp: 1_788_793_003_000,
    part: { type: "step-finish", messageID: "message-2", reason: "stop", tokens: { output: 4 } }
  }), [
    {
      type: "model_step.finished",
      payload: { stepId: "message-2", status: "completed", finishReason: "stop", endedAtMs: 1_788_793_003_000 }
    },
    { type: "usage.update", payload: { output: 4, cost: undefined, stepId: "message-2" } },
    { type: "run.finished", payload: {} }
  ]);
});

test("JSON CLI adapters reap a provider that stays alive after a semantic terminal", async () => {
  const adapter = createJsonCliAdapter({
    metadata: { type: "semantic-terminal", capabilities: [] },
    buildCommand: () => ({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({done:true}));setInterval(()=>{},1000)"]
    }),
    normalize: native => native.done ? [{ type: "run.finished", payload: {} }] : []
  });
  const events = [];
  const startedAt = Date.now();
  for await (const event of adapter.invoke(request)) events.push(event);

  assert.equal(events.at(-1).type, "run.finished");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("OpenCode always requests reasoning JSON and tool approval, maps thinking to variant, and resumes a provider session", async () => {
  const withoutVariant = await buildOpenCodeCommand(request);
  assert.deepEqual(withoutVariant.args.slice(0, 5), ["run", "--format", "json", "--thinking", "--auto"]);
  assert.equal(withoutVariant.args.filter(arg => arg === "--auto").length, 1);
  assert.equal(withoutVariant.args.includes("--variant"), false);
  await withoutVariant.cleanup();

  const opencode = await buildOpenCodeCommand({
    ...request,
    providerSession: { sessionId: "ses-existing" },
    agentConfig: { model: "provider/model", thinking: "high", autoApprove: true }
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
    {
      type: "model_step.started",
      payload: { stepId: "openclaw:assistant-1", startedAtMs: 1_788_854_400_000 }
    },
    {
      type: "message.delta",
      payload: {
        text: "checking the workspace", stepId: "openclaw:assistant-1",
        messageId: "openclaw:assistant-1:reasoning", channel: "analysis",
        exposure: "public_reasoning",
        provenance: { provider: "openclaw", nativeEvent: "session.transcript.thinking" }
      }
    },
    {
      type: "tool_call.create",
      payload: { id: "call-1", name: "exec", args: { command: "pwd" }, stepId: "openclaw:assistant-1" }
    },
    {
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
  assert.deepEqual(normalizer.normalize(result), [{
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

  const codex = await createCodexInvocationHome("CONTROL", {});
  assert.match(await readFile(`${codex.home}/config.toml`, "utf8"), /CONTROL/); await codex.cleanup();

  const openclaw = buildOpenClawGatewayInvocation({
    ...request,
    agentConfig: {
      providerAgentId: "octo-openclaw-runner", model: "provider/model", thinking: "medium", timeoutSeconds: 30,
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
  assert.equal(openclaw.agentParams.promptMode, "minimal");
  assert.equal(openclaw.createParams.cwd, request.workdir);
  assert.equal(openclaw.createParams.model, "provider/model");
  assert.equal(openclaw.createParams.thinkingLevel, "medium");
  assert.equal(JSON.stringify(openclaw.providerInput).includes("SECRET_TOKEN"), false);
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
  assert.equal(claude.input, "MODEL_INPUT_OK");
  assert.equal(claude.providerInput.content.stdin, claude.input);
  await claude.cleanup();

  const opencode = await buildOpenCodeCommand(modelRequest);
  assert.equal(opencode.args.at(-1), "MODEL_INPUT_OK");
  assert.equal(opencode.providerInput.content.user_input, opencode.args.at(-1));
  await opencode.cleanup();

  const openclaw = buildOpenClawGatewayInvocation({
    ...modelRequest,
    agentConfig: {
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
  assert.equal(openclaw.providerInput.content.operations[3].params.message, "MODEL_INPUT_OK");
});

test("OpenClaw Gateway client authenticates, handles accepted/final responses, aborts, and rejects malformed JSON", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  const requests = [];
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture-nonce", ts: Date.now() } }));
    socket.on("message", data => {
      const frame = JSON.parse(Buffer.from(data).toString("utf8"));
      requests.push(frame);
      if (frame.method === "connect") {
        assert.equal(frame.params.auth.token, "fixture-token");
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
  const observations = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => { listener = () => {}; }; },
    async request(method, params, options = {}) {
      requests.push({ method, params });
      if (method === "config.get") return openClawIsolationConfig();
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
    agentConfig: {
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  }, { observe: async observation => { observations.push(observation); } })) events.push(event);

  assert.equal(events.some(event => JSON.stringify(event).includes("LEAK")), false);
  assert.equal(events.filter(event => event.type === "message.delta" && event.payload.channel === "final").map(event => event.payload.text).join(""), "hello");
  assert.deepEqual(events.filter(event => event.type.startsWith("tool_call.")).map(event => event.type), ["tool_call.create", "tool_call.update"]);
  assert.equal(events.at(-1).type, "run.finished");
  assert.deepEqual(requests.slice(0, 4).map(entry => entry.method), ["config.get", "sessions.create", "sessions.messages.subscribe", "agent"]);
  assert.equal(requests[1].params.cwd, request.workdir);
  assert.equal(requests[3].params.cwd, undefined);
  assert.ok(requests.some(entry => entry.method === "agent.wait"));
  assert.deepEqual(observations.find(observation => observation.data?.diagnostic)?.data.diagnostic, {
    type: "sequence_gap", expectedSeq: 6, receivedSeq: 7
  });
});

test("OpenClaw Gateway adapter reconciles a final RPC result when live events are absent", async () => {
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent() { return () => {}; },
    async request(method, params, options = {}) {
      requests.push({ method, params });
      if (method === "config.get") return openClawIsolationConfig();
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
    agentConfig: {
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.deepEqual(requests.slice(0, 4).map(entry => entry.method), ["config.get", "sessions.create", "sessions.messages.subscribe", "agent"]);
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "fallback result");
  assert.deepEqual(events.find(event => event.type === "usage.update")?.payload, {
    inputTokens: 3, outputTokens: 2, provider: "anthropic", model: "tencent/glm-5.3"
  });
  assert.equal(events.at(-1).type, "run.finished");
});

test("OpenClaw Gateway adapter fails before session creation when isolation config drifts", async () => {
  const requests = [];
  const drifted = openClawIsolationConfig();
  drifted.config.agents.defaults.skipBootstrap = false;
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent() { return () => {}; },
    async request(method) {
      requests.push(method);
      if (method === "config.get") return drifted;
      throw new Error(`unexpected request ${method}`);
    },
    close: async () => {}
  };
  const events = [];
  for await (const event of createOpenClawAdapter({ clientFactory: () => client }).invoke({
    ...request,
    agentConfig: {
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.deepEqual(requests, ["config.get"]);
  assert.match(events.at(-1).payload.message, /skipBootstrap must be true/);
});

test("OpenClaw Gateway adapter refuses success when agent.wait confirms a different terminal", async () => {
  let listener = () => {};
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => {}; },
    async request(method, params, options = {}) {
      if (method === "config.get") return openClawIsolationConfig();
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
    agentConfig: {
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.equal(events.some(event => event.type === "run.finished"), false);
  assert.match(events.at(-1).payload.message, /confirmed failed, not completed/);
});

test("OpenClaw Gateway adapter confirms abort before emitting run.stopped", async () => {
  let listener = () => {};
  const controller = new AbortController();
  const requests = [];
  const client = {
    connect: async () => openClawGatewayHello(),
    onEvent(next) { listener = next; return () => {}; },
    request(method, params, options = {}) {
      requests.push(method);
      if (method === "config.get") return Promise.resolve(openClawIsolationConfig());
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
    agentConfig: {
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
  assert.equal(events.at(-1).type, "run.stopped");
  assert.equal(events.some(event => event.type === "run.finished"), false);
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
      if (method === "config.get") throw new Error("aborted");
      throw new Error(`unexpected request ${method}`);
    },
    close: async () => {}
  };
  const events = [];
  for await (const event of createOpenClawAdapter({ clientFactory: () => client }).invoke({
    ...request,
    signal: controller.signal,
    agentConfig: {
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789/",
        OPENCLAW_GATEWAY_TOKEN: "token",
        OPENCLAW_GATEWAY_DEVICE_ID: "device",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "public",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "private"
      }
    }
  })) events.push(event);

  assert.deepEqual(requests, ["config.get"]);
  assert.equal(events.at(-1).type, "run.stopped");
  assert.equal(events.some(event => event.type === "run.error"), false);
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
      if (method === "config.get") return openClawIsolationConfig();
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
    agentConfig: {
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
  assert.equal(events.at(-1).type, "run.finished");
  assert.equal(events.some(event => event.type === "run.error"), false);
});

test("OpenClaw Gateway adapter fails reconciliation when non-terminal timeouts reach the invocation deadline", async () => {
  let factoryCalls = 0;
  let waitCalls = 0;
  const hello = openClawGatewayHello();
  const primary = {
    connect: async () => hello,
    onEvent() { return () => {}; },
    async request(method, params, options = {}) {
      if (method === "config.get") return openClawIsolationConfig();
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
    agentConfig: {
      timeoutSeconds: 0.2,
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
  assert.equal(events.at(-1).type, "run.error");
  assert.match(events.at(-1).payload.message, /invocation deadline/);
  assert.equal(events.some(event => event.type === "run.finished"), false);
});

test("only Codex declares append-only continuity recovery", () => {
  assert.equal(createCodexAdapter().metadata.capabilities.includes("session.resume_recovery"), true);
  assert.equal(createClaudeCodeAdapter().metadata.capabilities.includes("session.resume_recovery"), false);
  assert.equal(createCodeBuddyAdapter().metadata.capabilities.includes("session.resume_recovery"), false);
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

  assert.equal(events.some(event => event.type === "run.finished"), false);
  assert.deepEqual(events.at(-1), {
    type: "run.stopped",
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

  assert.equal(events.at(-1).type, "run.finished");
  assert.equal(events.some(event => event.type === "run.stopped"), false);
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
    { type: "model_step.started", payload: { stepId: "fixture-acp:step:1" } },
    {
      type: "model_step.finished",
      payload: {
        stepId: "fixture-acp:step:1",
        status: "completed",
        finishReason: "end_turn",
        publicText: "done"
      }
    }
  ]);
  assert.ok(events.some(event => event.type === "message.delta"
    && event.payload.text === "done"
    && event.payload.stepId === "fixture-acp:step:1"));
  assert.equal(events.at(-1).type, "run.finished");
});

test("generic ACP adapters leave model and authentication ownership to the provider", async () => {
  let nextRequestId = 1;
  let newSessionParams;
  const client = {
    initialize: async () => {},
    reserveRequestId: () => nextRequestId++,
    request: async (method, params) => {
      if (method === "session/new") {
        newSessionParams = params;
        return { sessionId: "provider-session", model: "provider-owned-model" };
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
    agentConfig: { model: "harness-must-not-select-this", autoApprove: true }
  })) events.push(event);

  assert.deepEqual(newSessionParams, { cwd: request.workdir, mcpServers: [] });
  assert.deepEqual(events.find(event => event.type === "session.update"), {
    type: "session.update",
    payload: {
      providerSession: {
        sessionId: "provider-session",
        resumable: true,
        model: "provider-owned-model"
      }
    }
  });
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
  assert.deepEqual(events.find(event => event.type === "session.update"), {
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
  assert.equal(events.at(-1).type, "run.finished");
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
    && event.payload.publicText === "response fallback"));
  assert.equal(events.at(-1).type, "run.finished");
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

  assert.deepEqual(events.at(-2), { type: "message.update", payload: { role: "assistant", status: "failed" } });
  assert.deepEqual(events.at(-1), {
    type: "run.error",
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
  for await (const event of adapter.invoke({
    ...request,
    agentConfig: { model: "fixture-model", autoApprove: true }
  })) events.push(event);

  assert.equal(spawnOptions.permissionHandler({
    options: [
      { optionId: "reject", kind: "reject_once" },
      { optionId: "allow", kind: "allow_once" }
    ]
  }).outcome.optionId, "allow");
  assert.deepEqual(events.filter(event => event.type.startsWith("run.")), [
    { type: "run.finished", payload: {} }
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
    { type: "model_step.started", payload: { stepId: "fixture-acp:step:1" } },
    {
      type: "model_step.finished",
      payload: {
        stepId: "fixture-acp:step:1",
        status: "completed",
        finishReason: "tool-calls"
      }
    },
    { type: "model_step.started", payload: { stepId: "fixture-acp:step:2" } },
    {
      type: "model_step.finished",
      payload: {
        stepId: "fixture-acp:step:2",
        status: "completed",
        finishReason: "end_turn",
        publicText: "recovered"
      }
    }
  ]);
});

test("Hermes, Kiro, and Kimi Code expose distinct ACP adapter types", () => {
  assert.deepEqual(
    [hermesAdapter.metadata.type, kiroAdapter.metadata.type, kimiCodeAdapter.metadata.type],
    ["hermes", "kiro", "kimi-code"]
  );
  assert.equal(normalizeAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "failed"
  }, "fixture")[0].type, "tool_call.update");
});

test("generic ACP cancellation sends session/cancel and converges to run.stopped", async () => {
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

  assert.deepEqual(calls, [["cancel", "cancel-session"], ["close"]]);
  assert.equal(events.filter(event => event.type.startsWith("run.")).length, 1);
  assert.deepEqual(events.filter(event => event.type === "model_step.finished"), [{
    type: "model_step.finished",
    payload: {
      stepId: "fixture-acp:step:1",
      status: "stopped",
      finishReason: "cancelled"
    }
  }]);
  assert.deepEqual(events.at(-1), { type: "run.stopped", payload: { reason: "cancelled" } });
});
