import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createClaudeCodeAdapter } from "@mininglamp-oss/octo-harness-adapter-claude-code";
import { createZcodeGuiAdapter } from "@mininglamp-oss/octo-harness-adapter-zcode-gui";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { adapterApprovalModes } from "@mininglamp-oss/octo-harness-protocol";

const request = { protocolVersion: 2, invocationId: "permission-instance", agentSessionKey: "session", runKey: "run", prompt: "fixture", modelInput: "fixture", controlInstructions: "", workdir: process.cwd(), approvalMode: "ask", agentSource: "provisioned", agentConfig: {}, context: { schema: "octo.context-envelope/v3", items: [] } };

test("registered adapters advertise executable permission modes and responders for interactive approvals", async () => {
  const manifest = JSON.parse(await readFile(new URL("../config/adapters.json", import.meta.url), "utf8"));
  assert.equal(manifest.adapters.length, 12);
  for (const entry of manifest.adapters) {
    const adapter = (await import(entry.module))[entry.export];
    const modes = adapterApprovalModes(adapter.metadata.executionFeatures);
    if (entry.type === "antigravity") {
      assert.deepEqual(modes, ["full_access"]);
      assert.equal(adapter.respondInteraction, undefined);
      continue;
    }
    assert.ok(modes.length >= 2 && modes.length <= 3, entry.type);
    assert.ok(modes.includes("ask") && modes.includes("full_access"), entry.type);
    assert.equal(typeof adapter.respondInteraction, "function", entry.type);
    assert.equal(modes.includes("assisted"), ["codex", "claude-code", "codebuddy"].includes(entry.type), entry.type);
  }
});

test("host rejects undeclared permission mode before provider invocation", async () => {
  const host = new AdapterHost();
  let invoked = false;
  host.register({ metadata: { type: "two-mode", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.full_access", "interaction.response"] },
    async respondInteraction() {}, async *invoke() { invoked = true; } });
  await assert.rejects(async () => { for await (const event of host.invoke("two-mode", { ...request, approvalMode: "assisted" })) assert.fail(event.type); }, /APPROVAL_MODE_UNSUPPORTED/);
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
