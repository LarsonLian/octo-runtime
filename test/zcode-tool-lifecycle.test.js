import test from "node:test";
import assert from "node:assert/strict";
import { ZcodeEventNormalizer } from "@mininglamp-oss/octo-harness-adapter-zcode-gui";

test("ZCode terminal-only tools retain identity without inventing a start", () => {
 for (const kind of ["result", "error"]) {
  const normalizer = new ZcodeEventNormalizer("run");
  const event = { sessionId: "session", seq: 1, type: "tool.updated", payload: { kind, toolCallId: "t", toolName: "shell", input: { command: "pwd" }, result: "ok", error: { message: "failed" } } };
  const events = normalizer.normalize(event);
  assert.equal(events.filter(e => e.type === "tool_call.create").length, 0);
  const terminal = events.find(e => e.type === "tool_call.update");
  assert.equal(terminal.payload.name, "shell");
  assert.deepEqual(terminal.payload.args, { command: "pwd" });
  assert.deepEqual(normalizer.normalize(event), []);
  assert.deepEqual(normalizer.normalize({ ...event, payload: { ...event.payload, kind: "scheduled" } }), []);
 }
});
