import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { spawnAcpClient } from "@mininglamp-oss/octo-harness-acp-client";
import {
  observeBestEffort,
  observeProviderOutput
} from "../packages/octo-harness-adapter-sdk/dist/index.js";
import { createCodeBuddyAdapter, normalizeCodeBuddyUpdate } from "@mininglamp-oss/octo-harness-adapter-codebuddy";
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
  createOpenClawAdapter,
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
  assert.equal(typeof command.env.CODEX_HOME, "string");
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

test("Claude maps thinking/text/tool argument partials without replaying assistant snapshots", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-claude-stream.mjs", import.meta.url));
  const adapter = createClaudeCodeAdapter({ command: process.execPath, commandArgsPrefix: [fixture] });
  const observations = [];
  const host = new AdapterHost({
    observe: async (_identity, observation) => {
      observations.push(observation);
      return { captureId: "claude-output-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  for await (const event of host.invoke("claude-code", request)) events.push(event);

  assert.deepEqual(events.map(event => event.type), [
    "message.create", "session.update",
    "model_step.started", "message.create", "message.delta", "message.update",
    "tool_call.create", "tool_call.delta", "tool_call.delta", "model_step.finished", "tool_call.update",
    "model_step.started", "message.create", "message.delta", "message.update",
    "tool_call.create", "tool_call.delta", "model_step.finished", "tool_call.update",
    "model_step.started", "message.delta", "model_step.finished",
    "usage.update", "message.update", "run.finished"
  ]);
  assert.deepEqual(
    events.filter(event => event.type === "model_step.started").map(event => event.payload.stepId),
    ["message-1", "message-2", "message-3"]
  );
  assert.deepEqual(
    events.filter(event => event.type === "model_step.finished").map(event => ({
      stepId: event.payload.stepId,
      finishReason: event.payload.finishReason,
      publicText: event.payload.publicText
    })),
    [
      { stepId: "message-1", finishReason: "tool_use", publicText: undefined },
      { stepId: "message-2", finishReason: "tool_use", publicText: undefined },
      { stepId: "message-3", finishReason: "end_turn", publicText: "两步检查完成。" }
    ]
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "analysis")
      .map(event => event.payload.text).join(""),
    "检查 /tmp。检查 /home/lvsijia。"
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "analysis")
      .every(event => event.payload.exposure === "public_reasoning"
        && event.payload.provenance?.provider === "claude-code"
        && ["message-1", "message-2"].includes(event.payload.stepId)),
    true
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "final")
      .map(event => event.payload.text).join(""),
    "两步检查完成。"
  );
  assert.deepEqual(
    events.filter(event => event.type === "tool_call.create").map(event => ({
      id: event.payload.id,
      stepId: event.payload.stepId
    })),
    [{ id: "tool-1", stepId: "message-1" }, { id: "tool-2", stepId: "message-2" }]
  );
  assert.equal(
    events.find(event => event.type === "message.delta" && event.payload.channel === "final").payload.stepId,
    "message-3"
  );
  assert.equal(
    events.filter(event => event.type === "tool_call.delta" && event.payload.id === "tool-1")
      .map(event => event.payload.argsDelta).join(""),
    '{"command":"find /tmp"}'
  );
  assert.equal(events.filter(event => event.type === "session.update").length, 1);
  assert.equal(events.find(event => event.type === "message.update" && event.payload.channel === "final").payload.text, undefined);
  const output = observations.filter(observation => observation.event === "provider.output");
  assert.ok(output.some(observation => observation.data.canonical.some(event => event.type === "tool_call.update")));
  assert.ok(output.some(observation => observation.data.canonical.some(event =>
    event.type === "message.delta" && event.payload.channel === "final"
  )));
  assert.match(JSON.stringify(output), /检查 \/tmp/);
  assert.equal(observations.some(observation => observation.event === "provider.dispatch.acknowledged"), false);
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

  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const codex = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const observations = [];
  const host = new AdapterHost({
    observe: async (identity, observation) => {
      observations.push({ identity, observation });
      return { captureId: "capture-adapter-test", state: "accepted", complete: true };
    }
  });
  host.register(codex);
  const events = [];
  for await (const event of host.invoke("codex", modelRequest)) events.push(event);
  assert.equal(events.at(-1).type, "run.finished");
  const codexInput = observations.find(item =>
    item.observation.event === "provider.input" && item.observation.rpcMethod === "turn/start"
  );
  assert.equal(codexInput.identity.runId, "run-1");
  assert.equal(codexInput.identity.adapterType, "codex");
  assert.equal(codexInput.observation.carrier.content.params.input[0].text, "MODEL_INPUT_OK");
  assert.equal(codexInput.observation.providerRequestId, "3");
  const codexTurnObservations = observations.filter(item =>
    item.observation.providerRequestId === codexInput.observation.providerRequestId
  );
  assert.ok(codexTurnObservations.some(item => item.observation.event === "provider.dispatch.written"));
  assert.ok(codexTurnObservations.some(item => item.observation.event === "provider.dispatch.acknowledged"));
  assert.ok(codexTurnObservations.some(item => item.observation.event === "provider.output.first"));
  assert.ok(codexTurnObservations.some(item => item.observation.event === "provider.output"));
  assert.equal(observations.filter(item =>
    item.observation.event.startsWith("provider.dispatch.")
      || item.observation.event === "provider.input"
  ).every(item => typeof item.observation.providerRequestId === "string"), true);
  const codexPublicOutput = codexTurnObservations
    .filter(item => item.observation.event === "provider.output")
    .flatMap(item => item.observation.data.native.public);
  assert.ok(codexPublicOutput.some(projection =>
    projection.kind === "message" && projection.content.text === "Inspect /tmp."
  ));
});

