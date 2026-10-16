import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { contextHash } from "../packages/octo-runtime-protocol/dist/index.js";
import { codexAppServerFixture, invokeRequest, withTimeout } from "./runtime-fixture.js";

const fixture = fileURLToPath(new URL("../test-support/fake-codex-cancellation.mjs", import.meta.url));

for (const mode of ["eof", "nonzero", "malformed", "wait"]) {
  test(`Codex diagnostics preserve transport failure/cancellation: ${mode}`, { timeout: 6000 }, async () => {
    const adapter = createCodexAdapter({ command: process.execPath,
      appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-diagnostics.mjs", import.meta.url))] });
    const controller = new AbortController();
    const events = [];
    for await (const e of adapter.invoke(invokeRequest({ modelInput: `DIAGNOSTIC_QA:${mode}`,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) }))) {
      events.push(e);
      if (mode === "wait" && e.type === "run.notice") controller.abort("test_cancel");
    }
    assert.equal(events.filter(e => e.payload.code === "provider_diagnostic").length, 1);
    const terminal = events.filter(e => ["run.completed", "run.failed", "run.cancelled"].includes(e.type));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, mode === "wait" ? "run.cancelled" : "run.failed");
  });
}

for (const mode of ["normal", "stall", "ignore-interrupt", "commentary", "open-tool", "new-work"]) {
  test(`Codex finalization deadline: ${mode}`, { timeout: 6_000 }, async () => {
    const adapter = createCodexAdapter({ command: process.execPath,
      appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-finalization.mjs", import.meta.url))] });
    const events = [];
    const started = Date.now();
    for await (const event of adapter.invoke(invokeRequest({
      modelInput: mode, signal: AbortSignal.timeout(5_000),
      agentConfig: { providerOptions: { finalizationTimeoutMs: 60 } }
    }))) events.push(event);
    const terminals = events.filter(event => ["run.failed", "run.completed", "run.cancelled"].includes(event.type));
    assert.equal(terminals.length, 1);
    assert.ok(events.some(event => event.type === "message.update" && event.payload.text === "answer preserved"));
    if (["stall", "ignore-interrupt"].includes(mode)) {
      assert.equal(terminals[0].type, "run.failed");
      assert.equal(terminals[0].payload.code, "CODEX_FINALIZATION_TIMEOUT");
      assert.ok(Date.now() - started < 4_000);
    } else assert.equal(terminals[0].type, "run.completed");
  });
}

test("Codex reports scoped activity before normalization without retry/duplicate progress", { timeout: 5_000 }, async () => {
  const adapter = createCodexAdapter({ command:process.execPath, appServerArgs:[fileURLToPath(new URL("../test-support/fake-codex-activity.mjs",import.meta.url))] });
  const activities=[]; const events=[];
  for await(const event of adapter.invoke(invokeRequest({ invocationId: "i", agentSessionId: "s", runId: "r", signal: AbortSignal.timeout(4_000) }), {
    reportActivity:a=>activities.push(a)
  })) events.push(event);
  assert.equal(activities.filter(a=>a.kind==="turn_progress" && a.method==="text_delta").length,1);
  assert.deepEqual(activities.filter(a=>a.kind==="turn_progress" && a.method==="tool_delta"), [
    { kind: "turn_progress", method: "tool_delta", toolCallId: "mcp" }
  ]);
  assert.equal(events.filter(event => event.type === "tool_call.progress" && event.payload.progress.message === "working").length, 1);
  assert.equal(activities.filter(a=>a.method==="usage").length,1);
  assert.equal(activities.filter(a=>a.method==="item_lifecycle").length,1);
  assert.equal(activities.filter(a=>a.kind==="retry_notice").length,1);
  assert.ok(activities.some(a=>a.kind==="transport_response"));
  assert.doesNotMatch(JSON.stringify(activities),/secret|noise|not ours|not current|ok/);
  assert.doesNotMatch(JSON.stringify(events),/not ours|not current/);
  assert.equal(events.at(-1).type,"run.completed");
});

test("Codex cancellation reaps the whole app-server process group", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-codex-cancel-"));
  const pidFile = join(directory, "grandchild.pid");
  const controller = new AbortController();
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const events = [];

  try {
    for await (const event of adapter.invoke(invokeRequest({
      invocationId: "invoke-cancel-tree",
      agentSessionId: "session-cancel-tree",
      runId: "run-cancel-tree",
      prompt: `WAIT_FOR_CANCEL PID_FILE=${pidFile}`,
      modelInput: `WAIT_FOR_CANCEL PID_FILE=${pidFile}`,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)])
    }))) {
      events.push(event);
      if (event.type === "message.delta") controller.abort("test_cancel");
    }

    assert.equal(events.at(-1).type, "run.cancelled");
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(grandchildPid, 0), error => error?.code === "ESRCH");
  } finally {
    controller.abort("test_cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

for (const approvalMode of ["ask", "assisted", "full_access"]) {
  test(`Codex ${approvalMode} keeps questions and MCP elicitation interactive with scoped requests and resolved events`, { timeout: 5_000 }, async () => {
    const adapter = createCodexAdapter({
      command: process.execPath,
      appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-interaction.mjs", import.meta.url))]
    });
    const request = invokeRequest({ invocationId: `invoke-interaction-${approvalMode}`, approvalMode, signal: AbortSignal.timeout(4_000) });
    const events = [];
    const outcomes = new Map();
    let sequence = 0;
    let humanApprovalCalls = 0;
    for await (const event of adapter.invoke(request)) {
      events.push(event);
      if (event.type !== "interaction.requested") continue;
      const { payload } = event;
      const nativeId = payload.kind === "approval" ? "interactive-approval" : payload.kind === "elicitation" ? "interactive-elicitation" : 9001;
      sequence += 1;
      assert.equal(payload.interactionId, `codex:${createHash("sha256").update(JSON.stringify([request.invocationId, nativeId, sequence])).digest("hex")}`);
      assert.equal(payload.executionInstanceId, request.invocationId);
      const remainingMs = Date.parse(payload.expiresAt) - Date.now();
      assert.ok(remainingMs > 590_000 && remainingMs <= 600_000);
      let response;
      if (payload.kind === "approval") {
        assert.equal(payload.request.schema, "octo.approval-request/v1");
        assert.deepEqual(payload.request.policy, { mode: approvalMode, hash: contextHash(request.context) });
        assert.equal(payload.request.operation.kind, "command_execution");
        assert.equal(payload.request.operation.toolCallId, "command-1");
        assert.equal(payload.request.providerDetails.command, "pnpm add example");
        assert.equal(payload.request.providerDetails.itemId, "command-1");
        assert.equal(Object.hasOwn(payload.request.providerDetails, "itemKey"), false);
        assert.equal(payload.request.command, undefined);
        assert.deepEqual(payload.request.requestedPermissions, []);
        assert.deepEqual(payload.request.allowedOutcomes, ["accepted", "declined", "cancelled"]);
        assert.equal(payload.request.grantScope, "request");
        if (approvalMode === "full_access") {
          outcomes.set(payload.interactionId, "accepted");
          continue;
        }
        response = { interactionId: payload.interactionId, outcome: "accepted" };
      } else if (payload.kind === "elicitation") {
        assert.equal(payload.request.title, "Verify account");
        assert.doesNotMatch(JSON.stringify(payload.request), /provider-secret|challenge|_meta/);
        response = { interactionId: payload.interactionId, outcome: "answered", value: { account: "verified" } };
      } else {
        assert.equal(payload.kind, "question");
        assert.equal(payload.request.questions[0].id, "language");
        response = { interactionId: payload.interactionId, outcome: "answered", value: { language: "TypeScript" } };
      }
      await assert.rejects(adapter.respondInteraction("invoke-stale", { interactionId: payload.interactionId, outcome: "accepted" }), /no active Codex interaction invocation/);
      await assert.rejects(adapter.respondInteraction(request.invocationId, { interactionId: "unknown-interaction", outcome: "accepted" }), /unknown codex interaction/);
      if (payload.kind === "approval") humanApprovalCalls += 1;
      await adapter.respondInteraction(request.invocationId, response);
      outcomes.set(payload.interactionId, response.outcome);
      await assert.rejects(adapter.respondInteraction(request.invocationId, response), /unknown codex interaction/);
    }
    assert.deepEqual(events.filter(event => event.type === "interaction.requested").map(event => event.payload.kind), ["approval", "elicitation", "question"]);
    assert.equal(humanApprovalCalls, approvalMode === "full_access" ? 0 : 1);
    const resolved = events.filter(event => event.type === "interaction.resolved");
    assert.equal(resolved.length, outcomes.size);
    for (const event of resolved) {
      assert.equal(event.payload.status, "resolved");
      assert.equal(event.payload.executionInstanceId, request.invocationId);
      assert.equal(event.payload.outcome, outcomes.get(event.payload.interactionId));
      if (approvalMode === "full_access" && event.payload.outcome === "accepted") {
        assert.equal(event.payload.reasonCode, "full_access_policy");
      }
      assert.ok(events.findIndex(candidate => candidate.type === "interaction.requested" && candidate.payload.interactionId === event.payload.interactionId) < events.indexOf(event));
    }
    assert.equal(events.at(-1).type, "run.completed");
    await assert.rejects(adapter.respondInteraction(request.invocationId, { interactionId: "after-terminal", outcome: "accepted" }), /no active Codex interaction invocation/);
  });
}

test("Codex resolves an approval only after the native response is written and rejects in-flight duplicates", { timeout: 5_000 }, async () => {
  const server = codexAppServerFixture({ holdResponseWrites: true });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const request = invokeRequest({ signal: AbortSignal.timeout(4_000) });
  const events = [];
  const iterator = adapter.invoke(request)[Symbol.asyncIterator]();
  try {
    let interaction;
    while (!interaction) {
      const next = await withTimeout(iterator.next(), 1_000, "approval request timeout");
      assert.equal(next.done, false);
      events.push(next.value);
      if (next.value.type === "interaction.requested") interaction = next.value;
    }
    const response = { interactionId: interaction.payload.interactionId, outcome: "accepted" };
    let written = false;
    const responding = adapter.respondInteraction(request.invocationId, response).then(() => { written = true; });
    await assert.rejects(adapter.respondInteraction(request.invocationId, response), /already in flight/);
    let delivered = false;
    const nextEvent = iterator.next().then(next => { delivered = true; return next; });
    await new Promise(setImmediate);
    assert.equal(written, false);
    assert.equal(delivered, false);
    assert.deepEqual(server.writes.at(-1).result, { decision: "accept" });
    assert.equal(server.writes.find(message => message.method === "thread/start").params.developerInstructions, request.controlInstructions);
    assert.equal(server.writes.find(message => message.method === "turn/start").params.input[0].text, request.modelInput);
    assert.doesNotMatch(JSON.stringify(server.writes), /test\/invoke|Display-safe input/);
    server.flushResponseWrites();
    await withTimeout(responding, 1_000, "native response write timeout");
    assert.equal(written, true);
    const next = await withTimeout(nextEvent, 1_000, "resolved event timeout");
    assert.equal(next.done, false);
    assert.equal(next.value.type, "interaction.resolved");
    events.push(next.value);
    server.complete();
    for await (const event of iterator) events.push(event);
  } finally {
    server.flushResponseWrites();
    server.close(1);
    await iterator.return();
  }
  assert.equal(events.filter(event => event.type === "interaction.resolved").length, 1);
  assert.equal(events.find(event => event.type === "interaction.resolved").payload.outcome, "accepted");
  assert.equal(events.at(-1).type, "run.completed");
});

test("Codex full_access audits native approval after write completion without a human response", { timeout: 5_000 }, async () => {
  const server = codexAppServerFixture({ holdResponseWrites: true });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const request = invokeRequest({ approvalMode: "full_access", signal: AbortSignal.timeout(4_000) });
  const iterator = adapter.invoke(request)[Symbol.asyncIterator]();
  const events = [];
  try {
    let requested;
    while (!requested) {
      const next = await withTimeout(iterator.next(), 1_000, "automatic approval request timeout");
      assert.equal(next.done, false);
      events.push(next.value);
      if (next.value.type === "interaction.requested") requested = next.value;
    }
    assert.equal(requested.payload.kind, "approval");
    assert.equal(requested.payload.executionInstanceId, request.invocationId);
    assert.equal(requested.payload.request.policy.mode, "full_access");
    assert.equal(requested.payload.request.schema, "octo.approval-request/v1");
    assert.deepEqual(server.writes.at(-1).result, { decision: "accept" });
    let delivered = false;
    const nextEvent = iterator.next().then(next => { delivered = true; return next; });
    await new Promise(setImmediate);
    assert.equal(delivered, false);
    server.flushResponseWrites();
    const resolved = await withTimeout(nextEvent, 1_000, "automatic approval resolution timeout");
    assert.equal(resolved.done, false);
    assert.equal(resolved.value.type, "interaction.resolved");
    assert.deepEqual(resolved.value.payload, {
      interactionId: requested.payload.interactionId,
      executionInstanceId: request.invocationId,
      status: "resolved", outcome: "accepted", reasonCode: "full_access_policy"
    });
    events.push(resolved.value);
    server.complete();
    for await (const event of iterator) events.push(event);
    assert.equal(events.filter(event => event.type === "interaction.requested").length, 1);
    assert.equal(events.filter(event => event.type === "interaction.resolved").length, 1);
    assert.equal(server.writes.filter(message => message.id === "native-request-1" && message.result?.decision === "accept").length, 1);
    assert.equal(events.at(-1).type, "run.completed");
  } finally {
    server.flushResponseWrites();
    server.close(1);
    await iterator.return();
  }
});

test("Codex full_access approval cannot be manually answered while the automatic response is in flight", { timeout: 5_000 }, async () => {
  const server = codexAppServerFixture({ holdResponseWrites: true });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const request = invokeRequest({ approvalMode: "full_access", signal: AbortSignal.timeout(4_000) });
  const events = [];
  try {
    for await (const event of adapter.invoke(request)) {
      events.push(event);
      if (event.type !== "interaction.requested") continue;
      await assert.rejects(withTimeout(adapter.respondInteraction(request.invocationId, {
        interactionId: event.payload.interactionId, outcome: "declined"
      }), 1_000, "manual response rejection timeout"), /already in flight/);
      server.flushResponseWrites();
      server.complete();
    }
  } finally {
    server.flushResponseWrites();
    server.close(1);
  }
  assert.equal(server.writes.filter(message => message.id === "native-request-1" && message.result?.decision === "accept").length, 1);
  assert.equal(server.writes.some(message => message.result?.decision === "decline"), false);
  assert.equal(events.find(event => event.type === "interaction.resolved").payload.reasonCode, "full_access_policy");
  assert.equal(events.at(-1).type, "run.completed");
});

test("Codex native request IDs are isolated across invocations and stale answers cannot target a replacement", { timeout: 5_000 }, async () => {
  const servers = [];
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: () => {
    const server = codexAppServerFixture();
    servers.push(server);
    return server.spawnFn();
  } });
  const interactionIds = [];
  for (const invocationId of ["invoke-before-restart", "invoke-after-restart"]) {
    const events = [];
    for await (const event of adapter.invoke(invokeRequest({ invocationId, signal: AbortSignal.timeout(4_000) }))) {
      events.push(event);
      if (event.type !== "interaction.requested") continue;
      const interactionId = event.payload.interactionId;
      assert.equal(event.payload.executionInstanceId, invocationId);
      if (interactionIds.length) {
        assert.notEqual(interactionId, interactionIds[0]);
        await assert.rejects(adapter.respondInteraction(invocationId, { interactionId: interactionIds[0], outcome: "accepted" }), /unknown codex interaction/);
      }
      interactionIds.push(interactionId);
      await adapter.respondInteraction(invocationId, { interactionId, outcome: "accepted" });
      servers.at(-1).complete();
    }
    assert.equal(events.at(-1).type, "run.completed");
  }
  assert.equal(new Set(interactionIds).size, 2);
});

