import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { spawnAcpClient } from "@mininglamp-oss/octo-harness-acp-client";
import { createCodeBuddyAdapter, normalizeCodeBuddyUpdate } from "@mininglamp-oss/octo-harness-adapter-codebuddy";
import {
  buildCodexCommand,
  createCodexAdapter,
  createCodexInvocationHome,
  normalizeCodexEvent
} from "@mininglamp-oss/octo-harness-adapter-codex";
import {
  buildClaudeCommand,
  createClaudeCodeAdapter,
  normalizeClaudeEvent
} from "@mininglamp-oss/octo-harness-adapter-claude-code";
import { buildOpenCodeCommand, normalizeOpenCodeEvent } from "@mininglamp-oss/octo-harness-adapter-opencode";
import {
  buildOpenClawCommand,
  createOpenClawAdapter,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob
} from "@mininglamp-oss/octo-harness-adapter-openclaw";

const request = { invocationId: "inv-1", sessionId: "session-1", runId: "run-1", prompt: "work", workdir: process.cwd(), context: {}, appendInstructions: "CONTROL", agentConfig: {} };

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
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(claude.args.includes("--dangerously-skip-permissions"), true);
  assert.equal(claude.args.includes("--disallowedTools"), false);
  await claude.cleanup();
});

test("Claude maps thinking/text/tool argument partials without replaying assistant snapshots", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-claude-stream.mjs", import.meta.url));
  const adapter = createClaudeCodeAdapter({ command: process.execPath, commandArgsPrefix: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("claude-code", request)) events.push(event);

  assert.deepEqual(events.map(event => event.type), [
    "message.create", "session.update", "message.create", "message.delta",
    "tool_call.create", "tool_call.delta", "tool_call.delta", "tool_call.update",
    "message.delta", "tool_call.create", "tool_call.delta", "tool_call.update",
    "message.delta", "usage.update", "message.update", "message.update", "run.finished"
  ]);
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "analysis")
      .map(event => event.payload.text).join(""),
    "检查 /tmp。检查 /home/lvsijia。"
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "analysis")
      .every(event => event.payload.exposure === "private_reasoning"
        && event.payload.provenance?.provider === "claude-code"),
    true
  );
  assert.equal(
    events.filter(event => event.type === "message.delta" && event.payload.channel === "final")
      .map(event => event.payload.text).join(""),
    "两步检查完成。"
  );
  assert.deepEqual(
    events.filter(event => event.type === "tool_call.create").map(event => event.payload.id),
    ["tool-1", "tool-2"]
  );
  assert.equal(
    events.filter(event => event.type === "tool_call.delta" && event.payload.id === "tool-1")
      .map(event => event.payload.argsDelta).join(""),
    '{"command":"find /tmp"}'
  );
  assert.equal(events.filter(event => event.type === "session.update").length, 1);
  assert.equal(events.find(event => event.type === "message.update" && event.payload.channel === "final").payload.text, undefined);
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

test("OpenCode native events map session/text/tool/usage", () => {
  assert.equal(normalizeOpenCodeEvent({ type: "step_start", sessionID: "oc-1", part: {} })[0].type, "session.update");
  assert.equal(normalizeOpenCodeEvent({ type: "text", part: { text: "ok" } })[0].type, "message.delta");
  assert.equal(normalizeOpenCodeEvent({ type: "step_finish", part: { tokens: { input: 1 } } })[0].type, "usage.update");
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
  await claude.cleanup();

  const opencode = await buildOpenCodeCommand(modelRequest);
  assert.equal(opencode.args.at(-1), "MODEL_INPUT_OK");
  await opencode.cleanup();

  const openclaw = await buildOpenClawCommand(modelRequest);
  assert.match(await readFile(openclaw.messageFile, "utf8"), /\[User Request\]\nMODEL_INPUT_OK$/);
  await openclaw.cleanup();

  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const codex = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(codex);
  const events = [];
  for await (const event of host.invoke("codex", modelRequest)) events.push(event);
  assert.equal(events.at(-1).type, "run.finished");
});

test("CodeBuddy ACP subprocess completes the canonical contract", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));
  let spawnOptions;
  const adapter = createCodeBuddyAdapter({ acpClientFactory: opts => {
    spawnOptions = opts;
    return spawnAcpClient({ ...opts, command: process.execPath, args: [fixture] });
  } });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codebuddy", request)) events.push(event);
  assert.deepEqual(events.map(x => x.type), ["session.update", "message.create", "message.delta", "tool_call.create", "tool_call.update", "usage.update", "message.update", "run.finished"]);
  assert.deepEqual(spawnOptions.args, ["--acp", "--permission-mode", "acceptEdits"]);
  assert.equal(normalizeCodeBuddyUpdate({ type: "usage", usage: { inputTokens: 1 } })[0].type, "usage.update");
  assert.deepEqual(
    normalizeCodeBuddyUpdate({ type: "agent_thought_chunk", text: "checking" })[0].payload,
    {
      text: "checking",
      channel: "analysis",
      exposure: "unknown",
      provenance: { provider: "codebuddy", nativeEvent: "agent_thought_chunk" }
    }
  );
});

test("Codex app-server subprocess completes the canonical contract", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codex", request)) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    "session.update", "message.create", "message.delta", "message.update",
    "tool_call.create", "tool_call.delta", "tool_call.update",
    "message.create", "message.delta", "message.update",
    "tool_call.create", "tool_call.delta", "tool_call.update",
    "message.create", "message.delta", "message.update", "usage.update", "run.finished"
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
});

test("Codex app-server falls back to a fresh thread when resume fails", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url));
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
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
  const adapter = createOpenClawAdapter({ command: process.execPath, commandArgsPrefix: [fixture] });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("openclaw", request)) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    "session.update", "message.create", "message.delta", "tool_call.create",
    "tool_call.update", "usage.update", "message.delta", "message.update", "run.finished"
  ]);
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "OpenClaw reply");
  assert.equal(events.at(-1).type, "run.finished");
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