test("CodeBuddy ACP subprocess completes the canonical contract", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));
  let spawnOptions;
  const adapter = createCodeBuddyAdapter({ acpClientFactory: opts => {
    spawnOptions = opts;
    return spawnAcpClient({ ...opts, command: process.execPath, args: [fixture] });
  } });
  const observations = [];
  const host = new AdapterHost({
    observe: async (identity, observation) => {
      observations.push({ identity, observation });
      return { captureId: "capture-codebuddy-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  const freshRequest = {
    ...request,
    agentConfig: { ...request.agentConfig, model: "codebuddy-model" }
  };
  for await (const event of host.invoke("codebuddy", freshRequest)) events.push(event);
  assert.deepEqual(events.map(x => x.type), [
    "session.update", "message.create", "message.create", "message.delta", "message.delta",
    "tool_call.create", "tool_call.update", "usage.update", "message.update", "message.update", "run.finished"
  ]);
  assert.deepEqual(spawnOptions.args, ["--acp", "--permission-mode", "acceptEdits"]);
  const sessionInput = observations.find(item =>
    item.observation.event === "provider.input" && item.observation.rpcMethod === "session/new"
  );
  assert.equal(sessionInput.identity.adapterType, "codebuddy");
  assert.equal(sessionInput.observation.providerRequestId, "2");
  assert.deepEqual(sessionInput.observation.carrier.content, {
    method: "session/new",
    params: { cwd: request.workdir, mcpServers: [], model: "codebuddy-model" }
  });
  const promptInput = observations.find(item =>
    item.observation.event === "provider.input" && item.observation.rpcMethod === "session/prompt"
  );
  assert.equal(promptInput.observation.providerRequestId, "3");
  assert.equal(promptInput.observation.carrier.content.params.prompt[0].text, "work\n\nCONTROL");
  for (const [requestId, method] of [["2", "session/new"], ["3", "session/prompt"]]) {
    const lifecycle = observations.filter(item => item.observation.providerRequestId === requestId);
    assert.ok(lifecycle.some(item => item.observation.event === "provider.input" && item.observation.rpcMethod === method));
    assert.ok(lifecycle.some(item => item.observation.event === "provider.dispatch.written"));
    assert.ok(lifecycle.some(item => item.observation.event === "provider.dispatch.acknowledged"));
  }
  const promptLifecycle = observations.filter(item => item.observation.providerRequestId === "3");
  assert.ok(promptLifecycle.some(item => item.observation.event === "provider.output.first"));
  assert.ok(promptLifecycle.some(item => item.observation.event === "provider.output"));
  assert.ok(promptLifecycle
    .filter(item => item.observation.event === "provider.output")
    .flatMap(item => item.observation.data.native.public)
    .some(projection => projection.kind === "message" && projection.content.text === "ACP reply"));
  assert.ok(promptLifecycle
    .filter(item => item.observation.event === "provider.output")
    .flatMap(item => item.observation.data.native.public)
    .some(projection => projection.kind === "message"
      && projection.content.text === "Checking the workspace"
      && projection.content.exposure === "public_reasoning"));
  assert.equal(normalizeCodeBuddyUpdate({ type: "usage", usage: { inputTokens: 1 } })[0].type, "usage.update");
  assert.deepEqual(
    normalizeCodeBuddyUpdate({ type: "agent_thought_chunk", text: "checking" })[0].payload,
    {
      text: "checking",
      channel: "analysis",
      exposure: "public_reasoning",
      provenance: { provider: "codebuddy", nativeEvent: "agent_thought_chunk" }
    }
  );
});

test("CodeBuddy captures exact ACP session/load params before dispatch", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));
  const adapter = createCodeBuddyAdapter({
    acpClientFactory: opts => spawnAcpClient({ ...opts, command: process.execPath, args: [fixture] })
  });
  const observations = [];
  const host = new AdapterHost({
    observe: async (_identity, observation) => {
      observations.push(observation);
      return { captureId: "capture-codebuddy-load-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codebuddy", {
    ...request,
    invocationId: "inv-codebuddy-load",
    providerSession: { sessionId: "acp-existing-session" }
  })) events.push(event);

  assert.equal(events.at(-1).type, "run.finished");
  const loadInput = observations.find(observation =>
    observation.event === "provider.input" && observation.rpcMethod === "session/load"
  );
  assert.equal(loadInput.providerRequestId, "2");
  assert.equal(loadInput.providerSessionId, "acp-existing-session");
  assert.deepEqual(loadInput.carrier.content, {
    method: "session/load",
    params: { sessionId: "acp-existing-session", cwd: request.workdir, mcpServers: [] }
  });
  const loadLifecycle = observations.filter(observation => observation.providerRequestId === "2");
  assert.deepEqual(
    loadLifecycle.map(observation => observation.event),
    ["provider.input", "provider.dispatch.written", "provider.dispatch.acknowledged"]
  );
});