test("Codex repeated native IDs within one invocation get distinct sequence-scoped interactions", { timeout: 5_000 }, async () => {
  const server = codexAppServerFixture();
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const request = invokeRequest({ signal: AbortSignal.timeout(4_000) });
  const interactionIds = [];
  const events = [];
  for await (const event of adapter.invoke(request)) {
    events.push(event);
    if (event.type !== "interaction.requested") continue;
    const interactionId = event.payload.interactionId;
    const sequence = interactionIds.length + 1;
    assert.equal(interactionId, `codex:${createHash("sha256").update(JSON.stringify([request.invocationId, "native-request-1", sequence])).digest("hex")}`);
    if (interactionIds.length) {
      assert.notEqual(interactionId, interactionIds[0]);
      await assert.rejects(adapter.respondInteraction(request.invocationId, {
        interactionId: interactionIds[0], outcome: "accepted"
      }), /unknown codex interaction/);
    }
    interactionIds.push(interactionId);
    await adapter.respondInteraction(request.invocationId, { interactionId, outcome: "accepted" });
    if (sequence === 1) server.requestInteraction();
    else server.complete();
  }
  assert.equal(new Set(interactionIds).size, 2);
  assert.deepEqual(events.filter(event => event.type === "interaction.resolved").map(event => event.payload.interactionId), interactionIds);
  assert.equal(server.writes.filter(message => message.id === "native-request-1" && message.result?.decision === "accept").length, 2);
  assert.equal(events.at(-1).type, "run.completed");
});

