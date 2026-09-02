import test from "node:test";
import assert from "node:assert/strict";
import { assertCanonicalEvent } from "../packages/octo-harness-protocol/dist/index.js";

test("tool call protocol preserves complete and streamed command inputs", () => {
  const codex = {
    type: "tool_call.create",
    payload: { id: "tool-codex", name: "exec_command", args: { command: "pwd", cwd: "/repo" } }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(codex));
  assert.equal(codex.payload.args.command, "pwd");

  const claude = [
    { type: "tool_call.create", payload: { id: "tool-claude", name: "Bash", args: {} } },
    { type: "tool_call.delta", payload: { id: "tool-claude", argsDelta: '{"command":"printf ' } },
    { type: "tool_call.delta", payload: { id: "tool-claude", argsDelta: 'octo-harness-ok"}' } },
    { type: "tool_call.update", payload: { id: "tool-claude", status: "completed", output: "octo-harness-ok" } }
  ];
  for (const event of claude) assert.doesNotThrow(() => assertCanonicalEvent(event));
  const streamedArgs = claude
    .filter(event => event.type === "tool_call.delta")
    .map(event => event.payload.argsDelta)
    .join("");
  assert.equal(JSON.parse(streamedArgs).command, "printf octo-harness-ok");
});

test("tool call protocol rejects events that cannot reconstruct a command lifecycle", () => {
  assert.throws(
    () => assertCanonicalEvent({ type: "tool_call.create", payload: { id: "tool-1", name: "Bash" } }),
    /payload\.args must be an object/
  );
  assert.throws(
    () => assertCanonicalEvent({ type: "tool_call.delta", payload: { id: "tool-1" } }),
    /requires argsDelta or outputDelta/
  );
  assert.throws(
    () => assertCanonicalEvent({ type: "tool_call.update", payload: { id: "tool-1" } }),
    /payload\.status must be a non-empty string/
  );
});
