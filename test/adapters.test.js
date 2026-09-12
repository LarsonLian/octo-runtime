import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
  buildOpenClawCommand,
  OpenClawTranscriptNormalizer,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  tryParseOpenClawTranscriptLine
} from "@mininglamp-oss/octo-harness-adapter-openclaw";

const request = { invocationId: "inv-1", agentSessionId: "session-1", runId: "run-1", prompt: "work", workdir: process.cwd(), context: {}, appendInstructions: "CONTROL", agentConfig: {} };

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

  const openclaw = await buildOpenClawCommand({
    ...request,
    agentConfig: { providerAgentId: "main", model: "provider/model", thinking: "medium", timeoutSeconds: 30 }
  });
  const openclawPrompt = await readFile(openclaw.messageFile, "utf8");
  assert.match(openclawPrompt, /^\[Harness Instructions\]\nCONTROL/);
  assert.match(openclawPrompt, /\[User Request\]\nwork$/);
  assert.equal(openclaw.args.includes(openclawPrompt), false);
  assert.deepEqual(openclaw.args.slice(0, 6), ["agent", "--local", "--json", "--session-id", openclaw.providerSessionId, "--agent"]);
  if (process.platform !== "win32") assert.equal((await stat(openclaw.messageFile)).mode & 0o777, 0o600);
  const openclawMessageFile = openclaw.messageFile;
  await openclaw.cleanup();
  await assert.rejects(readFile(openclawMessageFile, "utf8"));

  const resumedOpenClaw = await buildOpenClawCommand({
    ...request,
    providerSession: { sessionId: "openclaw-session-existing" }
  });
  assert.equal(resumedOpenClaw.providerSessionId, "openclaw-session-existing");
  assert.equal(resumedOpenClaw.args[resumedOpenClaw.args.indexOf("--session-id") + 1], "openclaw-session-existing");
  await resumedOpenClaw.cleanup();
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

  const openclaw = await buildOpenClawCommand(modelRequest);
  const openclawInput = await readFile(openclaw.messageFile, "utf8");
  assert.match(openclawInput, /\[User Request\]\nMODEL_INPUT_OK$/);
  assert.equal(openclaw.providerInput.content.message, openclawInput);
  await openclaw.cleanup();
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
