import test from "node:test";
import assert from "node:assert/strict";
import { assertCanonicalEvent } from "@mininglamp-oss/octo-harness-protocol";

test("tool events enforce the existing schema lifecycle at runtime", () => {
  for (const status of [undefined, "pending", "in_progress", "running", "unknown"]) {
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.update", payload: { id: "tool", status } }));
  }
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.update", payload: { id: "tool", status } }));
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.create", payload: { id: "tool", name: "read", args: {}, status } }));
  }
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.create", payload: { id: "tool", name: "read", args: {}, status: "running" } }));
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.delta", payload: { id: "tool" } }));
});
