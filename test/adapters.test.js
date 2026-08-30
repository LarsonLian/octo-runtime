import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { AdapterHost } from "@orbtex-ai/orbtex-adapter-host";
import { spawnAcpClient } from "@orbtex-ai/orbtex-acp-client";
import { createCodeBuddyAdapter, normalizeCodeBuddyUpdate } from "@orbtex-ai/orbtex-adapter-codebuddy";
import { normalizeCodexEvent, createCodexInvocationHome } from "@orbtex-ai/orbtex-adapter-codex";
import { buildClaudeCommand, normalizeClaudeEvent } from "@orbtex-ai/orbtex-adapter-claude-code";
import { buildOpenCodeCommand, normalizeOpenCodeEvent } from "@orbtex-ai/orbtex-adapter-opencode";
import {
  buildOpenClawCommand,
  createOpenClawAdapter,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob
} from "@orbtex-ai/orbtex-adapter-openclaw";

const request = { invocationId: "inv-1", sessionId: "session-1", runId: "run-1", prompt: "work", workdir: process.cwd(), context: {}, appendInstructions: "CONTROL", agentConfig: {} };

test("Codex native events map to session/message/usage/terminal", () => {
  assert.equal(normalizeCodexEvent({ type: "thread.started", thread_id: "thread-1" })[0].type, "session.update");
  assert.equal(normalizeCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "ok" } })[0].type, "message.delta");
  assert.deepEqual(normalizeCodexEvent({ type: "turn.completed", usage: { input_tokens: 1 } }).map(x => x.type), ["usage.update", "message.update", "run.finished"]);
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

test("Claude defaults to unattended bypass and disables interactive tools", async () => {
  const claude = await buildClaudeCommand(request);
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(claude.args.includes("--dangerously-skip-permissions"), true);
  assert.deepEqual(
    claude.args.flatMap((arg, index) => arg === "--disallowedTools" ? [claude.args[index + 1]] : []),
    ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]
  );
  await claude.cleanup();
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

test("CodeBuddy ACP subprocess completes the canonical contract", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));
  const adapter = createCodeBuddyAdapter({ acpClientFactory: opts => spawnAcpClient({ ...opts, command: process.execPath, args: [fixture] }) });
  const host = new AdapterHost(); host.register(adapter);
  const events = [];
  for await (const event of host.invoke("codebuddy", request)) events.push(event);
  assert.deepEqual(events.map(x => x.type), ["session.update", "message.create", "message.delta", "tool_call.create", "tool_call.update", "usage.update", "message.update", "run.finished"]);
  assert.equal(normalizeCodeBuddyUpdate({ type: "usage", usage: { inputTokens: 1 } })[0].type, "usage.update");
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
