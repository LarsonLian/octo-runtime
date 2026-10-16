import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createClaudeCodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { createZcodeGuiAdapter } from "@mininglamp-oss/octo-runtime-adapter-zcode-gui";
import { AdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";

const request = { protocolVersion: 2, invocationId: "permission-instance", agentSessionId: "session", runId: "run", prompt: "fixture", modelInput: "fixture", controlInstructions: "", workdir: process.cwd(), approvalMode: "ask", agentSource: "provisioned", agentConfig: {}, context: { schema: "octo.context-envelope/v3", items: [] } };

test("default adapters reject unsupported approval modes at their execution boundary", async () => {
  const manifest = JSON.parse(await readFile(new URL("../apps/cli/src/default_adapters.json", import.meta.url), "utf8"));
  assert.equal(manifest.adapters.length, 12);
  for (const entry of manifest.adapters) {
    const adapter = (await import(entry.module))[entry.export];
    if (entry.type === "antigravity") {
      assert.equal(adapter.respondInteraction, undefined);
      for (const approvalMode of ["ask", "assisted"])
        await assert.rejects(async () => {
          for await (const event of adapter.invoke({ ...request, approvalMode })) assert.fail(event.type);
        }, /APPROVAL_MODE_UNSUPPORTED/);
      continue;
    }
    assert.equal(typeof adapter.respondInteraction, "function", entry.type);
    if (!["codex", "claude-code", "codebuddy"].includes(entry.type))
      await assert.rejects(async () => {
        for await (const event of adapter.invoke({ ...request, approvalMode: "assisted" })) assert.fail(event.type);
      }, /APPROVAL_MODE_UNSUPPORTED/);
  }
});

for (const approvalMode of ["ask", "assisted", "full_access"])
  test(`Host admits ${approvalMode} through the actual responder without feature labels`, async () => {
    const host = new AdapterHost();
    let invoked;
    host.register({ metadata: { protocolSupport: { protocol: "fixture.canonical", modes: ["canonical"], nativeMethods: [] }, type: "fixture", agentSources: ["provisioned"] },
      async respondInteraction() {}, async *invoke(input) {
        invoked = input.approvalMode;
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      } });
    const events = [];
    for await (const event of preparedTestInvoke((...args) => preparedFrames(host, ...args))("fixture", { ...request, approvalMode }, { protocolMode: "canonical" })) events.push(event);
    assert.equal(invoked, approvalMode);
    assert.equal(events.at(-1).type, "run.completed");
  });

for (const protocolMode of ["canonical", "native"])
  test(`Host requires the actual ${protocolMode} responder for interactive approval`, async () => {
    const host = new AdapterHost();
    let invoked = false;
    host.register({ metadata: { protocolSupport: { protocol: "fixture.raw", modes: ["native", "canonical"], nativeMethods: [] }, type: "fixture", agentSources: ["provisioned"] },
      ...(protocolMode === "native" ? { async respondInteraction() {} } : { async respondNative() {} }),
      async *invoke() { invoked = true; } });
    await assert.rejects(async () => {
      for await (const frame of preparedFrames(host, "fixture", request, { protocolMode })) assert.fail(frame.kind);
    }, /APPROVAL_MODE_UNSUPPORTED/);
    assert.equal(invoked, false);
  });

for (const [provider, factory] of [
  ["Claude", () => createClaudeCodeAdapter({ command: process.execPath, commandArgsPrefix: [fileURLToPath(new URL("../test-support/claude/fake-permission-cli.js", import.meta.url))] })],
  ["ZCode", () => createZcodeGuiAdapter({ command: process.execPath, appServerArgs: [fileURLToPath(new URL("../test-support/zcode/fake-zcode-app-server.js", import.meta.url))] })]
]) {
  for (const outcome of ["accepted", "declined", "cancelled"]) {
    test(`${provider} waits for ${outcome} and returns it to the original native request`, { timeout: 5000 }, async () => {
      const adapter = factory();
      const events = [];
      for await (const event of adapter.invoke(request)) {
        events.push(event);
        if (event.type !== "interaction.requested") continue;
        assert.equal(events.some(item => item.type === "interaction.resolved"), false);
        await assert.rejects(adapter.respondInteraction("stale-instance", { interactionId: event.payload.interactionId, outcome }), /INTERACTION_NOT_ACTIVE/);
        await adapter.respondInteraction(request.invocationId, { interactionId: event.payload.interactionId, outcome });
      }
      assert.equal(events.at(-1).type, "run.completed");
      assert.equal(events.find(item => item.type === "interaction.resolved")?.payload.outcome, outcome);
      const final = events.filter(item => item.type.startsWith("message.") && item.payload.channel !== "analysis").map(item => item.payload.text ?? "").join("");
      assert.match(final, new RegExp(`permission:${outcome === "accepted" ? "allow" : "deny"}`));
    });
  }
}