test("CodeBuddy failed dispatch retains the real prompt request id", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));
  const adapter = createCodeBuddyAdapter({
    acpClientFactory: opts => spawnAcpClient({ ...opts, command: process.execPath, args: [fixture] })
  });
  const observations = [];
  const host = new AdapterHost({
    observe: async (_identity, observation) => {
      observations.push(observation);
      return { captureId: "capture-codebuddy-failed-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codebuddy", {
    ...request,
    invocationId: "inv-codebuddy-failed",
    prompt: "FAIL_PROVIDER_REQUEST"
  })) events.push(event);

  assert.equal(events.at(-1).type, "run.error");
  const promptLifecycle = observations.filter(observation => observation.providerRequestId === "3");
  assert.deepEqual(
    promptLifecycle.map(observation => observation.event),
    ["provider.input", "provider.dispatch.written", "provider.dispatch.failed"]
  );
  assert.equal(promptLifecycle.every(observation =>
    observation.rpcMethod === "session/prompt"
  ), true);
});

test("Codex app-server subprocess completes the canonical contract", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", request)) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    "session.update", "model_step.started", "message.create", "message.delta", "message.update",
    "tool_call.create", "model_step.finished", "tool_call.delta", "tool_call.update",
    "model_step.started", "message.create", "message.delta", "message.update",
    "tool_call.create", "model_step.finished", "tool_call.delta", "tool_call.update",
    "model_step.started", "message.create", "message.delta", "message.update", "model_step.finished",
    "usage.update", "run.finished"
  ]);
  assert.equal(events.find(event => event.type === "session.update").payload.providerSession.sessionId, "thread-app-server-1");
  assert.deepEqual(
    events.filter(event => event.type === "tool_call.create").map(event => event.payload.name),
    ["exec_command", "exec_command"]
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "analysis")
      .map(event => event.payload.text).join(""),
    "Inspect /tmp.Inspect /home/lvsijia."
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "analysis")
      .every(event => event.payload.exposure === "public_summary"
        && event.payload.provenance?.nativeEvent === "item/reasoning/summaryTextDelta"),
    true
  );
  assert.equal(events.find(event => event.type === "usage.update").payload.inputTokens, 3);
  assert.deepEqual(
    events.filter(event => event.type === "model_step.started").map(event => event.payload.stepId),
    ["codex:turn-1:round:1", "codex:turn-1:round:2", "codex:turn-1:round:3"]
  );
});

