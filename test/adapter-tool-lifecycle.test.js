import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAcpUpdate } from "@mininglamp-oss/octo-runtime-adapter-acp";
import { normalizeCodeBuddyUpdate } from "@mininglamp-oss/octo-runtime-adapter-codebuddy";

for (const [provider, normalize] of [["ACP", update => normalizeAcpUpdate(update, "fixture")], ["CodeBuddy", normalizeCodeBuddyUpdate]]) {
  test(`${provider}: intermediate tool updates retain running state and replace output`, () => {
    const start = normalize({ sessionUpdate: "tool_call", toolCallId: "read-1", name: "read", rawInput: { path: "README.md" } });
    assert.equal(start[0].type, "tool_call.create");
    for (const status of [undefined, "pending", "in_progress", "running", "unrecognized"]) {
      assert.deepEqual(normalize({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status }), []);
      const events = normalize({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status, rawOutput: "current output" });
      assert.deepEqual(events, [{ protocolVersion: 2, type: "tool_call.delta", payload: { id: "read-1", outputSnapshot: "current output" } }]);
    }
    const end = normalize({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", rawOutput: "final output" });
    assert.equal(end[0].payload.status, "completed");
    assert.equal(end[0].payload.output, "final output");
  });

  test(`${provider}: terminal-only tools retain identity without a fabricated start`, () => {
    for (const [native, expected] of [["completed", "completed"], ["failed", "failed"], ["error", "failed"], ["cancelled", "cancelled"]]) {
      const events = normalize({ sessionUpdate: "tool_call", toolCallId: "only-end", title: "read", rawInput: { path: "file" }, status: native, rawOutput: { result: "data" } });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "tool_call.update");
      assert.equal(events[0].payload.name, "read");
      assert.equal(events[0].payload.status, expected);
      assert.deepEqual(events[0].payload.args, { path: "file" });
    }
    assert.deepEqual(normalize({ sessionUpdate: "tool_call_update", status: "completed" }), []);
  });
}