test("Codex pending interactions expire and cannot be answered after the finite deadline", { timeout: 5_000 }, async testContext => {
  testContext.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const server = codexAppServerFixture();
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const request = invokeRequest({ signal: AbortSignal.timeout(4_000) });
  const events = [];
  for await (const event of adapter.invoke(request)) {
    events.push(event);
    if (event.type !== "interaction.requested") continue;
    assert.equal(Date.parse(event.payload.expiresAt) - Date.now(), 600_000);
    testContext.mock.timers.tick(600_000);
    await assert.rejects(adapter.respondInteraction(request.invocationId, { interactionId: event.payload.interactionId, outcome: "accepted" }), /unknown codex interaction/);
    server.close(1);
  }
  const resolved = events.filter(event => event.type === "interaction.resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].payload.status, "expired");
  assert.equal(resolved[0].payload.reasonCode, "approval_timeout");
  assert.equal(resolved[0].payload.executionInstanceId, request.invocationId);
  assert.equal(server.writes.some(message => message.result?.decision === "accept"), false);
  assert.equal(events.at(-1).type, "run.failed");
  assert.match(events.at(-1).payload.message, /INTERACTION_EXPIRED/);
});

for (const termination of ["process_death", "cancellation"]) {
  test(`Codex ${termination} invalidates pending interactions before the terminal event`, { timeout: 5_000 }, async () => {
    const server = codexAppServerFixture();
    const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
    const controller = new AbortController();
    const request = invokeRequest({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]) });
    const events = [];
    for await (const event of adapter.invoke(request)) {
      events.push(event);
      if (event.type !== "interaction.requested") continue;
      if (termination === "process_death") server.close(1);
      else controller.abort("test_cancel");
      await assert.rejects(adapter.respondInteraction(request.invocationId, { interactionId: event.payload.interactionId, outcome: "accepted" }), /codex interaction is no longer active/);
    }
    const requested = events.find(event => event.type === "interaction.requested");
    const invalidated = events.filter(event => event.type === "interaction.resolved");
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0].payload.interactionId, requested.payload.interactionId);
    assert.equal(invalidated[0].payload.executionInstanceId, request.invocationId);
    assert.equal(invalidated[0].payload.status, "invalidated");
    assert.equal(events.at(-1).type, termination === "process_death" ? "run.failed" : "run.cancelled");
    assert.ok(events.indexOf(invalidated[0]) < events.length - 1);
    assert.equal(server.writes.some(message => message.result?.decision === "accept"), false);
  });
}

for (const approvalMode of ["ask", "assisted", "full_access"]) {
  test(`Codex ${approvalMode} rejects native turn-scoped permission grants instead of claiming request scope`, { timeout: 5_000 }, async () => {
    const server = codexAppServerFixture({ method: "item/permissions/requestApproval" });
    const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
    const events = [];
    for await (const event of adapter.invoke(invokeRequest({ approvalMode, signal: AbortSignal.timeout(4_000) }))) events.push(event);
    assert.equal(events.some(event => event.type === "interaction.requested"), false);
    assert.equal(events.at(-1).type, "run.failed");
    assert.match(events.at(-1).payload.message, /APPROVAL_GRANT_SCOPE_UNSUPPORTED/);
    assert.equal(server.writes.some(message => message.result?.decision === "accept"), false);
  });
}