test("Codex preserves strict capture failure semantics before a model-affecting request", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost({
    observe: async (_identity, observation) => {
      if (observation.event === "provider.input") {
        throw Object.assign(new Error("capture unavailable"), { code: "trace_capture_failed" });
      }
      return { captureId: "codex-strict-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", {
    ...request,
    invocationId: "inv-codex-capture-failure"
  })) events.push(event);
  assert.equal(events.at(-1).type, "run.error");
  assert.equal(events.at(-1).payload.code, "trace_capture_failed");
});

test("Codex app-server falls back to a fresh thread when resume fails", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const observations = [];
  const host = new AdapterHost({
    observe: async (_identity, observation) => {
      observations.push(observation);
      return { captureId: "capture-codex-resume-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", {
    ...request,
    invocationId: "inv-codex-resume",
    modelInput: "PRIMARY_DELTA_MUST_NOT_REACH_FRESH",
    freshFallbackModelInput: "FROZEN_COLD_RECOVERY_INPUT",
    providerSession: { sessionId: "missing-thread" }
  })) events.push(event);
  const session = events.find(event => event.type === "session.update").payload.providerSession;
  assert.equal(session.sessionId, "thread-app-server-1");
  assert.equal(session.resumeOutcome, "fresh_fallback");
  assert.equal(session.resumeFallback, "resume_rejected");
  assert.equal(session.contextInputVariant, "recovery");
  assert.equal(events.at(-1).type, "run.finished");
  const resumeLifecycle = observations.filter(observation => observation.providerRequestId === "2");
  assert.deepEqual(
    resumeLifecycle.map(observation => observation.event),
    ["provider.input", "provider.dispatch.written", "provider.dispatch.failed"]
  );
  assert.equal(resumeLifecycle.every(observation =>
    observation.rpcMethod === "thread/resume"
  ), true);
});

test("Codex app-server preserves a compaction session update for the next turn", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", {
    ...request,
    invocationId: "inv-codex-compacted",
    prompt: "EMIT_COMPACTION",
    providerSession: { sessionId: "existing-thread" }
  })) events.push(event);
  const sessions = events
    .filter(event => event.type === "session.update")
    .map(event => event.payload.providerSession);
  assert.deepEqual(sessions, [
    { sessionId: "existing-thread", resumable: true, resumeOutcome: "resumed" },
    { sessionId: "existing-thread", resumable: true, resumeOutcome: "compacted" }
  ]);
  assert.equal(events.at(-1).type, "run.finished");
});

test("only Codex declares append-only continuity recovery", () => {
  assert.equal(createCodexAdapter().metadata.capabilities.includes("session.resume_recovery"), true);
  assert.equal(createClaudeCodeAdapter().metadata.capabilities.includes("session.resume_recovery"), false);
  assert.equal(createCodeBuddyAdapter().metadata.capabilities.includes("session.resume_recovery"), false);
});

test("Codex app-server maps disabled thinking to low effort", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", {
    ...request,
    invocationId: "inv-codex-low-effort",
    prompt: "EXPECT_LOW_EFFORT",
    agentConfig: { thinking: "disabled" }
  })) events.push(event);
  assert.equal(events.at(-1).type, "run.finished");
});

test("Codex rejects unsupported reasoning summary overrides before starting a turn", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", {
    ...request,
    invocationId: "inv-codex-invalid-summary",
    agentConfig: { providerOptions: { reasoningSummary: "verbatim" } }
  })) events.push(event);
  assert.equal(events.at(-1).type, "run.error");
  assert.match(events.at(-1).payload.message, /unsupported Codex reasoning summary/);
});

test("Codex app-server follows host cancellation", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const invocation = { ...request, invocationId: "inv-codex-cancel", prompt: "WAIT_FOR_CANCEL" };
  const events = [];
  for await (const event of host.invoke("codex", invocation)) {
    events.push(event);
    if (event.type === "message.delta") assert.equal(host.cancel(invocation.invocationId, "test_cancel"), true);
  }
  assert.equal(events.at(-1).type, "run.stopped");
  assert.equal(events.filter(event => event.type.startsWith("run.")).length, 1);
});

test("OpenClaw local subprocess completes the canonical contract", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-openclaw.mjs", import.meta.url));
  const stateDir = await mkdtemp(join(tmpdir(), "octo-harness-openclaw-state-"));
  const adapter = createOpenClawAdapter({
    command: process.execPath,
    commandArgsPrefix: [fixture],
    env: { OPENCLAW_STATE_DIR: stateDir, FAKE_OPENCLAW_TRANSCRIPT: "1" }
  });
  const observations = [];
  const host = new AdapterHost({
    observe: async (_identity, observation) => {
      observations.push(observation);
      return { captureId: "openclaw-output-test", state: "accepted", complete: true };
    }
  });
  host.register(adapter);
  const events = [];
  try {
    for await (const event of host.invoke("openclaw", request)) events.push(event);
    assert.deepEqual(events.map(event => event.type), [
      "session.update", "message.create",
      "model_step.started", "message.create", "message.delta", "tool_call.create", "message.update", "model_step.finished",
      "tool_call.update",
      "model_step.started", "message.delta", "model_step.finished",
      "usage.update", "message.update", "run.finished"
    ]);
    assert.equal(
      events.filter(event => event.type === "message.delta" && event.payload.channel === "final")
        .map(event => event.payload.text).join(""),
      "OpenClaw reply"
    );
    assert.equal(
      events.find(event => event.type === "message.delta" && event.payload.channel === "analysis").payload.text,
      "Inspect the repository."
    );
    assert.deepEqual(
      events.filter(event => event.type === "model_step.started").map(event => event.payload.stepId),
      ["openclaw:assistant-1", "openclaw:assistant-2"]
    );
    assert.equal(events.find(event => event.type === "tool_call.create").payload.stepId, "openclaw:assistant-1");
    assert.equal(events.find(event => event.type === "tool_call.update").payload.durationMs, 15);
    assert.equal(events.at(-1).type, "run.finished");
    assert.ok(observations.some(observation => observation.event === "provider.output"));
    assert.equal(observations.some(observation => observation.event === "provider.dispatch.acknowledged"), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("OpenClaw local subprocess follows host cancellation", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-openclaw.mjs", import.meta.url));
  const adapter = createOpenClawAdapter({ command: process.execPath, commandArgsPrefix: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  const invocation = { ...request, invocationId: "inv-openclaw-cancel", prompt: "FAKE_WAIT_FOR_CANCEL" };
  for await (const event of host.invoke("openclaw", invocation)) {
    events.push(event);
    if (event.type === "message.delta") assert.equal(host.cancel(invocation.invocationId, "test_cancel"), true);
  }
  assert.equal(events.at(-1).type, "run.stopped");
  assert.equal(events.some(event => event.type === "run.error"), false);
});
